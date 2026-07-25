import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createDirectFeedTransport,
  discoverFeed,
  discoverFeedLive,
  type FeedRequestFactory,
  type FeedTransport,
  type FeedTransportRequest,
  type FeedTransportResponse,
} from "../src/feed";

const root = join(import.meta.dir, "fixtures/feeds");
const content = (name: string) => readFileSync(join(root, name), "utf8");

function liveResponse(
  url: string,
  body: string,
  contentType: string | null = "application/rss+xml",
  status = 200,
  validators: FeedTransportResponse["validators"] = { etag: null, last_modified: null },
): FeedTransportResponse {
  return {
    url,
    status,
    content: body,
    contentType,
    contentEncoding: null,
    validators,
    conditionalApplied: false,
  };
}

interface ScriptedSocketResponse {
  status: number;
  headers?: IncomingHttpHeaders;
  chunks?: Array<string | Uint8Array>;
  hold?: boolean;
}

function scriptedRequestFactory(
  scripts: ScriptedSocketResponse[],
  captures: Array<{ protocol: string; options: RequestOptions }> = [],
): FeedRequestFactory {
  return (protocol, options, callback) => {
    captures.push({ protocol, options });
    const request = new EventEmitter() as ClientRequest;
    let destroyed = false;
    request.destroy = ((error?: Error) => {
      if (destroyed) return request;
      destroyed = true;
      if (error) queueMicrotask(() => request.emit("error", error));
      return request;
    }) as ClientRequest["destroy"];
    request.end = (() => {
      const script = scripts.shift();
      if (!script) throw new Error("unexpected direct request");
      if (script.hold) return request;
      queueMicrotask(() => {
        if (destroyed) return;
        const stream = new PassThrough();
        const response = stream as unknown as IncomingMessage;
        response.statusCode = script.status;
        response.headers = script.headers ?? {};
        callback(response);
        for (const chunk of script.chunks ?? []) stream.write(chunk);
        stream.end();
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };
}

function datedAtom(dates: string[]): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom">${dates
    .map((value, index) => `<entry><id>date-${index}</id><updated>${value}</updated></entry>`)
    .join("")}</feed>`;
}

function fakeTransport(
  routes: Record<string, FeedTransportResponse | FeedTransportResponse[]>,
  requests: FeedTransportRequest[] = [],
): FeedTransport {
  const queues = new Map(
    Object.entries(routes).map(([url, response]) => [
      url,
      Array.isArray(response) ? [...response] : [response],
    ]),
  );
  return async (request) => {
    requests.push(request);
    const response = queues.get(request.url)?.shift();
    if (!response) throw new Error("unexpected fake feed request");
    return {
      ...response,
      conditionalApplied: Boolean(
        request.conditional &&
          request.conditional.url === response.url &&
          (request.conditional.etag || request.conditional.lastModified),
      ),
    };
  };
}

describe("network-free feed discovery", () => {
  test("parses RSS identities, dates, canonical URLs, and validators", () => {
    const result = discoverFeed(
      {
        url: "https://blog.example.com/feed.xml",
        content: content("rss.xml"),
        validators: { etag: '"v12"', last_modified: "Thu, 09 Jul 2026 12:30:00 GMT" },
      },
      { sourceUrl: "https://blog.example.com/feed.xml" },
    );
    expect(result.status).toBe("success");
    expect(result.source_format).toBe("rss");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.stable_id).toBe("post-002");
    expect(result.items[1]?.identity_source).toBe("canonical_url");
    expect(result.validators.etag).toBe('"v12"');
    expect(result.absence_implies_deletion).toBeFalse();
  });
  test("parses Atom alternatives and explicit tombstones", () => {
    const result = discoverFeed(
      { url: "https://notes.example.com/atom.xml", content: content("atom.xml") },
      { sourceUrl: "https://notes.example.com/atom.xml" },
    );
    expect(result.status).toBe("success");
    expect(result.source_format).toBe("atom");
    expect(result.items.some((item) => item.tombstone)).toBeTrue();
    expect(result.items.find((item) => item.title === "Alpha note")?.candidate_urls).toHaveLength(
      2,
    );
  });
  test("parses fully namespace-prefixed Atom entries and fields", () => {
    const url = "https://notes.example.com/feed.xml";
    const xml = `<?xml version="1.0"?>
      <atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
        <atom:entry>
          <atom:id>prefixed-1</atom:id>
          <atom:title>Prefixed note</atom:title>
          <atom:link rel="canonical" href="/notes/1"/>
          <atom:published>2026-07-01T10:00:00Z</atom:published>
          <atom:updated>2026-07-02T10:00:00Z</atom:updated>
        </atom:entry>
      </atom:feed>`;
    const result = discoverFeed({ url, content: xml }, { sourceUrl: url });
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      stable_id: "prefixed-1",
      title: "Prefixed note",
      url: "https://notes.example.com/notes/1",
      published_at: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-02T10:00:00Z",
    });
  });
  test("parses Atom entries using an arbitrary declared namespace prefix", () => {
    const url = "https://notes.example.com/feed.xml";
    const xml = `<x:feed xmlns:x="http://www.w3.org/2005/Atom"><x:entry><x:id>arbitrary-1</x:id><x:title>Arbitrary prefix</x:title><x:link href="/arbitrary"/></x:entry></x:feed>`;
    const result = discoverFeed({ url, content: xml }, { sourceUrl: url });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.stable_id).toBe("arbitrary-1");
    expect(result.items[0]?.url).toBe("https://notes.example.com/arbitrary");
  });
  test("parses prefixed Atom tombstones from ref and when attributes", () => {
    const url = "https://notes.example.com/feed.xml";
    const xml = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:at="http://purl.org/atompub/tombstones/1.0"><at:deleted-entry ref="gone-1" when="2026-07-03T10:00:00Z"/></atom:feed>`;
    const result = discoverFeed({ url, content: xml }, { sourceUrl: url });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      stable_id: "gone-1",
      tombstone: true,
      updated_at: "2026-07-03T10:00:00Z",
    });
  });
  test("traverses a prefixed feed-level Atom next link", () => {
    const first = "https://paged.example.com/feeds/first.xml";
    const second = "https://paged.example.com/feeds/second.xml";
    const firstXml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:entry><a:id>first</a:id></a:entry><a:link rel="NEXT" href="second.xml"/></a:feed>`;
    const secondXml = `<b:feed xmlns:b="http://www.w3.org/2005/Atom"><b:entry><b:id>second</b:id></b:entry></b:feed>`;
    const result = discoverFeed({ url: first, content: firstXml }, { sourceUrl: first }, [
      { url: second, content: secondXml },
    ]);
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(2);
    expect(result.pagination.pages).toHaveLength(2);
    expect(result.pagination.pages[0]?.next_url).toBe(second);
  });
  test("ignores nested prefixed entry-looking Atom extension nodes", () => {
    const url = "https://notes.example.com/feed.xml";
    const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="urn:extension"><x:wrapper><a:entry><a:id>nested</a:id></a:entry></x:wrapper><a:entry><a:id>direct</a:id></a:entry></a:feed>`;
    const result = discoverFeed({ url, content: xml }, { sourceUrl: url });
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.stable_id).toBe("direct");
    expect(result.pagination.pages[0]?.item_count).toBe(1);
    expect(result.warnings.some((warning) => warning.code === "item_limit_reached")).toBeFalse();
  });
  test("counts only direct prefixed Atom entries toward maxItems", () => {
    const url = "https://notes.example.com/feed.xml";
    const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="urn:extension"><x:wrapper><a:entry><a:id>nested</a:id></a:entry></x:wrapper><a:entry><a:id>one</a:id></a:entry><a:entry><a:id>two</a:id></a:entry><a:entry><a:id>three</a:id></a:entry></a:feed>`;
    const result = discoverFeed({ url, content: xml }, { sourceUrl: url, maxItems: 2 });
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.stable_id).sort()).toEqual(["one", "two"]);
    expect(result.pagination.pages[0]?.item_count).toBe(2);
    expect(result.pagination.stop_reason).toBe("item_limit");
    expect(result.warnings.some((warning) => warning.code === "item_limit_reached")).toBeTrue();
  });
  test("traverses only supplied recorded pages", () => {
    const source = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const complete = discoverFeed(
      { url: source, content: content("feed-page-1.xml") },
      { sourceUrl: source },
      [{ url: second, content: content("feed-page-2.xml") }],
    );
    expect(complete.status).toBe("success");
    expect(complete.pagination.pages).toHaveLength(2);
    const partial = discoverFeed(
      { url: source, content: content("feed-page-1.xml") },
      { sourceUrl: source },
    );
    expect(partial.status).toBe("partial");
    expect(partial.pagination.stop_reason).toBe("missing_page");
    expect(partial.warnings[0]?.code).toBe("page_not_recorded");
  });
  test("deduplicates the same canonical URL and keeps newest metadata", () => {
    const result = discoverFeed(
      { url: "https://blog.example.com/feed.xml", content: content("rss-duplicates.xml") },
      { sourceUrl: "https://blog.example.com/feed.xml" },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Updated title");
    expect(result.items[0]?.stable_id).toBe("https://blog.example.com/posts/same");
  });
  test("configured archives traverse recorded pages and expose loop boundaries", () => {
    const first = "https://blog.example.com/archive?page=1";
    const second = "https://blog.example.com/archive?page=2";
    const result = discoverFeed(
      { url: first, content: content("archive-page-1.html"), kind: "archive" },
      {
        sourceUrl: first,
        sourceKind: "archive",
        archive: {
          entrySelector: "article.archive-entry",
          linkSelector: "a.post-link",
          dateSelector: "time",
          nextSelector: "a.next",
          idAttribute: "data-post-id",
        },
      },
      [{ url: second, content: content("archive-page-2.html") }],
    );
    expect(result.source_format).toBe("archive");
    expect(result.items.length).toBe(4);
    expect(result.status).toBe("partial");
    expect(result.pagination.stop_reason).toBe("loop");
  });
  test("since filtering retains undated items with an explicit warning", () => {
    const result = discoverFeed(
      {
        url: "https://blog.example.com/archive?page=1",
        content: content("archive-page-1.html"),
        kind: "archive",
      },
      {
        sourceUrl: "https://blog.example.com/archive?page=1",
        sourceKind: "archive",
        since: "2026-07-07T00:00:00Z",
        archive: {
          entrySelector: "article.archive-entry",
          linkSelector: "a.post-link",
          dateSelector: "time",
        },
      },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Undated archive post");
    expect(result.warnings.some((warning) => warning.code === "undated_item")).toBeTrue();
  });
  test("normalizes naive feed date forms as UTC and warns only after success", () => {
    const source = "https://dates.example.com/atom.xml";
    const dates = [
      "2026-03-08T02:30:00",
      "2026-07-09",
      "Thu, 09 Jul 2026 14:30:00",
      "July 9, 2026 at 2:30 PM",
      "Thursday, July 9, 2026 12:05 AM",
    ];
    const result = discoverFeed({ url: source, content: datedAtom(dates) }, { sourceUrl: source });

    expect(
      Object.fromEntries(result.items.map((entry) => [entry.stable_id, entry.updated_at])),
    ).toEqual({
      "date-0": "2026-03-08T02:30:00Z",
      "date-1": "2026-07-09T00:00:00Z",
      "date-2": "2026-07-09T14:30:00Z",
      "date-3": "2026-07-09T14:30:00Z",
      "date-4": "2026-07-09T00:05:00Z",
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      dates.map(() => "naive_date_assumed_utc"),
    );
  });

  test("normalizes every supported explicit timezone without naive warnings", () => {
    const source = "https://dates.example.com/atom.xml";
    const dates = [
      "2026-07-09T12:00:00Z",
      "2026-07-09T12:00:00+0530",
      "2026-07-09T12:00:00-04:30",
      "Thu, 09 Jul 2026 12:00:00 GMT",
      "09 Jul 2026 12:00:00 UTC",
      "09 Jul 2026 12:00:00 UT",
      "09 Jul 2026 12:00:00 EST",
      "09 Jul 2026 12:00:00 A",
      "09 Jul 2026 12:00:00 M",
      "09 Jul 2026 12:00:00 N",
      "09 Jul 2026 12:00:00 Y",
    ];
    const result = discoverFeed({ url: source, content: datedAtom(dates) }, { sourceUrl: source });

    expect(
      Object.fromEntries(result.items.map((entry) => [entry.stable_id, entry.updated_at])),
    ).toEqual({
      "date-0": "2026-07-09T12:00:00Z",
      "date-1": "2026-07-09T06:30:00Z",
      "date-2": "2026-07-09T16:30:00Z",
      "date-3": "2026-07-09T12:00:00Z",
      "date-4": "2026-07-09T12:00:00Z",
      "date-5": "2026-07-09T12:00:00Z",
      "date-6": "2026-07-09T17:00:00Z",
      "date-7": "2026-07-09T11:00:00Z",
      "date-8": "2026-07-09T00:00:00Z",
      "date-9": "2026-07-09T13:00:00Z",
      "date-10": "2026-07-10T00:00:00Z",
    });
    expect(
      result.warnings.some((warning) => warning.code === "naive_date_assumed_utc"),
    ).toBeFalse();
    expect(result.warnings.some((warning) => warning.code === "invalid_date")).toBeFalse();
  });

  test("rejects unsupported, invalid, and malformed entry and since dates", () => {
    const source = "https://dates.example.com/atom.xml";
    const invalidDates = [
      "09 Jul 2026 12:00:00 CET",
      "09 Jul 2026 12:00:00 XYZ",
      "09 Jul 2026 12:00:00 J",
      "09 Jul 2026 12:00:00A",
      "2026-07-09T12:00:00+2400",
      "2026-07-09T12:00:00+12:60",
      "2026-02-30T12:00:00Z",
      "July bananas, 2026",
    ];
    const result = discoverFeed(
      { url: source, content: datedAtom(invalidDates) },
      { sourceUrl: source },
    );

    expect(result.items.every((entry) => entry.updated_at === null)).toBeTrue();
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      invalidDates.map(() => "invalid_date"),
    );
    for (const since of invalidDates) {
      const invalidSince = discoverFeed(
        { url: source, content: '<feed xmlns="http://www.w3.org/2005/Atom"/>' },
        { sourceUrl: source, since },
      );
      expect(invalidSince.failure?.code, since).toBe("invalid_options");
    }
  });

  test("is byte-stable across host timezones for cutoff, dedupe, order, and cursor", () => {
    const source = "https://stable.example.com/feed.xml";
    const scenario = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>gap</id><title>Gap item</title><updated>2026-03-08T02:30:00</updated></entry>
      <entry><id>old-copy</id><title>Local-time contender</title><link href="/same"/><updated>2026-03-08T02:40:00</updated></entry>
      <entry><id>new-copy</id><title>Canonical winner</title><link href="/same"/><updated>2026-03-08T10:35:00Z</updated></entry>
      <entry><id>boundary</id><title>Boundary item</title><updated>2026-03-08T02:35:00</updated></entry>
      <entry><id>latest</id><title>Latest item</title><updated>2026-03-08T11:00:00Z</updated></entry>
    </feed>`;
    const feedModule = join(import.meta.dir, "../src/feed.ts");
    const script = `
      import { discoverFeed } from ${JSON.stringify(feedModule)};
      const result = discoverFeed(
        { url: ${JSON.stringify(source)}, content: ${JSON.stringify(scenario)} },
        { sourceUrl: ${JSON.stringify(source)}, since: "2026-03-08T02:35:00" },
      );
      const stable = {
        status: result.status,
        newest_seen_at: result.cursor.newest_seen_at,
        items: result.items.map(({ stable_id, title, published_at, updated_at }) => ({
          stable_id, title, published_at, updated_at,
        })),
        warning_codes: result.warnings.map(({ code }) => code),
      };
      process.stdout.write(JSON.stringify(stable));
    `;
    const outputs = ["UTC", "America/Los_Angeles"].map((timezone) => {
      const child = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      });
      expect(child.status, child.stderr).toBe(0);
      return child.stdout;
    });

    expect(outputs[1]).toBe(outputs[0]);
    expect(JSON.parse(outputs[0]!)).toEqual({
      status: "partial",
      newest_seen_at: "2026-03-08T11:00:00Z",
      items: [
        {
          stable_id: "latest",
          title: "Latest item",
          published_at: null,
          updated_at: "2026-03-08T11:00:00Z",
        },
        {
          stable_id: "https://stable.example.com/same",
          title: "Canonical winner",
          published_at: null,
          updated_at: "2026-03-08T10:35:00Z",
        },
        {
          stable_id: "boundary",
          title: "Boundary item",
          published_at: null,
          updated_at: "2026-03-08T02:35:00Z",
        },
      ],
      warning_codes: ["naive_date_assumed_utc", "naive_date_assumed_utc", "naive_date_assumed_utc"],
    });
  });

  test("malformed XML returns a bounded failure rather than throwing", () => {
    const result = discoverFeed(
      { url: "https://blog.example.com/feed.xml", content: content("invalid.xml") },
      { sourceUrl: "https://blog.example.com/feed.xml" },
    );
    expect(result.status).toBe("failure");
    expect(result.failure?.code).toBe("malformed_xml");
    expect(result.items).toEqual([]);
  });
  test("rejects unsafe source and credential-bearing entry URLs", () => {
    const unsafe = discoverFeed(
      { url: "http://127.0.0.1/feed", content: content("rss.xml") },
      { sourceUrl: "http://127.0.0.1/feed" },
    );
    expect(unsafe.failure?.code).toBe("unsafe_source_url");
    const xml =
      '<rss><channel><item><guid isPermaLink="false">x</guid><link>https://blog.example.com/x?token=secret</link></item></channel></rss>';
    const safe = discoverFeed(
      { url: "https://blog.example.com/feed", content: xml },
      { sourceUrl: "https://blog.example.com/feed" },
    );
    expect(safe.status).toBe("partial");
    expect(safe.items[0]?.url).toBeNull();
    expect(safe.warnings.some((warning) => warning.code === "unsafe_url_omitted")).toBeTrue();
  });
  test("runtime API rejects non-finite, fractional, out-of-range, and malformed options", () => {
    const source = "https://blog.example.com/feed.xml";
    const initial = { url: source, content: content("rss.xml") };
    const invalidOptions: Array<Record<string, unknown>> = [
      { maxResponseBytes: Number.NaN },
      { maxResponseBytes: Number.POSITIVE_INFINITY },
      { maxResponseBytes: 1.5 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: 20_000_001 },
      { maxPages: 1.5 },
      { maxPages: 0 },
      { maxPages: 101 },
      { maxItems: 1.5 },
      { maxItems: 0 },
      { maxItems: 10_001 },
      { timeoutSeconds: Number.NaN },
      { timeoutSeconds: Number.POSITIVE_INFINITY },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 0.0009 },
      { timeoutSeconds: 301 },
      { sourceKind: "other" },
      { since: "" },
      { since: "not a date" },
      { since: "x".repeat(101) },
      { sourceKind: "archive" },
      { archive: { entrySelector: "" } },
      { archive: { entrySelector: "a", dateAttribute: "x".repeat(101) } },
      { archive: { entrySelector: "a", unknown: "value" } },
      { unknown: true },
    ];
    for (const overrides of invalidOptions) {
      const result = discoverFeed(initial, { sourceUrl: source, ...overrides } as any);
      expect(result.failure?.code, JSON.stringify(overrides)).toBe("invalid_options");
      expect(result.pagination.stop_reason).toBe("failed");
    }
    expect(
      discoverFeed({ ...initial, kind: "other" } as any, { sourceUrl: source }).failure?.code,
    ).toBe("invalid_options");
    expect(
      discoverFeed(initial, { sourceUrl: source }, [
        { url: source, content: "", kind: "other" } as any,
      ]).failure?.code,
    ).toBe("invalid_options");
  });

  test("response, item, cancellation, and option bounds are explicit", () => {
    const source = "https://blog.example.com/feed.xml";
    expect(
      discoverFeed(
        { url: source, content: content("rss.xml") },
        { sourceUrl: source, maxResponseBytes: 10 },
      ).failure?.code,
    ).toBe("response_limit_exceeded");
    const limited = discoverFeed(
      { url: source, content: content("rss.xml") },
      { sourceUrl: source, maxItems: 1 },
    );
    expect(limited.status).toBe("partial");
    expect(limited.pagination.stop_reason).toBe("item_limit");
    const controller = new AbortController();
    controller.abort();
    expect(
      discoverFeed(
        { url: source, content: content("rss.xml") },
        { sourceUrl: source, signal: controller.signal },
      ).failure?.code,
    ).toBe("cancelled");
  });
});

describe("direct feed socket boundary", () => {
  const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];

  test("pins the public address while retaining Host, SNI, TLS verification, and limits", async () => {
    const captures: Array<{ protocol: string; options: RequestOptions }> = [];
    const transport = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory(
        [
          {
            status: 200,
            headers: { "content-type": "application/atom+xml" },
            chunks: [content("atom.xml")],
          },
        ],
        captures,
      ),
    });
    const source = "https://feeds.example.com:8443/atom.xml?q=1";
    const response = await transport({
      url: source,
      maxResponseBytes: 2_000_000,
      timeoutMilliseconds: 1_000,
      conditional: { url: source, etag: '"v1"', lastModified: null },
    });

    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      protocol: "https:",
      options: {
        hostname: "8.8.8.8",
        family: 4,
        servername: "feeds.example.com",
        path: "/atom.xml?q=1",
        agent: false,
        maxHeaderSize: 16_384,
      },
    });
    const headers = captures[0]?.options.headers as Record<string, string>;
    expect(headers.host).toBe("feeds.example.com:8443");
    expect(headers["if-none-match"]).toBe('"v1"');
    expect(captures[0]?.options.rejectUnauthorized).not.toBe(false);
  });

  test("follows safe redirects without forwarding resource-bound validators", async () => {
    const captures: Array<{ protocol: string; options: RequestOptions }> = [];
    const source = "https://feeds.example.com/feed.xml";
    const transport = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory(
        [
          {
            status: 302,
            headers: { location: "https://cdn.example.com/feed.xml" },
          },
          { status: 200, chunks: [content("atom.xml")] },
        ],
        captures,
      ),
    });
    const response = await transport({
      url: source,
      maxResponseBytes: 2_000_000,
      timeoutMilliseconds: 1_000,
      conditional: {
        url: "https://cdn.example.com/feed.xml",
        etag: '"v1"',
        lastModified: null,
      },
    });

    expect(response.url).toBe("https://cdn.example.com/feed.xml");
    expect(captures).toHaveLength(2);
    const first = captures[0];
    const second = captures[1];
    if (!first || !second) throw new Error("expected two direct requests");
    expect((first.options.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
    expect((second.options.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');
  });

  test("applies an effective-resource validator only after a safe redirect", async () => {
    const source = "https://feeds.example.com/feed.xml";
    const effective = "https://cdn.example.com/feed.xml";
    const captures: Array<{ protocol: string; options: RequestOptions }> = [];
    const transport = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory(
        [
          { status: 302, headers: { location: effective } },
          { status: 304, headers: { etag: '"v1"' } },
        ],
        captures,
      ),
    });
    const result = await discoverFeedLive(
      {
        sourceUrl: source,
        sourceKind: "feed",
        validatorUrl: effective,
        etag: '"v1"',
      },
      { transport },
    );

    expect(result).toMatchObject({
      status: "success",
      pagination: { stop_reason: "not_modified" },
      validators: { etag: '"v1"' },
    });
    expect(captures).toHaveLength(2);
    const first = captures[0];
    const second = captures[1];
    if (!first || !second) throw new Error("expected redirect request pair");
    expect((first.options.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
    expect((second.options.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');
  });

  test("rejects HTTPS redirect downgrade before opening the target socket", async () => {
    const scripts = [
      {
        status: 302,
        headers: { location: "http://feeds.example.com/plain.xml" },
      },
    ];
    const transport = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory(scripts),
    });
    await expect(
      transport({
        url: "https://feeds.example.com/feed.xml",
        maxResponseBytes: 1_000,
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "unsafe_destination", retryable: false });
    expect(scripts).toHaveLength(0);
  });

  test("enforces streamed bytes, fatal UTF-8, and abort cleanup", async () => {
    const overflow = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory([{ status: 200, chunks: ["1234", "5678"] }]),
    });
    await expect(
      overflow({
        url: "https://feeds.example.com/feed.xml",
        maxResponseBytes: 7,
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "response_limit_exceeded" });

    const invalidUtf8 = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory([
        { status: 200, chunks: [new Uint8Array([0xc3, 0x28])] },
      ]),
    });
    await expect(
      invalidUtf8({
        url: "https://feeds.example.com/feed.xml",
        maxResponseBytes: 10,
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_utf8" });

    const controller = new AbortController();
    const held = createDirectFeedTransport({
      resolver,
      requestFactory: scriptedRequestFactory([{ status: 200, hold: true }]),
    });
    const pending = held({
      url: "https://feeds.example.com/feed.xml",
      maxResponseBytes: 10,
      timeoutMilliseconds: 1_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("deterministic live feed discovery", () => {
  test("fetches a direct RSS source and records the redirect-effective page URL", async () => {
    const source = "https://blog.example.com/feed.xml";
    const effective = "https://cdn.example.com/feed.xml";
    const requests: FeedTransportRequest[] = [];
    const result = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed" },
      {
        transport: fakeTransport(
          { [source]: liveResponse(effective, content("rss.xml")) },
          requests,
        ),
      },
    );

    expect(result.status).toBe("success");
    expect(result.source_url).toBe(source);
    expect(result.source_format).toBe("rss");
    expect(result.pagination.pages[0]?.url).toBe(effective);
    expect(result.items).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  test("autodiscovers only an explicit typed alternate link and keeps validators off the homepage", async () => {
    const homepage = "https://blog.example.com/";
    const feed = "https://blog.example.com/atom.xml";
    const requests: FeedTransportRequest[] = [];
    const html = `<!doctype html><html><head><link rel="stylesheet alternate" type="application/atom+xml" href="/atom.xml"></head><body><a href="/other.xml">RSS</a></body></html>`;
    const result = await discoverFeedLive(
      {
        sourceUrl: homepage,
        validatorUrl: feed,
        etag: '"feed-v2"',
        lastModified: "Wed, 08 Jul 2026 00:00:00 GMT",
      },
      {
        transport: fakeTransport(
          {
            [homepage]: liveResponse(homepage, html, "text/html; charset=utf-8"),
            [feed]: liveResponse(feed, content("atom.xml"), "application/atom+xml"),
          },
          requests,
        ),
      },
    );

    expect(result.status).toBe("success");
    expect(result.source_url).toBe(homepage);
    expect(result.pagination.pages[0]?.url).toBe(feed);
    const boundConditional = {
      url: feed,
      etag: '"feed-v2"',
      lastModified: "Wed, 08 Jul 2026 00:00:00 GMT",
    };
    expect(requests.map((request) => request.conditional)).toEqual([
      boundConditional,
      boundConditional,
    ]);
  });

  test("does not send validators when a homepage changes its feed target", async () => {
    const homepage = "https://blog.example.com/";
    const oldFeed = "https://blog.example.com/old.xml";
    const newFeed = "https://blog.example.com/new.xml";
    const requests: FeedTransportRequest[] = [];
    const html = `<html><head><link rel="alternate" type="application/rss+xml" href="${newFeed}"></head></html>`;
    const result = await discoverFeedLive(
      { sourceUrl: homepage, validatorUrl: oldFeed, etag: '"old"' },
      {
        transport: fakeTransport(
          {
            [homepage]: liveResponse(homepage, html, "text/html"),
            [newFeed]: liveResponse(newFeed, content("rss.xml")),
          },
          requests,
        ),
      },
    );

    expect(result.status).toBe("success");
    expect(requests.map((request) => request.conditional)).toEqual([
      { url: oldFeed, etag: '"old"', lastModified: null },
      undefined,
    ]);
  });

  test("rejects HTTPS downgrade in alternate and pagination traversal", async () => {
    const homepage = "https://blog.example.com/";
    const html =
      '<html><head><link rel="alternate" type="application/rss+xml" href="http://blog.example.com/feed.xml"></head></html>';
    const alternate = await discoverFeedLive(
      { sourceUrl: homepage },
      {
        transport: fakeTransport({
          [homepage]: liveResponse(homepage, html, "text/html"),
        }),
      },
    );
    expect(alternate.failure?.code).toBe("unsafe_destination");

    const first = "https://paged.example.com/feed.xml";
    const downgradeXml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><link rel="next" href="http://paged.example.com/page-2.xml"/></feed>`;
    const pagination = await discoverFeedLive(
      { sourceUrl: first, sourceKind: "feed" },
      {
        transport: fakeTransport({
          [first]: liveResponse(first, downgradeXml, "application/atom+xml"),
        }),
      },
    );
    expect(pagination).toMatchObject({
      status: "partial",
      failure: { code: "unsafe_destination", retryable: false },
    });
  });

  test("preserves configured archive parsing in auto mode", async () => {
    const first = "https://blog.example.com/archive?page=1";
    const second = "https://blog.example.com/archive?page=2";
    const result = await discoverFeedLive(
      {
        sourceUrl: first,
        sourceKind: "auto",
        archive: {
          entrySelector: "article.archive-entry",
          linkSelector: "a.post-link",
          dateSelector: "time",
          nextSelector: "a.next",
          idAttribute: "data-post-id",
        },
      },
      {
        transport: fakeTransport({
          [first]: liveResponse(first, content("archive-page-1.html"), "text/html"),
          [second]: liveResponse(second, content("archive-page-2.html"), "text/html"),
        }),
      },
    );

    expect(result.source_format).toBe("archive");
    expect(result.items).toHaveLength(4);
    expect(result.pagination.stop_reason).toBe("loop");
  });

  test("does not fall back to generic HTML links", async () => {
    const homepage = "https://blog.example.com/";
    const html = '<html><body><a href="/feed.xml">Subscribe via RSS</a></body></html>';
    const result = await discoverFeedLive(
      { sourceUrl: homepage },
      { transport: fakeTransport({ [homepage]: liveResponse(homepage, html, "text/html") }) },
    );

    expect(result.status).toBe("failure");
    expect(result.failure?.code).toBe("feed_not_discovered");
  });

  test("sends conditional validators and treats 304 as a complete empty window", async () => {
    const source = "https://blog.example.com/feed.xml";
    const requests: FeedTransportRequest[] = [];
    const result = await discoverFeedLive(
      {
        sourceUrl: source,
        sourceKind: "feed",
        etag: '"feed-v3"',
        lastModified: "Thu, 09 Jul 2026 12:30:00 GMT",
      },
      {
        transport: fakeTransport({ [source]: liveResponse(source, "", null, 304) }, requests),
      },
    );

    expect(requests[0]?.conditional).toEqual({
      url: source,
      etag: '"feed-v3"',
      lastModified: "Thu, 09 Jul 2026 12:30:00 GMT",
    });
    expect(result.status).toBe("success");
    expect(result.items).toEqual([]);
    expect(result.pagination).toMatchObject({ complete: true, stop_reason: "not_modified" });
    expect(result.validators).toEqual({
      etag: '"feed-v3"',
      last_modified: "Thu, 09 Jul 2026 12:30:00 GMT",
    });
  });

  test("auto mode applies validators only to an explicitly bound resource", async () => {
    const source = "https://blog.example.com/feed.xml";
    const requests: FeedTransportRequest[] = [];
    const result = await discoverFeedLive(
      { sourceUrl: source, validatorUrl: source, etag: '"auto-v1"' },
      {
        transport: fakeTransport({ [source]: liveResponse(source, "", null, 304) }, requests),
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.conditional).toEqual({
      url: source,
      etag: '"auto-v1"',
      lastModified: null,
    });
    expect(result.pagination.stop_reason).toBe("not_modified");
  });

  test("follows parser-discovered pagination through the injected transport", async () => {
    const first = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const requests: FeedTransportRequest[] = [];
    const result = await discoverFeedLive(
      { sourceUrl: first, sourceKind: "feed" },
      {
        transport: fakeTransport(
          {
            [first]: liveResponse(first, content("feed-page-1.xml")),
            [second]: liveResponse(second, content("feed-page-2.xml")),
          },
          requests,
        ),
      },
    );

    expect(result.status).toBe("success");
    expect(result.pagination.complete).toBeTrue();
    expect(result.pagination.pages.map((page) => page.url)).toEqual([first, second]);
    expect(requests.map((request) => request.url)).toEqual([first, second]);
  });

  test("returns partial evidence when a live pagination request fails", async () => {
    const first = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const result = await discoverFeedLive(
      { sourceUrl: first, sourceKind: "feed" },
      {
        transport: fakeTransport({
          [first]: liveResponse(first, content("feed-page-1.xml")),
          [second]: liveResponse(second, "", null, 503),
        }),
      },
    );

    expect(result.status).toBe("partial");
    expect(result.pagination).toMatchObject({
      complete: false,
      stop_reason: "http_error",
      next_url: second,
    });
    expect(result.pagination.pages).toHaveLength(1);
    expect(result.failure).toMatchObject({ code: "http_error", retryable: true });
    expect(result.warnings.some((warning) => warning.code === "page_not_recorded")).toBeFalse();
  });

  test("rejects credential- and secret-bearing source URLs before transport", async () => {
    let calls = 0;
    const transport: FeedTransport = async () => {
      calls += 1;
      throw new Error("transport must not run");
    };
    for (const source of [
      "https://user:password@blog.example.com/feed.xml",
      "https://blog.example.com/feed.xml?api_key=secret",
      "https://blog.example.com/token/sk-proj-abcdefghijklmnop",
    ]) {
      const result = await discoverFeedLive({ sourceUrl: source }, { transport });
      expect(result.failure?.code).toBe("unsafe_source_url");
      expect(result.source_url).toBe("");
    }
    const privateLiteral = "http://127.0.0.1/feed.xml";
    const privateResult = await discoverFeedLive({ sourceUrl: privateLiteral }, { transport });
    expect(privateResult).toMatchObject({
      source_url: privateLiteral,
      failure: { code: "unsafe_source_url", retryable: false },
    });
    expect(calls).toBe(0);
  });

  test("rejects private IPv4 and IPv6 DNS answers before opening a connection", async () => {
    const source = "https://feeds.example.com/rss.xml";
    for (const resolved of [
      { address: "127.0.0.1", family: 4 as const },
      { address: "fd00::1", family: 6 as const },
    ]) {
      const transport = createDirectFeedTransport({ resolver: async () => [resolved] });
      const result = await discoverFeedLive(
        { sourceUrl: source, sourceKind: "feed" },
        { transport },
      );

      expect(result.status).toBe("failure");
      expect(result.failure).toMatchObject({ code: "unsafe_destination", retryable: false });
      expect(result.pagination.stop_reason).toBe("policy");
    }
  });

  test("allows tolerated feed MIME only through parser validation and rejects encoding", async () => {
    const source = "https://blog.example.com/feed.xml";
    const tolerated = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed" },
      {
        transport: fakeTransport({
          [source]: liveResponse(source, content("rss.xml"), "text/plain"),
        }),
      },
    );
    expect(tolerated.status).toBe("success");

    const missingType = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed" },
      {
        transport: fakeTransport({
          [source]: liveResponse(source, content("rss.xml"), null),
        }),
      },
    );
    expect(missingType.status).toBe("success");

    const mislabeledFeed = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed" },
      {
        transport: fakeTransport({
          [source]: liveResponse(source, content("rss.xml"), "text/html"),
        }),
      },
    );
    expect(mislabeledFeed.status).toBe("success");

    const disguisedHtml = await discoverFeedLive(
      { sourceUrl: source },
      {
        transport: fakeTransport({
          [source]: liveResponse(
            source,
            '<html><link rel="alternate" type="application/rss+xml" href="/other.xml"></html>',
            "application/octet-stream",
          ),
        }),
      },
    );
    expect(disguisedHtml.status).toBe("failure");
    expect(disguisedHtml.failure?.code).not.toBe("feed_not_discovered");

    const encodedResponse = liveResponse(source, content("rss.xml"));
    encodedResponse.contentEncoding = "gzip";
    const encoded = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed" },
      { transport: fakeTransport({ [source]: encodedResponse }) },
    );
    expect(encoded.failure?.code).toBe("unsupported_encoding");
  });

  test("enforces the response byte cap at an injected transport boundary", async () => {
    const source = "https://blog.example.com/feed.xml";
    const result = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed", maxResponseBytes: 10 },
      {
        transport: fakeTransport({
          [source]: liveResponse(source, "x".repeat(11), "application/rss+xml"),
        }),
      },
    );

    expect(result.failure?.code).toBe("response_limit_exceeded");
    expect(result.pagination.stop_reason).toBe("response_limit");
  });

  test("classifies authentication, retryable, and permanent HTTP failures", async () => {
    const source = "https://blog.example.com/feed.xml";
    const cases: Array<[number, string, boolean]> = [
      [401, "authentication_required", false],
      [403, "authentication_required", false],
      [408, "http_error", true],
      [429, "http_error", true],
      [500, "http_error", true],
      [404, "http_error", false],
    ];
    for (const [status, code, retryable] of cases) {
      const result = await discoverFeedLive(
        { sourceUrl: source, sourceKind: "feed" },
        { transport: fakeTransport({ [source]: liveResponse(source, "", null, status) }) },
      );
      expect(result.failure, String(status)).toMatchObject({ code, retryable });
    }
  });

  test("caps live traversal independently from recorded parser limits", async () => {
    let calls = 0;
    const result = await discoverFeedLive(
      {
        sourceUrl: "https://blog.example.com/feed.xml",
        sourceKind: "feed",
        maxPages: 11,
      },
      {
        transport: async () => {
          calls += 1;
          throw new Error("transport must not run");
        },
      },
    );
    expect(result.failure?.code).toBe("invalid_options");
    expect(calls).toBe(0);
  });

  test("returns structured timeout and cancellation failures", async () => {
    const source = "https://blog.example.com/feed.xml";
    const never: FeedTransport = () => new Promise(() => undefined);
    const timedOut = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed", timeoutSeconds: 0.005 },
      { transport: never },
    );
    expect(timedOut.failure).toMatchObject({ code: "timeout", retryable: true });

    const controller = new AbortController();
    const cancelledTransport: FeedTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
          once: true,
        });
      });
    setTimeout(() => controller.abort(), 1);
    const cancelled = await discoverFeedLive(
      { sourceUrl: source, sourceKind: "feed", signal: controller.signal },
      { transport: cancelledTransport },
    );
    expect(cancelled.failure).toMatchObject({ code: "cancelled", retryable: false });
  });

  test("accepts cached boundary termination with applied conditionals for pagination", async () => {
    const first = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const binding = { url: second, etag: '"page2-v1"', lastModified: null };
    const requests: FeedTransportRequest[] = [];
    const applications: boolean[] = [];
    const transport: FeedTransport = async (request) => {
      requests.push(request);
      const applied = Boolean(
        request.conditional?.url === request.url &&
          (request.conditional.etag || request.conditional.lastModified),
      );
      applications.push(applied);
      if (request.url === first)
        return { ...liveResponse(first, content("feed-page-1.xml")), conditionalApplied: applied };
      if (request.url === second)
        return {
          ...liveResponse(second, "", null, 304, {
            etag: '"page2-v1"',
            last_modified: null,
          }),
          conditionalApplied: applied,
        };
      throw new Error("unexpected feed request");
    };

    const result = await discoverFeedLive(
      {
        sourceUrl: first,
        sourceKind: "feed",
        validatorUrl: second,
        etag: '"page2-v1"',
      },
      { transport },
    );

    expect(requests.map((request) => request.conditional)).toEqual([binding, binding]);
    expect(applications).toEqual([false, true]);
    expect(result).toMatchObject({
      status: "success",
      validators: { etag: '"page2-v1"', last_modified: null },
      cursor: {
        validators: { etag: '"page2-v1"', last_modified: null },
        next_url: null,
      },
      pagination: { complete: true, stop_reason: "not_modified", next_url: null },
      failure: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.pagination.pages.map((page) => page.url)).toEqual([first]);
    expect(result.pagination.pages.some((page) => page.url === second)).toBeFalse();
    expect(
      result.warnings.some(
        (warning) => warning.code === "page_not_recorded" && warning.page_url === second,
      ),
    ).toBeFalse();
  });

  test("accepts cached boundary termination for a distinct archive start", async () => {
    const homepage = "https://blog.example.com/recent";
    const archiveStart = "https://blog.example.com/archive?page=1";
    const binding = { url: archiveStart, etag: '"archive-v1"', lastModified: null };
    const requests: FeedTransportRequest[] = [];
    const transport: FeedTransport = async (request) => {
      requests.push(request);
      if (request.url === homepage)
        return liveResponse(
          homepage,
          "<html><article class='entry'><a class='link' href='/post1'>Post 1</a></article></html>",
          "text/html",
        );
      if (request.url === archiveStart)
        return {
          ...liveResponse(archiveStart, "", null, 304, {
            etag: '"archive-v1"',
            last_modified: null,
          }),
          conditionalApplied: request.conditional?.url === archiveStart,
        };
      throw new Error("unexpected feed request");
    };

    const result = await discoverFeedLive(
      {
        sourceUrl: homepage,
        sourceKind: "archive",
        validatorUrl: archiveStart,
        etag: '"archive-v1"',
        archive: {
          entrySelector: "article.entry",
          linkSelector: "a.link",
          startUrl: archiveStart,
        },
      },
      { transport },
    );

    expect(requests.map((request) => request.conditional)).toEqual([undefined, binding]);
    expect(result).toMatchObject({
      status: "success",
      items: [{ url: "https://blog.example.com/post1" }],
      validators: { etag: '"archive-v1"', last_modified: null },
      pagination: { complete: true, stop_reason: "not_modified", next_url: null },
      failure: null,
    });
  });

  test("rejects invalid traversal 304 responses", async () => {
    const first = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const binding = { url: second, etag: '"test"', lastModified: null };
    const cases = [
      { name: "bare", validators: false, responseUrl: second, conditionalApplied: false },
      { name: "unapplied", validators: true, responseUrl: second, conditionalApplied: false },
      {
        name: "wrong response URL",
        validators: true,
        responseUrl: "https://paged.example.com/feed?page=3",
        conditionalApplied: true,
      },
    ];

    for (const testCase of cases) {
      const requests: FeedTransportRequest[] = [];
      const result = await discoverFeedLive(
        {
          sourceUrl: first,
          sourceKind: "feed",
          ...(testCase.validators ? { validatorUrl: second, etag: '"test"' } : {}),
        },
        {
          transport: async (request) => {
            requests.push(request);
            if (request.url === first) return liveResponse(first, content("feed-page-1.xml"));
            return {
              ...liveResponse(testCase.responseUrl, "", null, 304, {
                etag: '"test"',
                last_modified: null,
              }),
              conditionalApplied: testCase.conditionalApplied,
            };
          },
        },
      );

      expect(requests[1]?.conditional, testCase.name).toEqual(
        testCase.validators ? binding : undefined,
      );
      expect(result, testCase.name).toMatchObject({
        status: "partial",
        items: [{ stable_id: "page-one-item" }],
        cursor: { next_url: second },
        pagination: {
          pages: [{ url: first }],
          complete: false,
          stop_reason: "http_error",
          next_url: second,
        },
        failure: { code: "http_error", retryable: false },
      });
    }
  });

  test("does not apply a nonmatching conditional to a later target", async () => {
    const first = "https://paged.example.com/feed?page=1";
    const second = "https://paged.example.com/feed?page=2";
    const other = "https://other.example.com/feed.xml";
    const requests: FeedTransportRequest[] = [];
    const result = await discoverFeedLive(
      {
        sourceUrl: first,
        sourceKind: "feed",
        validatorUrl: other,
        etag: '"other-feed"',
      },
      {
        transport: fakeTransport(
          {
            [first]: liveResponse(first, content("feed-page-1.xml")),
            [second]: liveResponse(second, content("feed-page-2.xml")),
          },
          requests,
        ),
      },
    );

    expect(result.status).toBe("success");
    expect(result.pagination.pages.map((page) => page.url)).toEqual([first, second]);
    expect(requests[0]?.conditional).toEqual({
      url: other,
      etag: '"other-feed"',
      lastModified: null,
    });
    expect(requests[1]?.conditional).toBeUndefined();
  });

  test("keeps earlier warning evidence at a cached boundary", async () => {
    const first = "https://warning.example.com/feed?page=1";
    const second = "https://warning.example.com/feed?page=2";
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><link rel="next" href="${second}"/><entry><id>warned</id><updated>not-a-date</updated></entry></feed>`;
    const result = await discoverFeedLive(
      {
        sourceUrl: first,
        sourceKind: "feed",
        validatorUrl: second,
        etag: '"warning-v1"',
      },
      {
        transport: fakeTransport({
          [first]: liveResponse(first, xml, "application/atom+xml"),
          [second]: liveResponse(second, "", null, 304),
        }),
      },
    );

    expect(result.status).toBe("partial");
    expect(result.pagination).toMatchObject({
      complete: false,
      stop_reason: "not_modified",
      next_url: null,
    });
    expect(result.failure).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(["invalid_date"]);
  });
});

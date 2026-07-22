import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverFeed } from "../src/feed";

const root = join(import.meta.dir, "fixtures/feeds");
const content = (name: string) => readFileSync(join(root, name), "utf8");

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

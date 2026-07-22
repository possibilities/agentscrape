import { createHash } from "node:crypto";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import { XMLValidator } from "fast-xml-parser";
import { containsJwt, isSensitiveName } from "./redaction";
import type { FeedDiscoveryItem, FeedDiscoveryResult, FeedPageValidators } from "./schemas";

export interface RecordedFeedPage {
  url: string;
  content: string;
  kind?: "auto" | "feed" | "archive" | undefined;
  validators?: Partial<FeedPageValidators> | undefined;
}
export interface ArchiveOptions {
  startUrl?: string | null | undefined;
  entrySelector: string;
  linkSelector?: string | undefined;
  dateSelector?: string | null | undefined;
  dateAttribute?: string | null | undefined;
  updatedSelector?: string | null | undefined;
  nextSelector?: string | null | undefined;
  idAttribute?: string | null | undefined;
  titleSelector?: string | null | undefined;
  tombstoneSelector?: string | null | undefined;
}
export interface FeedOptions {
  sourceUrl: string;
  sourceKind?: "auto" | "feed" | "archive" | undefined;
  since?: string | null | undefined;
  maxResponseBytes?: number | undefined;
  maxPages?: number | undefined;
  maxItems?: number | undefined;
  timeoutSeconds?: number | undefined;
  archive?: ArchiveOptions | null | undefined;
  signal?: AbortSignal | undefined;
}
interface Warning {
  code: string;
  message: string;
  page_url?: string;
}
interface ParsedPage {
  format: "rss" | "atom" | "archive";
  items: FeedDiscoveryItem[];
  next: string | null;
  partial: boolean;
  inspected: number;
  truncated: boolean;
}
class FeedFault extends Error {
  constructor(
    public code: string,
    message: string,
    public stop = "malformed_page",
    public retryable = false,
  ) {
    super(message);
  }
}
function clean(value: string | undefined | null, max = 500): string {
  return [...(value ?? "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function sensitiveUrl(url: URL): boolean {
  if (containsJwt(url.href)) return true;
  return [...url.searchParams].some(([name]) => isSensitiveName(name));
}
function safeUrl(value: string, base?: string): string | null {
  if (
    !value ||
    value.length > 8192 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return null;
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const address = host.replace(/^\[|\]$/g, "");
    const ipVersion = isIP(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !host ||
      host === "localhost" ||
      /\.(?:localhost|local|internal|lan|home)$/.test(host) ||
      (!host.includes(".") && ipVersion === 0)
    )
      return null;
    if (
      ipVersion > 0 &&
      /^(?:0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::0?$|::1$|f[cd]|fe[89ab])/i.test(
        address,
      )
    )
      return null;
    url.hostname = host;
    url.hash = "";
    return sensitiveUrl(url) ? null : url.href;
  } catch {
    return null;
  }
}
function sourceUrl(value: string): string | null {
  const safe = safeUrl(value);
  if (safe) return safe;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return safeUrl(url.href);
  } catch {
    return null;
  }
}
function date(value: string, warnings: Warning[], page: string): string | null {
  const raw = clean(value, 200);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    warnings.push({
      code: "invalid_date",
      message: "An entry date could not be parsed and was omitted.",
      page_url: page,
    });
    return null;
  }
  if (!/(?:Z|[+-]\d\d:?\d\d|\b(?:GMT|UTC)\b)$/i.test(raw))
    warnings.push({
      code: "naive_date_assumed_utc",
      message: "A timezone-free entry date was interpreted as UTC.",
      page_url: page,
    });
  return new Date(timestamp).toISOString().replace(".000Z", "Z");
}
function canonicalCandidates(values: string[], page: string, warnings: Warning[]): string[] {
  const result: string[] = [];
  for (const value of values.slice(0, 17)) {
    const url = safeUrl(value, page);
    if (!url) {
      warnings.push({
        code: "unsafe_url_omitted",
        message: "An unsafe or credential-bearing entry URL was omitted.",
        page_url: page,
      });
      continue;
    }
    if (!result.includes(url)) result.push(url);
  }
  return result.slice(0, 16);
}
function item(
  input: {
    id: string;
    urls: string[];
    title: string;
    published: string;
    updated: string;
    tombstone: boolean;
  },
  page: string,
  warnings: Warning[],
): FeedDiscoveryItem | null {
  const candidates = canonicalCandidates(input.urls, page, warnings);
  const id = clean(input.id, 4096);
  let stable = "";
  let upstream: string | null = null;
  let identity: FeedDiscoveryItem["identity_source"] = "canonical_url";
  if (id) {
    if (id.length <= 512 && !containsJwt(id)) {
      stable = id;
      upstream = id;
      identity = "upstream_id";
    } else {
      stable = `sha256:${createHash("sha256").update(id).digest("hex")}`;
      identity = "hashed_upstream_id";
    }
  } else if (candidates[0]) stable = candidates[0];
  if (!stable) {
    warnings.push({
      code: "entry_without_identity",
      message: "An entry without an upstream ID or safe URL was omitted.",
      page_url: page,
    });
    return null;
  }
  return {
    stable_id: stable,
    upstream_id: upstream,
    identity_source: identity,
    url: candidates[0] ?? null,
    candidate_urls: candidates,
    title: clean(input.title),
    published_at: date(input.published, warnings, page),
    updated_at: date(input.updated, warnings, page),
    tombstone: input.tombstone,
  };
}
function validateXml(content: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content))
    throw new FeedFault(
      "unsupported_source",
      "XML document type and entity declarations are not supported.",
    );
  const validated = XMLValidator.validate(content, { allowBooleanAttributes: true });
  if (validated !== true) throw new FeedFault("malformed_xml", "The feed XML is malformed.");
}
function text(_$: cheerio.CheerioAPI, root: cheerio.Cheerio<any>, names: string[]): string {
  for (const name of names) {
    const found = root
      .children()
      .filter(
        (_i, node) =>
          node.type === "tag" && (node.name ?? "").split(":").pop()?.toLowerCase() === name,
      )
      .first();
    if (found.length) return found.text();
  }
  return "";
}
function parseFeed(content: string, page: string, budget: number, warnings: Warning[]): ParsedPage {
  const warningCount = warnings.length;
  validateXml(content);
  const $ = cheerio.load(content, { xmlMode: true });
  const root = $.root().children().first();
  const rootName = (root.get(0)?.name ?? "").split(":").pop()?.toLowerCase();
  if (!rootName || !["rss", "rdf", "feed"].includes(rootName))
    throw new FeedFault(
      "unsupported_source",
      "The recorded response is not a supported RSS or Atom feed.",
    );
  const format = rootName === "feed" ? ("atom" as const) : ("rss" as const);
  const nodes = $(
    format === "atom" ? "entry, deleted-entry, at\\:deleted-entry" : "item, deleted-entry",
  ).toArray();
  const items: FeedDiscoveryItem[] = [];
  for (const node of nodes.slice(0, budget)) {
    const element = $(node);
    const tombstone = (node.name ?? "").includes("deleted-entry");
    const urls: string[] = [];
    element
      .children()
      .filter((_i, child) => (child.name ?? "").split(":").pop() === "link")
      .each((_i, link) => {
        const rel = ($(link).attr("rel") ?? "alternate").toLowerCase();
        if (["", "alternate", "canonical"].includes(rel))
          urls.push($(link).attr("href") ?? $(link).text());
      });
    if (format === "rss" && !tombstone) {
      const guid = element.children("guid").first();
      if (guid.length && (guid.attr("isPermaLink") ?? "true").toLowerCase() !== "false")
        urls.push(guid.text());
    }
    const built = item(
      {
        id: tombstone
          ? (element.attr("ref") ?? text($, element, ["id", "guid"]))
          : text($, element, ["id", "guid"]),
        urls,
        title: text($, element, ["title"]),
        published: tombstone ? "" : text($, element, ["published", "pubdate", "issued", "date"]),
        updated: tombstone
          ? (element.attr("when") ?? text($, element, ["updated", "modified"]))
          : text($, element, ["updated", "modified"]),
        tombstone,
      },
      page,
      warnings,
    );
    if (built) items.push(built);
  }
  const container = format === "rss" ? $("channel").first() : root;
  const nextElement = container
    .children()
    .filter(
      (_i, node) =>
        (node.name ?? "").split(":").pop() === "link" &&
        ($(node).attr("rel") ?? "").toLowerCase() === "next",
    )
    .first();
  let next: string | null = null;
  let partial = false;
  if (nextElement.length) {
    next = safeUrl(nextElement.attr("href") ?? nextElement.text(), page);
    if (!next) {
      partial = true;
      warnings.push({
        code: "unsafe_url_omitted",
        message: "An unsafe pagination URL was omitted.",
        page_url: page,
      });
    }
  }
  return {
    format,
    items,
    next,
    partial: partial || warnings.length > warningCount,
    inspected: Math.min(nodes.length, budget),
    truncated: nodes.length > budget,
  };
}
function parseArchive(
  content: string,
  page: string,
  budget: number,
  options: ArchiveOptions,
  warnings: Warning[],
): ParsedPage {
  const warningCount = warnings.length;
  const $ = cheerio.load(content);
  let entries: cheerio.Cheerio<any>;
  try {
    entries = $(options.entrySelector);
  } catch {
    throw new FeedFault("malformed_archive", "The archive entry selector is invalid.");
  }
  if (!entries.length)
    warnings.push({
      code: "no_archive_entries",
      message: "The configured archive selector matched no entries.",
      page_url: page,
    });
  const items: FeedDiscoveryItem[] = [];
  entries.slice(0, budget).each((_index, element) => {
    const root = $(element);
    const links = root.find(options.linkSelector ?? "a[href]").slice(0, 17);
    const urls = links.map((_i, link) => $(link).attr("href") ?? "").get();
    const dateElement = options.dateSelector ? root.find(options.dateSelector).first() : null;
    const updatedElement = options.updatedSelector
      ? root.find(options.updatedSelector).first()
      : null;
    const readDate = (value: cheerio.Cheerio<any> | null) =>
      value?.length
        ? options.dateAttribute
          ? (value.attr(options.dateAttribute) ?? "")
          : (value.attr("datetime") ?? value.text())
        : "";
    const built = item(
      {
        id: options.idAttribute ? (root.attr(options.idAttribute) ?? "") : "",
        urls,
        title: options.titleSelector
          ? root.find(options.titleSelector).first().text()
          : links.first().text(),
        published: readDate(dateElement),
        updated: readDate(updatedElement),
        tombstone: options.tombstoneSelector
          ? root.is(options.tombstoneSelector) || root.find(options.tombstoneSelector).length > 0
          : false,
      },
      page,
      warnings,
    );
    if (built) items.push(built);
  });
  let next: string | null = null;
  let partial = !entries.length;
  if (options.nextSelector) {
    const raw = $(options.nextSelector).first().attr("href");
    if (raw) {
      next = safeUrl(raw, page);
      if (!next) partial = true;
    }
  }
  return {
    format: "archive",
    items,
    next,
    partial: partial || warnings.length > warningCount,
    inspected: Math.min(entries.length, budget),
    truncated: entries.length > budget,
  };
}
function validators(
  value: Partial<FeedPageValidators> | undefined,
  warnings: Warning[],
  page: string,
): FeedPageValidators {
  const safe = (item: string | null | undefined) =>
    item &&
    item.length <= 512 &&
    ![...item].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
      ? item
      : null;
  const result = { etag: safe(value?.etag), last_modified: safe(value?.last_modified) };
  if ((value?.etag && !result.etag) || (value?.last_modified && !result.last_modified))
    warnings.push({
      code: "validator_omitted",
      message: "A validator was not safe to emit.",
      page_url: page,
    });
  return result;
}
function boundedWarnings(warnings: Warning[]): Warning[] {
  if (warnings.length <= 100) return warnings;
  return [
    ...warnings.slice(0, 100),
    { code: "warnings_truncated", message: "Additional discovery warnings were omitted." },
  ];
}
function failure(
  source: string,
  code: string,
  message: string,
  retryable = false,
  stop = "failed",
  warnings: Warning[] = [],
): FeedDiscoveryResult {
  return {
    schema_version: "1",
    status: "failure",
    source_url: source,
    source_format: "unknown",
    validators: { etag: null, last_modified: null },
    cursor: {
      validators: { etag: null, last_modified: null },
      newest_seen_at: null,
      next_url: null,
    },
    items: [],
    pagination: { pages: [], complete: false, stop_reason: stop, next_url: null },
    warnings: boundedWarnings(warnings),
    absence_implies_deletion: false,
    failure: { code, retryable, message: clean(message, 200) },
  };
}
function itemTime(value: FeedDiscoveryItem): number {
  return Date.parse(value.updated_at ?? value.published_at ?? "") || -8640000000000000;
}
function dedupe(items: FeedDiscoveryItem[]): FeedDiscoveryItem[] {
  const byId = new Map<string, FeedDiscoveryItem>();
  for (const value of items) {
    const previous = byId.get(value.stable_id);
    byId.set(
      value.stable_id,
      !previous || itemTime(value) >= itemTime(previous) ? value : previous,
    );
  }
  const byUrl = new Map<string, FeedDiscoveryItem>();
  const without: FeedDiscoveryItem[] = [];
  for (const value of byId.values()) {
    if (!value.url) {
      without.push(value);
      continue;
    }
    const previous = byUrl.get(value.url);
    const preferred = !previous || itemTime(value) >= itemTime(previous) ? value : previous;
    byUrl.set(
      value.url,
      previous
        ? {
            ...preferred,
            stable_id: value.url,
            identity_source: "canonical_url",
            candidate_urls: [...new Set([...previous.candidate_urls, ...value.candidate_urls])]
              .sort()
              .slice(0, 16),
            tombstone: previous.tombstone || value.tombstone,
          }
        : value,
    );
  }
  return [...byUrl.values(), ...without];
}

const PAGE_KINDS = new Set(["auto", "feed", "archive"]);
const OPTION_FIELDS = new Set([
  "sourceUrl",
  "sourceKind",
  "since",
  "maxResponseBytes",
  "maxPages",
  "maxItems",
  "timeoutSeconds",
  "archive",
  "signal",
]);
const ARCHIVE_FIELDS = new Set([
  "startUrl",
  "entrySelector",
  "linkSelector",
  "dateSelector",
  "dateAttribute",
  "updatedSelector",
  "nextSelector",
  "idAttribute",
  "titleSelector",
  "tombstoneSelector",
]);
function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}
function optionalString(value: unknown, max: number, min = 0): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length >= min && value.length <= max)
  );
}
function validValidators(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    recordValue(value) &&
    onlyFields(value, new Set(["etag", "last_modified"])) &&
    optionalString(value.etag, 512) &&
    optionalString(value.last_modified, 512)
  );
}
function validPage(value: unknown): value is RecordedFeedPage {
  if (!recordValue(value) || !onlyFields(value, new Set(["url", "content", "kind", "validators"])))
    return false;
  return (
    typeof value.url === "string" &&
    value.url.length >= 1 &&
    value.url.length <= 4096 &&
    typeof value.content === "string" &&
    (value.kind === undefined || (typeof value.kind === "string" && PAGE_KINDS.has(value.kind))) &&
    validValidators(value.validators)
  );
}
function validArchive(value: unknown): value is ArchiveOptions {
  if (!recordValue(value) || !onlyFields(value, ARCHIVE_FIELDS)) return false;
  return (
    optionalString(value.startUrl, 4096) &&
    optionalString(value.entrySelector, 500, 1) &&
    typeof value.entrySelector === "string" &&
    optionalString(value.linkSelector, 500, 1) &&
    optionalString(value.dateSelector, 500) &&
    optionalString(value.dateAttribute, 100) &&
    optionalString(value.updatedSelector, 500) &&
    optionalString(value.nextSelector, 500) &&
    optionalString(value.idAttribute, 100) &&
    optionalString(value.titleSelector, 500) &&
    optionalString(value.tombstoneSelector, 500)
  );
}
function validInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function discoverFeed(
  initial: RecordedFeedPage,
  options: FeedOptions,
  recorded: RecordedFeedPage[] = [],
): FeedDiscoveryResult {
  const rawOptions: unknown = options;
  const rawSource =
    recordValue(rawOptions) && typeof rawOptions.sourceUrl === "string" ? rawOptions.sourceUrl : "";
  const source = sourceUrl(rawSource) ?? "";
  if (
    !recordValue(rawOptions) ||
    !onlyFields(rawOptions, OPTION_FIELDS) ||
    rawSource.length < 1 ||
    rawSource.length > 4096
  )
    return failure(source, "invalid_options", "Discovery options are invalid.");
  if (!source)
    return failure("", "unsafe_source_url", "The source URL is not a safe public HTTP URL.");
  const maxBytes = options.maxResponseBytes ?? 2_000_000;
  const maxPages = options.maxPages ?? 10;
  const maxItems = options.maxItems ?? 1000;
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  const sourceKind = options.sourceKind ?? "auto";
  const archive = options.archive ?? undefined;
  if (
    !validInteger(maxBytes, 1, 20_000_000) ||
    !validInteger(maxPages, 1, 100) ||
    !validInteger(maxItems, 1, 10_000) ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0.001 ||
    timeoutSeconds > 300 ||
    !PAGE_KINDS.has(sourceKind) ||
    (options.since !== undefined &&
      options.since !== null &&
      (typeof options.since !== "string" ||
        options.since.length > 100 ||
        !Number.isFinite(Date.parse(options.since)))) ||
    (archive !== undefined && !validArchive(archive)) ||
    (sourceKind === "archive" && !archive) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
    !validPage(initial) ||
    !Array.isArray(recorded) ||
    recorded.slice(0, maxPages).some((page) => !validPage(page))
  )
    return failure(source, "invalid_options", "Discovery options are invalid.");
  const firstUrl = sourceUrl(initial.url);
  if (!firstUrl)
    return failure(
      source,
      "unsafe_source_url",
      "The first recorded page URL is not safe to traverse.",
    );
  const warnings: Warning[] = [];
  const initialValidators = validators(initial.validators, warnings, firstUrl);
  const map = new Map(
    recorded.slice(0, maxPages).flatMap((page) => {
      const url = sourceUrl(page.url);
      return url ? [[url, page] as const] : [];
    }),
  );
  const queue: Array<[string, RecordedFeedPage | undefined, "auto" | "feed" | "archive"]> = [
    [firstUrl, initial, sourceKind],
  ];
  if (options.archive?.startUrl) {
    const url = safeUrl(options.archive.startUrl, source);
    if (!url)
      return failure(source, "invalid_options", "The configured archive start URL is unsafe.");
    if (url !== firstUrl || options.sourceKind !== "archive")
      queue.push([url, map.get(url), "archive"]);
  }
  const seen = new Set<string>();
  const pages: FeedDiscoveryResult["pagination"]["pages"] = [];
  const found: FeedDiscoveryItem[] = [];
  const formats = new Set<string>();
  let partial = false;
  let boundary: string | null = null;
  let stop = "exhausted";
  let discoveredFailure: FeedDiscoveryResult["failure"] = null;
  let inspected = 0;
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (queue.length) {
    const [url, supplied, kind] = queue.shift()!;
    if (seen.has(url)) {
      warnings.push({
        code: "pagination_loop",
        message: "Pagination repeated an already visited page.",
        page_url: url,
      });
      partial = true;
      stop = "loop";
      boundary = url;
      continue;
    }
    if (pages.length >= maxPages) {
      warnings.push({
        code: "page_limit_reached",
        message: "Discovery stopped at the configured page limit.",
        page_url: url,
      });
      partial = true;
      stop = "page_limit";
      boundary = url;
      break;
    }
    if (options.signal?.aborted) {
      discoveredFailure = {
        code: "cancelled",
        retryable: false,
        message: "Discovery was cancelled before parsing completed.",
      };
      partial = pages.length > 0;
      stop = "cancelled";
      boundary = url;
      break;
    }
    if (performance.now() >= deadline) {
      discoveredFailure = {
        code: "timeout",
        retryable: true,
        message: "Discovery exceeded the configured parsing timeout.",
      };
      partial = pages.length > 0;
      stop = "timeout";
      boundary = url;
      break;
    }
    const page = supplied ?? map.get(url);
    if (!page) {
      warnings.push({
        code: "page_not_recorded",
        message: "A discovered pagination page was not supplied to this run.",
        page_url: url,
      });
      partial = true;
      stop = "missing_page";
      boundary = url;
      continue;
    }
    if (new TextEncoder().encode(page.content).byteLength > maxBytes) {
      if (!pages.length)
        return failure(
          source,
          "response_limit_exceeded",
          "A recorded response exceeds the configured byte limit.",
          false,
          "response_limit",
          warnings,
        );
      discoveredFailure = {
        code: "response_limit_exceeded",
        retryable: false,
        message: "A recorded response exceeds the configured byte limit.",
      };
      partial = true;
      stop = "response_limit";
      boundary = url;
      continue;
    }
    seen.add(url);
    let parsed: ParsedPage;
    try {
      const resolved = kind === "auto" ? (page.kind ?? "auto") : kind;
      const archive =
        resolved === "archive" ||
        (resolved === "auto" &&
          options.archive &&
          /^\s*(?:<!doctype html|<html)/i.test(page.content));
      parsed = archive
        ? parseArchive(
            page.content,
            url,
            Math.max(0, maxItems - inspected),
            options.archive!,
            warnings,
          )
        : parseFeed(page.content, url, Math.max(0, maxItems - inspected), warnings);
    } catch (error) {
      const fault =
        error instanceof FeedFault
          ? error
          : new FeedFault(
              "internal_error",
              "Feed discovery failed inside the parser boundary.",
              "failed",
            );
      if (!pages.length)
        return failure(source, fault.code, fault.message, fault.retryable, fault.stop, warnings);
      discoveredFailure = { code: fault.code, retryable: fault.retryable, message: fault.message };
      partial = true;
      stop = fault.stop;
      boundary = url;
      continue;
    }
    formats.add(parsed.format);
    inspected += parsed.inspected;
    found.push(...parsed.items);
    partial ||= parsed.partial;
    pages.push({
      url,
      page_format: parsed.format,
      validators: validators(page.validators, warnings, url),
      item_count: parsed.items.length,
      next_url: parsed.next,
    });
    if (parsed.truncated || (inspected >= maxItems && parsed.next)) {
      warnings.push({
        code: "item_limit_reached",
        message: "Discovery stopped at the configured item limit.",
        page_url: url,
      });
      partial = true;
      stop = "item_limit";
      boundary = parsed.next;
      break;
    }
    if (parsed.next)
      queue.push([
        parsed.next,
        map.get(parsed.next),
        parsed.format === "archive" ? "archive" : "feed",
      ]);
    if (options.signal?.aborted) {
      discoveredFailure = {
        code: "cancelled",
        retryable: false,
        message: "Discovery was cancelled before parsing completed.",
      };
      partial = true;
      stop = "cancelled";
      boundary = queue[0]?.[0] ?? parsed.next;
      break;
    }
    if (performance.now() >= deadline) {
      discoveredFailure = {
        code: "timeout",
        retryable: true,
        message: "Discovery exceeded the configured parsing timeout.",
      };
      partial = true;
      stop = "timeout";
      boundary = queue[0]?.[0] ?? parsed.next;
      break;
    }
  }
  let items = dedupe(found);
  const dated = items.filter((value) => itemTime(value) > -8640000000000000);
  const newest = dated.sort((a, b) => itemTime(b) - itemTime(a))[0];
  const newestSeen = newest?.updated_at ?? newest?.published_at ?? null;
  if (options.since) {
    const cutoff = Date.parse(options.since);
    if (!Number.isFinite(cutoff))
      return failure(
        source,
        "invalid_options",
        "The since value must be an ISO-8601 or RFC-822 date.",
      );
    items = items.filter((value) => {
      const time = itemTime(value);
      if (time === -8640000000000000) {
        warnings.push({
          code: "undated_item",
          message: "An undated item was retained because the date cutoff was inconclusive.",
        });
        partial = true;
        return true;
      }
      return time >= cutoff;
    });
  }
  items.sort((a, b) => itemTime(b) - itemTime(a) || a.stable_id.localeCompare(b.stable_id));
  const status =
    !pages.length && discoveredFailure
      ? "failure"
      : partial || discoveredFailure
        ? "partial"
        : "success";
  const format = formats.size === 0 ? "unknown" : formats.size > 1 ? "mixed" : [...formats][0]!;
  return {
    schema_version: "1",
    status,
    source_url: source,
    source_format: format as FeedDiscoveryResult["source_format"],
    validators: initialValidators,
    cursor: { validators: initialValidators, newest_seen_at: newestSeen, next_url: boundary },
    items,
    pagination: {
      pages,
      complete: status === "success" && queue.length === 0,
      stop_reason: stop,
      next_url: boundary,
    },
    warnings: boundedWarnings(warnings),
    absence_implies_deletion: false,
    failure: discoveredFailure,
  };
}

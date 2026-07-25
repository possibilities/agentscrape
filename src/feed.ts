import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { XMLValidator } from "fast-xml-parser";
import {
  createDirectFeedTransport,
  type FeedTransport,
  FeedTransportFault,
  type FeedTransportRequest,
  type FeedTransportResponse,
} from "./feed-transport";
import { safeEnvelopeUrl, safeTransportUrl, safeUrl, sourceUrl } from "./feed-url";
import { containsJwt } from "./redaction";
import type { FeedDiscoveryItem, FeedDiscoveryResult, FeedPageValidators } from "./schemas";

export type {
  DirectFeedTransportDependencies,
  FeedRequestFactory,
  FeedResolvedAddress,
  FeedResolver,
  FeedTransport,
  FeedTransportRequest,
  FeedTransportResponse,
} from "./feed-transport";
export { createDirectFeedTransport, FeedTransportFault } from "./feed-transport";

export interface RecordedFeedPage {
  url: string;
  content: string;
  kind?: "auto" | "feed" | "archive" | undefined;
  validators?: Partial<FeedPageValidators> | undefined;
  /** Effective response URL after redirects. Live discovery uses this as the parse base and evidence URL. */
  effectiveUrl?: string | undefined;
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
  if (
    !recordValue(value) ||
    !onlyFields(value, new Set(["url", "content", "kind", "validators", "effectiveUrl"]))
  )
    return false;
  return (
    typeof value.url === "string" &&
    value.url.length >= 1 &&
    value.url.length <= 4096 &&
    typeof value.content === "string" &&
    optionalString(value.effectiveUrl, 4096, 1) &&
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

interface CheckedFeedOptions {
  source: string;
  maxBytes: number;
  maxPages: number;
  maxItems: number;
  timeoutSeconds: number;
  sourceKind: "auto" | "feed" | "archive";
  archive: ArchiveOptions | undefined;
}
type FeedOptionsCheck =
  | { ok: true; value: CheckedFeedOptions }
  | { ok: false; result: FeedDiscoveryResult };

function checkFeedOptions(options: FeedOptions): FeedOptionsCheck {
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
    return {
      ok: false,
      result: failure(source, "invalid_options", "Discovery options are invalid."),
    };
  if (!source)
    return {
      ok: false,
      result: failure("", "unsafe_source_url", "The source URL is not a safe public HTTP URL."),
    };
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
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    return {
      ok: false,
      result: failure(source, "invalid_options", "Discovery options are invalid."),
    };
  return {
    ok: true,
    value: {
      source,
      maxBytes,
      maxPages,
      maxItems,
      timeoutSeconds,
      sourceKind: sourceKind as CheckedFeedOptions["sourceKind"],
      archive,
    },
  };
}

export function discoverFeed(
  initial: RecordedFeedPage,
  options: FeedOptions,
  recorded: RecordedFeedPage[] = [],
): FeedDiscoveryResult {
  const checked = checkFeedOptions(options);
  if (!checked.ok) return checked.result;
  const { source, maxBytes, maxPages, maxItems, timeoutSeconds, sourceKind } = checked.value;
  if (
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
  const firstEffectiveUrl = sourceUrl(initial.effectiveUrl ?? initial.url);
  if (!firstEffectiveUrl)
    return failure(
      source,
      "unsafe_source_url",
      "The first recorded page effective URL is not safe to traverse.",
    );
  const warnings: Warning[] = [];
  const initialValidators = validators(initial.validators, warnings, firstEffectiveUrl);
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
  const seenEffective = new Set<string>();
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
    const pageUrl = sourceUrl(page.effectiveUrl ?? page.url);
    if (!pageUrl) {
      const message = "A recorded response effective URL is not safe to traverse.";
      if (!pages.length)
        return failure(source, "unsafe_source_url", message, false, "policy", warnings);
      discoveredFailure = { code: "unsafe_destination", retryable: false, message };
      partial = true;
      stop = "policy";
      boundary = url;
      continue;
    }
    if (seenEffective.has(pageUrl)) {
      warnings.push({
        code: "pagination_loop",
        message: "Pagination reached an already visited effective page.",
        page_url: pageUrl,
      });
      partial = true;
      stop = "loop";
      boundary = pageUrl;
      continue;
    }
    seen.add(url);
    seenEffective.add(pageUrl);
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
            pageUrl,
            Math.max(0, maxItems - inspected),
            options.archive!,
            warnings,
          )
        : parseFeed(page.content, pageUrl, Math.max(0, maxItems - inspected), warnings);
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
      boundary = pageUrl;
      continue;
    }
    formats.add(parsed.format);
    inspected += parsed.inspected;
    found.push(...parsed.items);
    partial ||= parsed.partial;
    pages.push({
      url: pageUrl,
      page_format: parsed.format,
      validators: validators(page.validators, warnings, pageUrl),
      item_count: parsed.items.length,
      next_url: parsed.next,
    });
    if (parsed.truncated || (inspected >= maxItems && parsed.next)) {
      warnings.push({
        code: "item_limit_reached",
        message: "Discovery stopped at the configured item limit.",
        page_url: pageUrl,
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

export interface LiveFeedOptions extends FeedOptions {
  etag?: string | null | undefined;
  lastModified?: string | null | undefined;
  /** Exact response URL whose validators may be sent. */
  validatorUrl?: string | null | undefined;
}
export interface LiveFeedDependencies {
  transport?: FeedTransport | undefined;
}

const LIVE_MAX_PAGES = 10;
const LIVE_TOTAL_RESPONSE_BYTES = 20_000_000;
const LIVE_OPTION_FIELDS = new Set([...OPTION_FIELDS, "etag", "lastModified", "validatorUrl"]);
const FEED_MEDIA_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/rdf+xml",
  "application/xml",
  "text/xml",
]);
const TOLERATED_FEED_MEDIA_TYPES = new Set(["text/plain", "application/octet-stream"]);
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const DISCOVERY_LINK_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
]);

type ResponseMedia = "feed" | "tolerated" | "html" | "unsupported";

function conditionalValue(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code > 255;
    })
  )
    return undefined;
  return value;
}

function parserOptions(
  options: LiveFeedOptions,
  sourceKind = options.sourceKind,
  timeoutSeconds = options.timeoutSeconds,
): FeedOptions {
  return {
    sourceUrl: options.sourceUrl,
    sourceKind,
    since: options.since,
    maxResponseBytes: options.maxResponseBytes,
    maxPages: options.maxPages,
    maxItems: options.maxItems,
    timeoutSeconds,
    archive: options.archive,
    signal: options.signal,
  };
}

function mediaType(value: string | null): ResponseMedia {
  if (!value) return "tolerated";
  if (value.length > 200) return "unsupported";
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (FEED_MEDIA_TYPES.has(normalized)) return "feed";
  if (TOLERATED_FEED_MEDIA_TYPES.has(normalized)) return "tolerated";
  if (HTML_MEDIA_TYPES.has(normalized)) return "html";
  return "unsupported";
}

function safeTraversalUrl(value: string, base: string): string | null {
  const resolved = safeTransportUrl(value, base);
  if (!resolved) return null;
  return new URL(base).protocol === "https:" && new URL(resolved).protocol !== "https:"
    ? null
    : resolved;
}

function discoverAlternateFeed(content: string, base: string): string {
  const $ = cheerio.load(content);
  let matched = false;
  for (const element of $("link[rel][type]").slice(0, 256).toArray()) {
    const link = $(element);
    const rel = (link.attr("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const type = (link.attr("type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!rel.includes("alternate") || !DISCOVERY_LINK_TYPES.has(type)) continue;
    matched = true;
    const resolved = safeTraversalUrl(link.attr("href") ?? "", base);
    if (resolved) return resolved;
  }
  if (matched)
    throw new FeedTransportFault(
      "unsafe_destination",
      "The discovered feed link is unsafe.",
      false,
      "policy",
    );
  throw new FeedTransportFault(
    "feed_not_discovered",
    "The HTML source declares no supported alternate RSS or Atom feed.",
    false,
    "feed_discovery",
  );
}

function httpFault(status: number): FeedTransportFault {
  if (status === 401 || status === 403)
    return new FeedTransportFault(
      "authentication_required",
      `The feed source requires authentication (HTTP ${status}).`,
      false,
      "authentication",
    );
  const retryable = status === 408 || status === 429 || status >= 500;
  return new FeedTransportFault(
    "http_error",
    `The feed source returned HTTP ${status}.`,
    retryable,
    "http_error",
  );
}

function transportFailure(error: unknown, signal?: AbortSignal): FeedTransportFault {
  if (signal?.aborted)
    return new FeedTransportFault("cancelled", "Feed discovery was cancelled.", false, "cancelled");
  if (error instanceof FeedTransportFault) return error;
  return new FeedTransportFault(
    "network_error",
    "The feed request failed at the network boundary.",
    true,
    "network_error",
  );
}

function validTransportResponse(raw: unknown, maxBytes: number): FeedTransportResponse {
  if (!recordValue(raw))
    throw new FeedTransportFault(
      "malformed_response",
      "The feed transport returned a malformed response.",
      false,
      "malformed_response",
    );
  const status = raw.status;
  const content = raw.content;
  const contentType = raw.contentType;
  const contentEncoding = raw.contentEncoding;
  const rawValidators = raw.validators;
  const effective = typeof raw.url === "string" ? safeTransportUrl(raw.url) : null;
  if (
    !effective ||
    !Number.isSafeInteger(status) ||
    (status as number) < 100 ||
    (status as number) > 599 ||
    typeof content !== "string" ||
    (contentType !== null && typeof contentType !== "string") ||
    (contentEncoding !== null && typeof contentEncoding !== "string") ||
    typeof raw.conditionalApplied !== "boolean" ||
    !recordValue(rawValidators) ||
    !onlyFields(rawValidators, new Set(["etag", "last_modified"])) ||
    !optionalString(rawValidators.etag, 512) ||
    !optionalString(rawValidators.last_modified, 512)
  )
    throw new FeedTransportFault(
      "malformed_response",
      "The feed transport returned a malformed response.",
      false,
      "malformed_response",
    );
  if ((status as number) >= 200 && (status as number) < 300) {
    if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity")
      throw new FeedTransportFault(
        "unsupported_encoding",
        "Encoded feed responses are not accepted.",
        false,
        "unsupported_encoding",
      );
    if (new TextEncoder().encode(content).byteLength > maxBytes)
      throw new FeedTransportFault(
        "response_limit_exceeded",
        "A feed response exceeds the configured byte limit.",
        false,
        "response_limit",
      );
  }
  return {
    url: effective,
    status: status as number,
    content,
    contentType: contentType as string | null,
    contentEncoding: contentEncoding as string | null,
    validators: {
      etag: (rawValidators.etag as string | null | undefined) ?? null,
      last_modified: (rawValidators.last_modified as string | null | undefined) ?? null,
    },
    conditionalApplied: raw.conditionalApplied as boolean,
  };
}

async function boundedFetch(
  transport: FeedTransport,
  input: Omit<FeedTransportRequest, "timeoutMilliseconds" | "signal">,
  deadline: number,
  signal?: AbortSignal,
): Promise<FeedTransportResponse> {
  if (signal?.aborted) throw transportFailure(null, signal);
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw new FeedTransportFault(
      "timeout",
      "Feed discovery exceeded its overall timeout.",
      true,
      "timeout",
    );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);
  timer.unref();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        signal?.aborted
          ? transportFailure(null, signal)
          : new FeedTransportFault(
              "timeout",
              "Feed discovery exceeded its overall timeout.",
              true,
              "timeout",
            ),
      );
    combined.addEventListener("abort", abort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() =>
      transport({
        ...input,
        timeoutMilliseconds: Math.max(1, remaining),
        signal: combined,
      }),
    );
    const response = await Promise.race([pending, aborted]);
    return validTransportResponse(response, input.maxResponseBytes);
  } catch (error) {
    if (signal?.aborted) throw transportFailure(error, signal);
    if (timedOut)
      throw new FeedTransportFault(
        "timeout",
        "Feed discovery exceeded its overall timeout.",
        true,
        "timeout",
      );
    throw transportFailure(error, signal);
  } finally {
    clearTimeout(timer);
    if (abort) combined.removeEventListener("abort", abort);
  }
}

function requireSuccessfulResponse(response: FeedTransportResponse): void {
  if (response.status < 200 || response.status >= 300) throw httpFault(response.status);
}

function requireResponseMedia(
  response: FeedTransportResponse,
  expected: "feed" | "archive" | "auto",
): ResponseMedia {
  const looksFeed = /^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed|(?:[A-Za-z][\w.-]*:)?rdf)\b/i.test(
    response.content,
  );
  const looksHtml = /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(response.content);
  const declared = mediaType(response.contentType);
  const media = looksFeed ? "feed" : looksHtml ? "html" : declared;
  if (
    media === "unsupported" ||
    (expected === "feed" && media === "html") ||
    (expected === "archive" && media !== "html")
  )
    throw new FeedTransportFault(
      "unsupported_media_type",
      "The feed source returned an unsupported media type.",
      false,
      "unsupported_source",
    );
  return media;
}

function preservedValidators(
  response: FeedTransportResponse,
  conditional: NonNullable<FeedTransportRequest["conditional"]>,
  warnings: Warning[],
): FeedPageValidators {
  return validators(
    {
      etag: response.validators.etag ?? conditional.etag,
      last_modified: response.validators.last_modified ?? conditional.lastModified,
    },
    warnings,
    response.url,
  );
}

function notModified(
  source: string,
  response: FeedTransportResponse,
  conditional: NonNullable<FeedTransportRequest["conditional"]>,
): FeedDiscoveryResult {
  if (!response.conditionalApplied || response.url !== conditional.url) {
    throw new FeedTransportFault(
      "malformed_response",
      "A 304 response did not match the exact conditional resource.",
      false,
      "malformed_response",
    );
  }
  const warnings: Warning[] = [];
  const retained = preservedValidators(response, conditional, warnings);
  return {
    schema_version: "1",
    status: "success",
    source_url: source,
    source_format: "unknown",
    validators: retained,
    cursor: { validators: retained, newest_seen_at: null, next_url: null },
    items: [],
    pagination: {
      pages: [],
      complete: true,
      stop_reason: "not_modified",
      next_url: null,
    },
    warnings: boundedWarnings(warnings),
    absence_implies_deletion: false,
    failure: null,
  };
}

function sanitizedLiveResult(result: FeedDiscoveryResult): FeedDiscoveryResult {
  const candidates = [
    result.pagination.next_url,
    ...result.pagination.pages.map((page) => page.next_url),
  ].filter((value): value is string => Boolean(value));
  const unsafe = new Set(candidates.filter((value) => !safeTransportUrl(value)));
  if (!unsafe.size) return result;
  const warnings = result.warnings.filter(
    (warning) => !warning.page_url || !unsafe.has(warning.page_url),
  );
  warnings.push({
    code: "unsafe_url_omitted",
    message: "An unsafe or secret-bearing discovery boundary was omitted.",
  });
  return {
    ...result,
    cursor: {
      ...result.cursor,
      next_url:
        result.cursor.next_url && unsafe.has(result.cursor.next_url)
          ? null
          : result.cursor.next_url,
    },
    pagination: {
      ...result.pagination,
      pages: result.pagination.pages.map((page) => ({
        ...page,
        next_url: page.next_url && unsafe.has(page.next_url) ? null : page.next_url,
      })),
      next_url:
        result.pagination.next_url && unsafe.has(result.pagination.next_url)
          ? null
          : result.pagination.next_url,
    },
    warnings: boundedWarnings(warnings),
  };
}

function withLiveFailure(
  source: string,
  result: FeedDiscoveryResult | null,
  fault: FeedTransportFault,
  boundary: string | null,
): FeedDiscoveryResult {
  if (!result || result.pagination.pages.length === 0)
    return failure(source, fault.code, fault.message, fault.retryable, fault.stopReason);
  const missingBoundary = result.pagination.next_url;
  const warnings = result.warnings.filter(
    (warning) =>
      !(
        warning.code === "page_not_recorded" &&
        (warning.page_url === boundary || warning.page_url === missingBoundary)
      ),
  );
  return sanitizedLiveResult({
    ...result,
    status: "partial",
    cursor: { ...result.cursor, next_url: boundary },
    pagination: {
      ...result.pagination,
      complete: false,
      stop_reason: fault.stopReason,
      next_url: boundary,
    },
    warnings: boundedWarnings(warnings),
    failure: { code: fault.code, retryable: fault.retryable, message: clean(fault.message, 200) },
  });
}

function recordedPage(
  requestedUrl: string,
  response: FeedTransportResponse,
  kind: "feed" | "archive",
): RecordedFeedPage {
  return {
    url: requestedUrl,
    effectiveUrl: response.url,
    content: response.content,
    kind,
    validators: response.validators,
  };
}

function hasConditional(
  value: FeedTransportRequest["conditional"],
): value is NonNullable<FeedTransportRequest["conditional"]> {
  return Boolean(value && (value.etag || value.lastModified));
}

export async function discoverFeedLive(
  options: LiveFeedOptions,
  dependencies: LiveFeedDependencies = {},
): Promise<FeedDiscoveryResult> {
  const rawOptions: unknown = options;
  const rawSource =
    recordValue(rawOptions) && typeof rawOptions.sourceUrl === "string" ? rawOptions.sourceUrl : "";
  const envelopeSource = safeEnvelopeUrl(rawSource) ?? "";
  const source = safeTransportUrl(rawSource) ?? "";
  if (!recordValue(rawOptions) || !onlyFields(rawOptions, LIVE_OPTION_FIELDS))
    return failure(envelopeSource, "invalid_options", "Discovery options are invalid.");
  if (!source)
    return failure(
      envelopeSource,
      "unsafe_source_url",
      "The source URL is credential-bearing, secret-bearing, or otherwise unsafe.",
      false,
      "policy",
    );
  if (
    !recordValue(dependencies) ||
    !onlyFields(dependencies, new Set(["transport"])) ||
    (dependencies.transport !== undefined && typeof dependencies.transport !== "function")
  )
    return failure(source, "invalid_options", "Live discovery dependencies are invalid.");
  const baseOptions = parserOptions(options);
  const checked = checkFeedOptions(baseOptions);
  if (!checked.ok) return checked.result;
  if (
    options.archive?.startUrl &&
    !safeTraversalUrl(options.archive.startUrl, checked.value.source)
  )
    return failure(
      checked.value.source,
      "invalid_options",
      "The configured archive start URL is unsafe.",
      false,
      "policy",
    );
  const etag = conditionalValue(options.etag);
  const lastModified = conditionalValue(options.lastModified);
  if (
    (options.etag !== undefined && options.etag !== null && etag === undefined) ||
    (options.lastModified !== undefined &&
      options.lastModified !== null &&
      lastModified === undefined)
  )
    return failure(checked.value.source, "invalid_options", "Feed validators are invalid.");
  const hasValidators = Boolean(etag || lastModified);
  const validatorUrl =
    options.validatorUrl === undefined || options.validatorUrl === null
      ? checked.value.sourceKind === "feed"
        ? checked.value.source
        : null
      : safeTransportUrl(options.validatorUrl);
  if (
    (options.validatorUrl !== undefined &&
      options.validatorUrl !== null &&
      validatorUrl === null) ||
    (hasValidators && validatorUrl === null)
  ) {
    return failure(
      checked.value.source,
      "invalid_options",
      "Conditional validators require an exact safe validator URL.",
    );
  }
  const conditional: NonNullable<FeedTransportRequest["conditional"]> = {
    url: validatorUrl ?? checked.value.source,
    etag: etag ?? null,
    lastModified: lastModified ?? null,
  };
  if (checked.value.maxPages > LIVE_MAX_PAGES) {
    return failure(
      checked.value.source,
      "invalid_options",
      `Live discovery supports at most ${LIVE_MAX_PAGES} pages per run.`,
    );
  }
  const transport =
    (dependencies.transport as FeedTransport | undefined) ?? createDirectFeedTransport();
  const deadline = performance.now() + checked.value.timeoutSeconds * 1000;
  let fetchedBytes = 0;
  const fetchPage = async (
    url: string,
    requestConditional: FeedTransportRequest["conditional"],
    acceptHtml: boolean,
  ) => {
    const remainingBytes = LIVE_TOTAL_RESPONSE_BYTES - fetchedBytes;
    if (remainingBytes <= 0) {
      throw new FeedTransportFault(
        "response_limit_exceeded",
        "Live feed discovery exceeded its total response byte limit.",
        false,
        "response_limit",
      );
    }
    const response = await boundedFetch(
      transport,
      {
        url,
        maxResponseBytes: Math.min(checked.value.maxBytes, remainingBytes),
        acceptHtml,
        conditional: requestConditional,
      },
      deadline,
      options.signal,
    );
    fetchedBytes += new TextEncoder().encode(response.content).byteLength;
    return response;
  };

  const archiveStart = options.archive?.startUrl
    ? safeTraversalUrl(options.archive.startUrl, checked.value.source)
    : null;
  const conditionalFor = (url: string) =>
    hasConditional(conditional) && safeTransportUrl(url) === conditional.url
      ? conditional
      : undefined;
  let response: FeedTransportResponse;
  let initialRequestUrl = checked.value.source;
  let parseKind: "feed" | "archive" = checked.value.sourceKind === "archive" ? "archive" : "feed";
  try {
    const initialConditional =
      checked.value.sourceKind === "archive" &&
      archiveStart !== null &&
      archiveStart !== checked.value.source
        ? undefined
        : hasConditional(conditional)
          ? conditional
          : undefined;
    response = await fetchPage(
      checked.value.source,
      initialConditional,
      checked.value.sourceKind !== "feed",
    );
    if (response.status === 304) {
      if (!initialConditional) throw httpFault(response.status);
      return notModified(checked.value.source, response, initialConditional);
    }
    requireSuccessfulResponse(response);
    const initialMedia = requireResponseMedia(response, checked.value.sourceKind);
    if (checked.value.sourceKind === "auto" && initialMedia === "html") {
      if (checked.value.archive) {
        parseKind = "archive";
      } else {
        initialRequestUrl = discoverAlternateFeed(response.content, response.url);
        const discoveredConditional = conditionalFor(initialRequestUrl);
        response = await fetchPage(initialRequestUrl, discoveredConditional, false);
        if (response.status === 304) {
          if (!discoveredConditional) throw httpFault(response.status);
          return notModified(checked.value.source, response, discoveredConditional);
        }
        requireSuccessfulResponse(response);
        requireResponseMedia(response, "feed");
        parseKind = "feed";
      }
    } else if (checked.value.sourceKind === "auto") {
      parseKind = "feed";
    }
  } catch (error) {
    return withLiveFailure(
      checked.value.source,
      null,
      transportFailure(error, options.signal),
      null,
    );
  }

  const initial = recordedPage(initialRequestUrl, response, parseKind);
  const recorded: RecordedFeedPage[] = [];
  let previous: FeedDiscoveryResult | null = null;
  let parsedWorkBytes = 0;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 1)
      return withLiveFailure(
        checked.value.source,
        previous,
        new FeedTransportFault(
          "timeout",
          "Feed discovery exceeded its overall timeout.",
          true,
          "timeout",
        ),
        previous?.pagination.next_url ?? initialRequestUrl,
      );
    const parseInputBytes = [initial, ...recorded].reduce(
      (total, page) => total + Buffer.byteLength(page.content, "utf8"),
      0,
    );
    if (parseInputBytes > LIVE_TOTAL_RESPONSE_BYTES - parsedWorkBytes) {
      return withLiveFailure(
        checked.value.source,
        previous,
        new FeedTransportFault(
          "response_limit_exceeded",
          "Live feed discovery exceeded its total parser work limit.",
          false,
          "response_limit",
        ),
        previous?.pagination.next_url ?? initialRequestUrl,
      );
    }
    parsedWorkBytes += parseInputBytes;
    const result = discoverFeed(
      initial,
      parserOptions(options, parseKind, Math.max(0.001, remaining / 1000)),
      recorded,
    );
    previous = result;
    const next = result.pagination.next_url;
    if (result.pagination.stop_reason !== "missing_page" || !next)
      return sanitizedLiveResult(result);
    const previousPageUrl =
      result.pagination.pages.at(-1)?.url ?? initial.effectiveUrl ?? initial.url;
    const safeNext = safeTraversalUrl(next, previousPageUrl);
    if (!safeNext)
      return withLiveFailure(
        checked.value.source,
        result,
        new FeedTransportFault(
          "unsafe_destination",
          "A discovered pagination URL is unsafe.",
          false,
          "policy",
        ),
        null,
      );
    const previousFormat = result.pagination.pages.at(-1)?.page_format;
    const nextKind: "feed" | "archive" =
      (archiveStart && safeNext === archiveStart) || previousFormat === "archive"
        ? "archive"
        : "feed";
    try {
      const nextResponse = await fetchPage(safeNext, undefined, nextKind === "archive");
      if (nextResponse.status === 304) throw httpFault(nextResponse.status);
      requireSuccessfulResponse(nextResponse);
      requireResponseMedia(nextResponse, nextKind);
      recorded.push(recordedPage(safeNext, nextResponse, nextKind));
    } catch (error) {
      return withLiveFailure(
        checked.value.source,
        result,
        transportFailure(error, options.signal),
        safeNext,
      );
    }
  }
}

export const discoverLiveFeed = discoverFeedLive;

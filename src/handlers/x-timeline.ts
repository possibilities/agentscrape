import * as cheerio from "cheerio";
import { openPage, requireAgentBrowserSuccess, runAgentBrowser } from "../browser";
import { browserEval } from "../browser-eval";
import {
  AgentscrapeBrowserError,
  AgentscrapeRuntimeError,
  AgentscrapeUsageError,
  PresetDriftError,
} from "../errors";
import { ScrapeWarning, XTimeline, XTimelineTweet } from "../schemas";
import type { HandlerOptions, ScrapeResult } from "./types";
import { absoluteX, authorInfo, checkXAuth, isReservedXRoute, isXHost } from "./x-page";

const SNOWFLAKE_EPOCH = 1288834974657n;

function timelineTarget(value: string): [string, string] {
  const clean = value.trim();
  let handle: string | undefined;
  if (clean.startsWith("@")) handle = clean.slice(1);
  else if (/^https?:/i.test(clean)) {
    try {
      const parsed = new URL(clean);
      if (isXHost(parsed.hostname.toLowerCase()))
        handle = parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/?$/)?.[1];
    } catch {
      /* reported as usage below */
    }
  } else handle = clean.replace(/^\/+|\/+$/g, "");
  if (!handle || !/^[A-Za-z0-9_]+$/.test(handle))
    throw new AgentscrapeUsageError(`Could not extract a profile handle from: '${value}'`);
  handle = handle.toLowerCase();
  if (isReservedXRoute(handle))
    throw new AgentscrapeUsageError(
      `'${handle}' is a reserved X path segment, not a profile handle`,
    );
  return [`https://x.com/${handle}`, handle];
}
function snowflakeIso(id: string): string {
  try {
    return new Date(Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH))
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "";
  }
}
function timelineTweet(html: string, profile: string): XTimelineTweet | null {
  const $ = cheerio.load(html);
  if (
    $.root()
      .text()
      .match(/^\s*Promoted\s*$/m)
  )
    return null;
  const tweet = $('[data-testid="tweet"]').first();
  if (!tweet.length) return null;
  const statusAnchor = tweet.find('a[href*="/status/"]').first();
  const id = (statusAnchor.attr("href") ?? "").match(/\/status\/(\d+)/)?.[1];
  if (!id) return null;
  const time = tweet.find("time").first();
  const permalink = time.parent("a[href]").attr("href") ?? statusAnchor.attr("href") ?? "";
  const canonical =
    absoluteX(permalink).match(/(https?:\/\/[^?#]*?\/status\/\d+)/)?.[1] ??
    `https://x.com/i/status/${id}`;
  const social = $('[data-testid="socialContext"]').first().text().toLowerCase();
  const [, author] = authorInfo($, tweet);
  const reply = tweet
    .find("div,span")
    .toArray()
    .some((element) => $(element).text().trim().startsWith("Replying to"));
  const quote = tweet.find('[role="link"] [data-testid="Tweet-User-Avatar"]').length > 0;
  const datetime = time.attr("datetime");
  const created =
    datetime && Number.isFinite(Date.parse(datetime))
      ? new Date(datetime).toISOString().replace(/\.\d{3}Z$/, "Z")
      : snowflakeIso(id);
  const articles: string[] = [];
  $.root()
    .find("a[href]")
    .each((_index, anchor) => {
      const href = absoluteX($(anchor).attr("href") ?? "");
      if (
        /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/article\/\d+/.test(href) &&
        !articles.includes(href)
      )
        articles.push(href);
    });
  return new XTimelineTweet({
    id,
    url: canonical,
    text: tweet.find('[data-testid="tweetText"]').first().text().trim(),
    created_at: created,
    is_reply: reply,
    is_repost: /repost|retweet/.test(social) || Boolean(author && author.toLowerCase() !== profile),
    is_quote: quote,
    is_pinned: social.includes("pinned"),
    article_urls: articles,
  });
}
function timelineCells(html: string): Array<{ id: string; html: string }> {
  const $ = cheerio.load(html);
  return $('[data-testid="primaryColumn"],#primaryColumn')
    .find('[data-testid="cellInnerDiv"]')
    .toArray()
    .flatMap((element) => {
      const content = $.html(element);
      const id = content.match(/\/status\/(\d+)/)?.[1];
      return id ? [{ id, html: content }] : [];
    });
}
type TimelineWarning = "scroll_stalled" | "max_scrolls_reached" | "no_tweets_found";
interface TimelineEvidence {
  hitBottom?: boolean;
  warning?: TimelineWarning;
  providerEmpty?: boolean;
  classifiableObserved?: boolean;
}
export interface TimelineHarvestState {
  cells: Array<{ id: string; html: string }>;
  classifiableIds: string[];
  providerEmpty: boolean;
}
export interface TimelineHarvestUpdate {
  state: TimelineHarvestState;
  madeProgress: number;
}
interface TimelineBuild {
  result: ScrapeResult<XTimeline>;
  caughtUp: boolean;
  hitLimit: boolean;
}
function evaluateTimeline(
  cells: Array<{ id: string; html: string }>,
  profile: string,
  options: HandlerOptions,
  evidence: TimelineEvidence = {},
): TimelineBuild {
  const limit = options.limit ?? 30;
  const since = options.sinceId ? BigInt(options.sinceId) : null;
  const tweets: XTimelineTweet[] = [];
  const seen = new Set<string>();
  let oldest: bigint | null = null;
  let caughtUp = false;
  let hitLimit = false;
  for (const cell of cells) {
    if (seen.has(cell.id)) continue;
    seen.add(cell.id);
    const tweet = timelineTweet(cell.html, profile);
    if (!tweet) continue;
    const id = BigInt(tweet.id);
    if (!tweet.is_repost && !tweet.is_pinned && (oldest === null || id < oldest)) oldest = id;
    if (since !== null && !tweet.is_repost && !tweet.is_pinned && id <= since) {
      caughtUp = true;
      break;
    }
    if (tweet.is_repost && !options.includeReposts) continue;
    if (tweet.is_reply && !options.includeReplies) continue;
    if (since !== null && id <= since) continue;
    tweets.push(tweet);
    if (tweets.length >= limit) {
      hitLimit = true;
      break;
    }
  }
  const warning = evidence.warning;
  const warnings = warning
    ? [
        new ScrapeWarning(
          warning,
          warning === "no_tweets_found"
            ? "X explicitly reported that this timeline is empty"
            : warning === "scroll_stalled"
              ? "no new tweets after repeated settled scrolls"
              : `hit the ${options.maxScrolls ?? 20}-scroll ceiling before the bottom`,
        ),
      ]
    : [];
  const schema = new XTimeline({
    handle: profile,
    next_cursor:
      caughtUp || (evidence.hitBottom && !hitLimit) ? null : (oldest?.toString() ?? null),
    scraped_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    tweets,
    warnings,
  });
  return {
    caughtUp,
    hitLimit,
    result: {
      links: tweets.map((tweet) => ({
        url: tweet.url,
        title: tweet.text.split("\n")[0]!.slice(0, 80),
        section: "",
        category: "",
      })),
      structured: schema,
      markdown: schema.toMarkdown(),
      selected_html: cells.map((cell) => cell.html).join(""),
      full_html: "",
    },
  };
}
function hasExplicitTimelineEmpty(html: string): boolean {
  const $ = cheerio.load(html);
  return $('[data-testid="primaryColumn"],#primaryColumn')
    .toArray()
    .some(
      (root) =>
        $(root).find('[data-testid="emptyState"],[data-testid="empty_state_header_text"]').length >
        0,
    );
}

export function harvestTimelineFrame(
  previous: TimelineHarvestState | undefined,
  html: string,
  profile: string,
): TimelineHarvestUpdate {
  const cells = new Map((previous?.cells ?? []).map((cell) => [cell.id, cell.html]));
  const classifiable = new Set(previous?.classifiableIds ?? []);
  let madeProgress = 0;
  for (const candidate of timelineCells(html)) {
    const existed = cells.has(candidate.id);
    const wasClassifiable = classifiable.has(candidate.id);
    const isClassifiable = timelineTweet(candidate.html, profile) !== null;
    if (!existed || (isClassifiable && !wasClassifiable)) madeProgress += 1;
    if (isClassifiable || !wasClassifiable) cells.set(candidate.id, candidate.html);
    if (isClassifiable) classifiable.add(candidate.id);
  }
  return {
    state: {
      cells: [...cells].map(([id, cellHtml]) => ({ id, html: cellHtml })),
      classifiableIds: [...classifiable],
      providerEmpty: Boolean(previous?.providerEmpty) || hasExplicitTimelineEmpty(html),
    },
    madeProgress,
  };
}

function finalizeTimeline(
  cells: Array<{ id: string; html: string }>,
  profile: string,
  options: HandlerOptions,
  evidence: TimelineEvidence,
): ScrapeResult<XTimeline> {
  const classifiableObserved =
    evidence.classifiableObserved ||
    cells.some((cell) => timelineTweet(cell.html, profile) !== null);
  if (!classifiableObserved) {
    if (!evidence.providerEmpty) {
      throw new PresetDriftError(
        "X timeline core structure missing (no classifiable tweets or allowlisted provider-empty state)",
      );
    }
    const emptyEvidence: TimelineEvidence = { warning: "no_tweets_found" };
    if (evidence.hitBottom !== undefined) emptyEvidence.hitBottom = evidence.hitBottom;
    return evaluateTimeline(cells, profile, options, emptyEvidence).result;
  }
  const finalEvidence: TimelineEvidence = {};
  if (evidence.hitBottom !== undefined) finalEvidence.hitBottom = evidence.hitBottom;
  if (evidence.warning && evidence.warning !== "no_tweets_found")
    finalEvidence.warning = evidence.warning;
  return evaluateTimeline(cells, profile, options, finalEvidence).result;
}

export function finalizeTimelineHarvest(
  state: TimelineHarvestState,
  profile: string,
  options: HandlerOptions = {},
  evidence: TimelineEvidence = {},
): ScrapeResult<XTimeline> {
  return finalizeTimeline(state.cells, profile, options, {
    ...evidence,
    providerEmpty: state.providerEmpty,
    classifiableObserved: state.cells.some((cell) => timelineTweet(cell.html, profile) !== null),
  });
}

export function buildTimeline(
  cells: Array<{ id: string; html: string }>,
  profile: string,
  options: HandlerOptions = {},
  evidence: TimelineEvidence = {},
): ScrapeResult<XTimeline> {
  return finalizeTimeline(cells, profile, options, evidence);
}
export async function scrapeTimeline(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<XTimeline>> {
  const injectedHtml = options.html;
  const injected = injectedHtml !== undefined && injectedHtml !== null;
  const [, profile] = timelineTarget(url);
  if (injected) {
    const harvested = harvestTimelineFrame(undefined, injectedHtml, profile);
    return finalizeTimelineHarvest(harvested.state, profile, options);
  }
  const [target] = timelineTarget(url);
  await openPage(target, options.session, options.media, '[data-testid="primaryColumn"]');
  await checkXAuth(options.session);
  let harvest: TimelineHarvestState | undefined;
  let stalled = 0;
  const maxScrolls = options.maxScrolls ?? 20;
  for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
    const value = await browserEval(
      `(() => ({html: document.documentElement.outerHTML, scrollTop: window.scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight}))()`,
      options.session,
      "Timeline harvest failed",
    );
    if (!value || typeof value !== "object")
      throw new AgentscrapeBrowserError("Timeline harvest failed: expected an object result");
    const frame = value as Record<string, unknown>;
    if (
      typeof frame.html !== "string" ||
      typeof frame.scrollTop !== "number" ||
      typeof frame.scrollHeight !== "number" ||
      typeof frame.innerHeight !== "number"
    )
      throw new AgentscrapeBrowserError("Timeline harvest failed: invalid frame result");
    const update = harvestTimelineFrame(harvest, frame.html, profile);
    harvest = update.state;
    const bottom = frame.scrollTop + frame.innerHeight >= frame.scrollHeight - 4;
    const built = evaluateTimeline(harvest.cells, profile, options, { hitBottom: bottom });
    if (built.hitLimit || built.caughtUp || bottom)
      return finalizeTimelineHarvest(harvest, profile, options, { hitBottom: bottom });
    if (scroll === maxScrolls)
      return finalizeTimelineHarvest(harvest, profile, options, {
        warning: "max_scrolls_reached",
      });
    stalled = update.madeProgress ? 0 : stalled + 1;
    if (stalled >= 3)
      return finalizeTimelineHarvest(harvest, profile, options, { warning: "scroll_stalled" });
    const scrolled = await runAgentBrowser(
      ["eval", "window.scrollBy(0, Math.floor(window.innerHeight * 0.85))"],
      options.session,
    );
    requireAgentBrowserSuccess(scrolled, "Timeline scroll failed");
    const waited = await runAgentBrowser(["wait", "400"], options.session);
    requireAgentBrowserSuccess(waited, "Timeline wait failed");
  }
  throw new AgentscrapeRuntimeError("Timeline loop ended unexpectedly");
}

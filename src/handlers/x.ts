import * as cheerio from "cheerio";
import { openPage, runAgentBrowser } from "../browser";
import { browserEval, browserEvalString } from "../browser-eval";
import { AgentscrapeAuthError, PresetDriftError } from "../errors";
import { convertHtml } from "../html";
import { containsJwt, isSensitiveName } from "../redaction";
import {
  ScrapeWarning,
  TweetContent,
  TweetThread,
  XArticle,
  XProfile,
  XTimeline,
  XTimelineTweet,
} from "../schemas";
import type { HandlerOptions, ScrapeResult } from "./types";

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.x.com",
  "mobile.twitter.com",
]);
const MEDIA_HOSTS = new Set([
  "abs.twimg.com",
  "pbs.twimg.com",
  "pic.twitter.com",
  "ton.twimg.com",
  "video.twimg.com",
  "t.co",
]);
const ANALYTICS_HOSTS = new Set([
  "ads-twitter.com",
  "ads.twitter.com",
  "analytics.twitter.com",
  "clarity.ms",
  "doubleclick.net",
  "google-analytics.com",
  "googleadservices.com",
  "googletagmanager.com",
  "hotjar.com",
  "mixpanel.com",
  "plausible.io",
  "segment.io",
]);
const RESERVED = new Set([
  "i",
  "home",
  "search",
  "explore",
  "notifications",
  "messages",
  "settings",
  "compose",
  "intent",
]);
const SNOWFLAKE_EPOCH = 1288834974657n;

export function isXUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//.test(url);
}
export function extractStatusId(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}
export function extractAuthorHandle(url: string): string | null {
  const handle = url.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\//)?.[1]?.toLowerCase();
  return handle && handle !== "i" ? handle : null;
}
export function extractProfileHandle(url: string): string | null {
  return url.match(/(?:x\.com|twitter\.com)\/(\w+)\/?$/)?.[1]?.toLowerCase() ?? null;
}
function absoluteX(href: string): string {
  if (/^https?:/.test(href)) return href;
  return href.startsWith("/") ? `https://x.com${href}` : href;
}
function authorInfo($: cheerio.CheerioAPI, tweet: cheerio.Cheerio<any>): [string, string, string] {
  const user = tweet.find('[data-testid="User-Name"]').first();
  let name = "";
  let handle = "";
  let url = "";
  user.find("a[href]").each((_index, anchor) => {
    if (handle) return;
    const href = $(anchor).attr("href") ?? "";
    const match = href.match(/^\/(\w+)$/);
    if (!match) return;
    handle = match[1]!;
    url = absoluteX(href);
    const text = $(anchor).text().replace(/\s+/g, " ").trim();
    if (text && !text.startsWith("@")) name = text;
  });
  user.find("span").each((_index, span) => {
    const text = $(span).text().replace(/\s+/g, " ").trim();
    if (!text || text === "·") return;
    if (text.startsWith("@") && !handle) handle = text.slice(1);
    else if (!text.startsWith("@") && !name) name = text;
  });
  if (handle && !url) url = `https://x.com/${handle}`;
  return [name, handle, url];
}
function meaningfulLink(href: string, $: cheerio.CheerioAPI, anchor: any): boolean {
  try {
    const url = new URL(href);
    if (!/https?:/.test(url.protocol)) return false;
    if (/\/(?:analytics|quotes|photo|video|media)(?:\/|$)/.test(url.pathname)) return false;
    if ($(anchor).parents('[data-testid="User-Name"]').length || $(anchor).find("time").length)
      return false;
    return !(X_HOSTS.has(url.hostname) && /^\/[A-Za-z0-9_]+\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}
function tweetContent($: cheerio.CheerioAPI, tweet: cheerio.Cheerio<any>): TweetContent {
  const textElement = tweet.find('[data-testid="tweetText"]').first();
  const text = textElement
    .text()
    .replace(/\u00a0/g, " ")
    .trim();
  const links: string[] = [];
  tweet.find("a[href]").each((_index, anchor) => {
    const href = absoluteX($(anchor).attr("href") ?? "");
    if (meaningfulLink(href, $, anchor) && !links.includes(href)) links.push(href);
  });
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const href = match[0].replace(/[.,!?:;)]+$/, "");
    if (!links.includes(href)) links.push(href);
  }
  const time = tweet.find("time").first();
  const parent = time.parent("a[href]");
  return new TweetContent({
    text,
    timestamp: time.text().trim(),
    permalink: parent.length ? absoluteX(parent.attr("href") ?? "") : "",
    links,
  });
}
function tweetAuthor($: cheerio.CheerioAPI, tweet: cheerio.Cheerio<any>): string | null {
  return authorInfo($, tweet)[1].toLowerCase() || null;
}
function buildThread(html: string, fallbackHandle = "", statusId?: string | null): TweetThread {
  const $ = cheerio.load(html);
  let tweets = $('[data-testid="tweet"]');
  if (statusId) {
    const matched = tweets.filter(
      (_index, element) => $(element).find(`a[href*="/status/${statusId}"]`).length > 0,
    );
    if (matched.length) {
      const all = tweets.toArray();
      tweets = $(all.slice(all.indexOf(matched[0]!)));
    }
  }
  if (!tweets.length) {
    throw new PresetDriftError("X tweet core structure missing (no [data-testid=tweet])");
  }
  const first = $(tweets[0]!);
  const [name, parsedHandle, url] = authorInfo($, first);
  const handle = parsedHandle || fallbackHandle;
  const own: TweetContent[] = [];
  for (const element of tweets.toArray()) {
    const tweet = $(element);
    if (tweetAuthor($, tweet) !== (parsedHandle || tweetAuthor($, first))) break;
    own.push(tweetContent($, tweet));
  }
  let quoted: TweetContent | null = null;
  const nested = first.find('[data-testid="tweet"]').first();
  if (nested.length) {
    const value = tweetContent($, nested);
    if (value.text || value.timestamp || value.permalink) quoted = value;
  }
  return new TweetThread({
    author_name: name,
    author_handle: handle,
    author_url: url || (handle ? `https://x.com/${handle}` : ""),
    tweets: own,
    quoted_tweet: quoted,
  });
}
function safeExpandedRedirect(location: string, base: string): string | null {
  if (!location) return null;
  try {
    const parsed = new URL(location, base);
    const host = parsed.hostname.toLowerCase();
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host.includes(":") ||
      /^\d+(?:\.\d+){3}$/.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    )
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function prepareLinks(
  html: string,
  options: HandlerOptions,
  expandRedirects: boolean,
): Promise<string> {
  const $ = cheerio.load(html);
  if (expandRedirects) {
    const redirects = [
      ...new Set(
        $('a[href^="https://t.co/"]')
          .map((_index, anchor) => $(anchor).attr("href") ?? "")
          .get()
          .filter(Boolean),
      ),
    ].slice(0, 20);
    await Promise.all(
      redirects.map(async (redirect) => {
        try {
          const timeout = AbortSignal.timeout(5000);
          const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
          const response = await fetch(redirect, {
            redirect: "manual",
            headers: { "user-agent": "agentscrape/1.0" },
            signal,
          });
          await response.body?.cancel();
          const expanded = safeExpandedRedirect(response.headers.get("location") ?? "", redirect);
          if (expanded) {
            $("a[href]").each((_index, anchor) => {
              if ($(anchor).attr("href") === redirect) $(anchor).attr("href", expanded);
            });
          }
        } catch {
          if (options.signal?.aborted)
            throw options.signal.reason ?? new DOMException("operation cancelled", "AbortError");
          // Preserve the original redirect when expansion is unavailable.
        }
      }),
    );
  }
  $("a[href]").each((_index, anchor) => {
    const element = $(anchor);
    const href = element.attr("href") ?? "";
    const visible = element.text().replace(/\s+/g, " ").trim();
    if (
      href.startsWith("http") &&
      visible &&
      (visible.includes("…") ||
        visible.includes("...") ||
        element.text().includes("\n") ||
        href.includes(visible))
    ) {
      element.text(href);
    }
  });
  return $.html();
}

async function browserHtml(
  url: string,
  options: HandlerOptions,
  selector: string,
): Promise<string> {
  await openPage(url, options.session, options.media, selector);
  await checkXAuth(options.session);
  return browserEvalString(
    "document.documentElement.outerHTML",
    options.session,
    "Failed to get X page HTML",
  );
}
export async function checkXAuth(session?: string | null): Promise<void> {
  const required = await browserEval(
    "(document.querySelector('[data-testid=\"BottomBar\"]')?.getBoundingClientRect().height ?? 0) > 0",
    session,
    "Failed to check X authentication state",
  );
  if (typeof required !== "boolean")
    throw new Error("Failed to check X authentication state: expected a boolean result");
  if (required)
    throw new AgentscrapeAuthError("X.com authentication required - browser is not signed in");
}
export type XStatusPageKind = "tweet" | "article";
export interface CapturedXStatusPage {
  kind: XStatusPageKind;
  html: string;
  live: boolean;
}

export async function captureXStatusPage(
  url: string,
  options: HandlerOptions = {},
): Promise<CapturedXStatusPage> {
  const live = options.html === undefined || options.html === null;
  const html =
    options.html ??
    (await browserHtml(
      url,
      options,
      '[data-testid="twitterArticleReadView"], [data-testid="tweetText"]',
    ));
  const $ = cheerio.load(html);
  return {
    kind: $('[data-testid="twitterArticleReadView"]').length ? "article" : "tweet",
    html,
    live,
  };
}

async function scrapeCapturedTweet(
  url: string,
  captured: string,
  options: HandlerOptions,
  live: boolean,
): Promise<ScrapeResult<TweetThread>> {
  const status = extractStatusId(url);
  if (live && !status) throw new Error(`Could not extract status ID from URL: ${url}`);
  const html = await prepareLinks(captured, options, live);
  const structured = buildThread(html, extractAuthorHandle(url) ?? "", status);
  if (!structured.tweets.length) throw new Error(`Could not find tweet with status ID ${status}`);
  const selected = structured.tweets.length === 1 ? html : `<div>${html}</div>`;
  return {
    full_html: live ? html : "",
    selected_html: selected,
    markdown: structured.toMarkdown(),
    structured,
  };
}

export async function scrapeTweet(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<TweetThread>> {
  const live = options.html === undefined || options.html === null;
  const captured = options.html ?? (await browserHtml(url, options, '[data-testid="tweet"]'));
  return scrapeCapturedTweet(url, captured, options, live);
}

function cleanTweetMarkdown(html: string): string {
  const $ = cheerio.load(html, null, false);
  $("script,style,noscript,svg,iframe,button,[role=group],[aria-hidden=true]").remove();
  $('a[href$="/analytics"],a[href$="/quotes"]').remove();
  return convertHtml($.html() ?? "")
    .replace(/\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function scrapeProfile(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<XProfile>> {
  if (!options.html && !extractProfileHandle(url))
    throw new Error(`Could not extract handle from URL: ${url}`);
  const captured = options.html ?? (await browserHtml(url, options, '[data-testid="UserName"]'));
  const full = await prepareLinks(captured, options, !options.html);
  const $ = cheerio.load(full);
  const root: cheerio.Cheerio<any> = options.html
    ? $.root()
    : $('[data-testid="primaryColumn"]').first().length
      ? $('[data-testid="primaryColumn"]').first()
      : $("body");
  const user = root.find('[data-testid="UserName"]').first();
  if (!user.length) {
    throw new PresetDriftError("X profile core structure missing (no [data-testid=UserName])");
  }
  let display = "";
  let handle = "";
  user.find("span").each((_index, span) => {
    const value = $(span).text().trim();
    if (value.startsWith("@")) handle = value;
    else if (value && !display) display = value;
  });
  let following = "";
  let followers = "";
  root.find("a[href]").each((_index, anchor) => {
    const href = $(anchor).attr("href") ?? "";
    if (/\/\w+\/following$/.test(href)) following = $(anchor).text().trim();
    if (/\/\w+\/(?:verified_followers|followers)$/.test(href)) followers = $(anchor).text().trim();
  });
  const allTweets = root.find('[data-testid="tweet"]');
  let pinnedElement: any = null;
  root.find('[data-testid="socialContext"]').each((_index, context) => {
    if (!pinnedElement && $(context).text().includes("Pinned"))
      pinnedElement = $(context).parent().find('[data-testid="tweet"]')[0] ?? null;
  });
  const recent: string[] = [];
  const recentStructured: TweetContent[] = [];
  let latestVersion = "";
  let latestPostId = "";
  for (const element of allTweets.toArray()) {
    if (element === pinnedElement || recent.length >= 5) continue;
    const content = tweetContent($, $(element));
    recentStructured.push(content);
    for (const pattern of [
      /Claude Code (\d+\.\d+\.\d+) is out/,
      /released Claude Code (\d+\.\d+\.\d+)/,
      /Claude Code (\d+\.\d+\.\d+)/,
    ]) {
      const version = content.text.match(pattern)?.[1];
      const id = extractStatusId(content.permalink);
      if (version && id && (!latestVersion || compareVersion(version, latestVersion) > 0)) {
        latestVersion = version;
        latestPostId = id;
      }
    }
    recent.push(cleanTweetMarkdown($.html(element)));
  }
  const structured = new XProfile({
    display_name: display,
    handle,
    bio: root.find('[data-testid="UserDescription"]').first().text().trim(),
    header_text: root
      .find('[data-testid="UserProfileHeader_Items"]')
      .first()
      .text()
      .replace(/\s+/g, " · ")
      .trim(),
    following_text: following,
    followers_text: followers,
    pinned_tweet: pinnedElement ? cleanTweetMarkdown($.html(pinnedElement)) : "",
    recent_posts: recent,
    recent_posts_structured: recentStructured,
    latest_version: latestVersion,
    latest_post_id: latestPostId,
  });
  return {
    full_html: options.html ? "" : full,
    selected_html: $.html(root),
    markdown: structured.toMarkdown(),
    structured,
  };
}
function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function timelineTarget(value: string): [string, string] {
  const clean = value.trim();
  let handle = clean.startsWith("@")
    ? clean.slice(1)
    : /^https?:/.test(clean)
      ? clean.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)/)?.[1]
      : clean.replace(/^\/+|\/+$/g, "");
  if (!handle || !/^[A-Za-z0-9_]+$/.test(handle))
    throw new Error(`Could not extract a profile handle from: '${value}'`);
  handle = handle.toLowerCase();
  if (RESERVED.has(handle))
    throw new Error(`'${handle}' is a reserved X path segment, not a profile handle`);
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
  return $('[data-testid="cellInnerDiv"]')
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
            ? "no classifiable tweets found after hydration"
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
export function buildTimeline(
  cells: Array<{ id: string; html: string }>,
  profile: string,
  options: HandlerOptions = {},
  evidence: TimelineEvidence = {},
): ScrapeResult<XTimeline> {
  return evaluateTimeline(cells, profile, options, evidence).result;
}
export async function scrapeTimeline(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<XTimeline>> {
  let profile = "";
  try {
    [, profile] = timelineTarget(url);
  } catch (error) {
    if (!options.html) throw error;
  }
  if (options.html) {
    const cells = timelineCells(options.html);
    return buildTimeline(
      cells,
      profile,
      options,
      cells.length ? {} : { warning: "no_tweets_found" },
    );
  }
  const [target] = timelineTarget(url);
  await openPage(target, options.session, options.media, '[data-testid="primaryColumn"]');
  await checkXAuth(options.session);
  const seen = new Map<string, string>();
  let stalled = 0;
  const maxScrolls = options.maxScrolls ?? 20;
  for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
    const value = await browserEval(
      `(() => ({html: document.documentElement.outerHTML, scrollTop: window.scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight}))()`,
      options.session,
      "Timeline harvest failed",
    );
    if (!value || typeof value !== "object")
      throw new Error("Timeline harvest failed: expected an object result");
    const frame = value as Record<string, unknown>;
    if (
      typeof frame.html !== "string" ||
      typeof frame.scrollTop !== "number" ||
      typeof frame.scrollHeight !== "number" ||
      typeof frame.innerHeight !== "number"
    )
      throw new Error("Timeline harvest failed: invalid frame result");
    let added = 0;
    for (const cell of timelineCells(frame.html))
      if (!seen.has(cell.id)) {
        seen.set(cell.id, cell.html);
        added += 1;
      }
    const bottom = frame.scrollTop + frame.innerHeight >= frame.scrollHeight - 4;
    const cells = [...seen].map(([id, html]) => ({ id, html }));
    const built = evaluateTimeline(cells, profile, options, { hitBottom: bottom });
    if (built.hitLimit || built.caughtUp || bottom) {
      if (!built.result.structured.tweets.length && !built.caughtUp && !seen.size)
        return buildTimeline(cells, profile, options, {
          hitBottom: bottom,
          warning: "no_tweets_found",
        });
      return built.result;
    }
    if (scroll === maxScrolls)
      return buildTimeline(cells, profile, options, { warning: "max_scrolls_reached" });
    stalled = added ? 0 : stalled + 1;
    if (stalled >= 3) return buildTimeline(cells, profile, options, { warning: "scroll_stalled" });
    const scrolled = await runAgentBrowser(
      ["eval", "window.scrollBy(0, Math.floor(window.innerHeight * 0.85))"],
      options.session,
    );
    if (scrolled.exitCode !== 0) throw new Error(`Timeline scroll failed: ${scrolled.stderr}`);
    const waited = await runAgentBrowser(["wait", "400"], options.session);
    if (waited.exitCode !== 0) throw new Error(`Timeline wait failed: ${waited.stderr}`);
  }
  throw new Error("Timeline loop ended unexpectedly");
}

function parseArticle(html: string, url: string): XArticle {
  const $ = cheerio.load(html);
  const reader = $('[data-testid="twitterArticleReadView"]').first();
  const scope: cheerio.Cheerio<any> = reader.length ? reader : $.root();
  let body: cheerio.Cheerio<any> = scope.find('[data-testid="twitterArticleRichTextView"]').first();
  if (!body.length) body = scope.find('[data-testid="longformRichTextComponent"]').first();
  if (!body.length && reader.length) body = reader;
  const title =
    $('[data-testid="twitter-article-title"]').first().text().replace(/\s+/g, " ").trim() ||
    scope.find("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title")
      .first()
      .text()
      .replace(/\s*\/\s*X\s*$/, "")
      .trim();
  let author =
    scope
      .find('[data-testid^="UserAvatar-Container-"]')
      .first()
      .attr("data-testid")
      ?.replace("UserAvatar-Container-", "")
      .toLowerCase() ?? authorInfo($, scope)[1].toLowerCase();
  if (!author)
    author =
      url.match(/(?:x\.com|twitter\.com)\/([^/\s]+)\/articles?\/\d+/)?.[1]?.toLowerCase() ?? "";
  const links: string[] = [];
  body.find("a[href]").each((_index, anchor) => {
    const href = absoluteX($(anchor).attr("href") ?? "");
    if (href.startsWith("http") && !links.includes(href)) links.push(href);
  });
  body.find("script,style,noscript,svg,iframe,button,[role=group],[aria-hidden=true]").remove();
  let markdown = body.length
    ? convertHtml($.html(body))
        .replace(/\n/g, "\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : "";
  const sourceText = body
    .find('[data-text="true"]')
    .map((_index, element) => $(element).text())
    .get();
  markdown = markdown
    .split("\n")
    .map((line) => {
      const original = sourceText.find((text) => text.trim() === line);
      return original ?? line;
    })
    .join("\n");
  const datetime = scope.find("time").first().attr("datetime");
  const published =
    datetime && Number.isFinite(Date.parse(datetime))
      ? new Date(datetime).toISOString().replace(/\.\d{3}Z$/, "Z")
      : "";
  if (!reader.length) {
    throw new PresetDriftError(
      "X article reader container not found (missing core article structure)",
    );
  }
  if (!markdown) {
    throw new PresetDriftError("X article reader present but rendered no body content");
  }
  const warnings: ScrapeWarning[] = [];
  if (!title) {
    warnings.push(
      new ScrapeWarning(
        "partial_article_extract",
        "article body loaded but the title was incomplete",
      ),
    );
  }
  return new XArticle({
    url,
    title,
    author_handle: author,
    published_at: published,
    markdown,
    links,
    warnings,
  });
}
async function scrapeCapturedArticle(
  url: string,
  captured: string,
  options: HandlerOptions,
  live: boolean,
): Promise<ScrapeResult<XArticle>> {
  const html = await prepareLinks(captured, options, live);
  const structured = parseArticle(html, url);
  return {
    full_html: live ? html : "",
    selected_html: html,
    markdown: structured.toMarkdown(),
    structured,
  };
}

export async function scrapeArticle(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<XArticle>> {
  const live = options.html === undefined || options.html === null;
  const captured =
    options.html ?? (await browserHtml(url, options, '[data-testid="twitterArticleReadView"]'));
  return scrapeCapturedArticle(url, captured, options, live);
}

export async function scrapeCapturedXStatus(
  url: string,
  captured: CapturedXStatusPage,
  options: HandlerOptions = {},
): Promise<ScrapeResult<TweetThread | XArticle>> {
  return captured.kind === "article"
    ? scrapeCapturedArticle(url, captured.html, options, captured.live)
    : scrapeCapturedTweet(url, captured.html, options, captured.live);
}

export function eligibleExtractionUrl(value: string, sources: string[] = []): string | null {
  try {
    if (new TextEncoder().encode(value).byteLength > 4096 || /\s/.test(value)) return null;
    const url = new URL(value);
    if (!/https?:/.test(url.protocol) || url.username || url.password) return null;
    for (const [name, item] of url.searchParams) {
      const decoded = decodeURIComponent(item);
      if (
        isSensitiveName(name) ||
        containsJwt(decoded) ||
        [...new URLSearchParams(decoded).keys()].some((nested) => isSensitiveName(nested))
      )
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const hostMatches = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
    if (
      MEDIA_HOSTS.has(host) ||
      host.split(".").includes("analytics") ||
      [...ANALYTICS_HOSTS].some(hostMatches)
    )
      return null;
    const decodedParts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (
      decodedParts.some(containsJwt) ||
      decodedParts.some((_part, index) => index > 0 && isSensitiveName(decodedParts[index - 1]!))
    )
      return null;
    const parts = decodedParts.map((part) => part.toLowerCase());
    const profileLike =
      (parts.length <= 2 &&
        [
          "author",
          "authors",
          "member",
          "members",
          "people",
          "profile",
          "profiles",
          "user",
          "users",
        ].includes(parts[0] ?? "")) ||
      (parts.length === 1 &&
        [
          "account",
          "categories",
          "explore",
          "feed",
          "home",
          "login",
          "menu",
          "navigation",
          "notifications",
          "search",
          "settings",
          "signup",
        ].includes(parts[0]!)) ||
      (hostMatches("linkedin.com") && ["in", "company"].includes(parts[0] ?? "")) ||
      ((hostMatches("github.com") || hostMatches("gitlab.com")) && parts.length === 1) ||
      (hostMatches("youtube.com") &&
        (parts[0]?.startsWith("@") || ["c", "channel", "user"].includes(parts[0] ?? ""))) ||
      (hostMatches("reddit.com") && parts.length >= 2 && ["u", "user"].includes(parts[0]!)) ||
      (parts.length === 1 && parts[0]!.startsWith("@"));
    if (profileLike) return null;
    if (
      /\.(?:aac|avif|avi|gif|ico|jpe?g|m4[av]|mkv|mov|mp3|mp4|mpeg|mpg|ogg|ogv|png|svg|wav|webm|webp)$/i.test(
        decodeURIComponent(url.pathname),
      )
    )
      return null;
    if (
      X_HOSTS.has(host) &&
      !/^\/(?:[A-Za-z0-9_]+\/status\/\d+|i\/(?:web\/)?status\/\d+|[A-Za-z0-9_]+\/articles?\/\d+|i\/articles?\/\d+)\/?$/.test(
        url.pathname,
      )
    )
      return null;
    if (X_HOSTS.has(host)) {
      url.protocol = "https:";
      url.hostname = "x.com";
      url.search = "";
      url.hash = "";
    } else url.hash = "";
    const normalized = url.href;
    return sources.some((source) => eligibleExtractionUrl(source) === normalized)
      ? null
      : normalized;
  } catch {
    return null;
  }
}
export function extractionOutboundUrls(
  structured: TweetThread | XArticle,
  requestedUrl: string,
  finalUrl: string,
  max?: number,
): string[] {
  const candidates =
    structured instanceof XArticle
      ? structured.links
      : [
          ...structured.tweets.flatMap((tweet) => tweet.links),
          ...(structured.quoted_tweet?.links ?? []),
        ];
  const result: string[] = [];
  for (const candidate of candidates) {
    const url = eligibleExtractionUrl(candidate, [requestedUrl, finalUrl]);
    if (url && !result.includes(url)) result.push(url);
    if (max !== undefined && result.length > max) break;
  }
  return result;
}

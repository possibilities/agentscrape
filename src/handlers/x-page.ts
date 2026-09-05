import type * as cheerio from "cheerio";
import { browserEval } from "../browser-eval";
import { AgentscrapeAuthError, AgentscrapeBrowserError } from "../errors";

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.x.com",
  "mobile.twitter.com",
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

export function isXHost(hostname: string): boolean {
  return X_HOSTS.has(hostname);
}
export function isReservedXRoute(handle: string): boolean {
  return RESERVED.has(handle);
}
export function absoluteX(href: string): string {
  if (/^https?:/.test(href)) return href;
  return href.startsWith("/") ? `https://x.com${href}` : href;
}
export function ownedDescendants(
  $: cheerio.CheerioAPI,
  tweet: cheerio.Cheerio<any>,
  selector: string,
): cheerio.Cheerio<any> {
  const candidate = tweet[0];
  return tweet
    .find(selector)
    .filter(
      (_index, element) =>
        Boolean(candidate) && $(element).parents('[data-testid="tweet"]').first()[0] === candidate,
    );
}
export function authorInfo(
  $: cheerio.CheerioAPI,
  tweet: cheerio.Cheerio<any>,
  owned = false,
): [string, string, string] {
  const user = (
    owned
      ? ownedDescendants($, tweet, '[data-testid="User-Name"]')
      : tweet.find('[data-testid="User-Name"]')
  ).first();
  let name = "";
  let handle = "";
  let url = "";
  const anchors = owned
    ? ownedDescendants($, tweet, "a[href]").filter(
        (_index, anchor) => $(anchor).parents('[data-testid="User-Name"]').first()[0] === user[0],
      )
    : user.find("a[href]");
  anchors.each((_index, anchor) => {
    if (handle) return;
    const href = $(anchor).attr("href") ?? "";
    const match = href.match(/^\/(\w+)$/);
    if (!match) return;
    handle = match[1]!.toLowerCase();
    url = absoluteX(href);
    const text = $(anchor).text().replace(/\s+/g, " ").trim();
    if (text && !text.startsWith("@")) name = text;
  });
  const spans = owned
    ? ownedDescendants($, tweet, "span").filter(
        (_index, span) => $(span).parents('[data-testid="User-Name"]').first()[0] === user[0],
      )
    : user.find("span");
  spans.each((_index, span) => {
    const text = $(span).text().replace(/\s+/g, " ").trim();
    if (!text || text === "·") return;
    if (text.startsWith("@") && !handle) handle = text.slice(1).toLowerCase();
    else if (!text.startsWith("@") && !name) name = text;
  });
  if (handle && !url) url = `https://x.com/${handle}`;
  return [name, handle, url];
}

// X's signed-out rendering is a different, reduced page: it carries no data-testid
// attributes at all, and every selector this handler reads is one. A selector miss
// on such a page is therefore a sign-in problem, not a transient one, and is
// reported as authentication so a queue owner blocks it with the reason instead of
// retrying a page that will never change. Seen 2026-08-30 through 2026-09-05, when
// the browser stack moved to fresh per-fetch profiles and every X post failed the
// same way five times before blocking as an item problem.
export const X_APP_PROBE = "document.querySelectorAll('[data-testid]').length";
export const X_SIGNED_OUT_MESSAGE =
  "X.com authentication required - a signed-out browser receives X's reduced page without the elements the extractor reads; sign the browser profile agentscrape uses into x.com";

export async function requireXApp(session?: string | null): Promise<void> {
  const count = await browserEval(X_APP_PROBE, session, "Failed to check the X page shape");
  if (typeof count !== "number")
    throw new AgentscrapeBrowserError(
      "Failed to check the X page shape: expected a numeric result",
    );
  if (count === 0) throw new AgentscrapeAuthError(X_SIGNED_OUT_MESSAGE);
}

export async function checkXAuth(session?: string | null): Promise<void> {
  const required = await browserEval(
    "(document.querySelector('[data-testid=\"BottomBar\"]')?.getBoundingClientRect().height ?? 0) > 0",
    session,
    "Failed to check X authentication state",
  );
  if (typeof required !== "boolean")
    throw new AgentscrapeBrowserError(
      "Failed to check X authentication state: expected a boolean result",
    );
  if (required)
    throw new AgentscrapeAuthError("X.com authentication required - browser is not signed in");
}

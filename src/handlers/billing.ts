import * as cheerio from "cheerio";
import { CLAUDE_APP_READY_SELECTOR, openPage, warmClaudeSession } from "../browser";
import { browserEvalString } from "../browser-eval";
import { AgentscrapeAuthError, PresetDriftError } from "../errors";
import {
  AnthropicBilling,
  ClaudeBilling,
  ClaudeUsage,
  CodexUsage,
  OpenAIBilling,
  PerplexityBilling,
} from "../schemas";
import type { HandlerOptions, ScrapeResult } from "./types";

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
function capture(pattern: RegExp, text: string): string {
  return clean(text.match(pattern)?.[1] ?? "");
}
function money(value: string): number | null {
  const match = value.match(/\$\s*\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/[$,\s]/g, "")) : null;
}
function textAndToggles(html: string): {
  text: string;
  toggles: Array<{ label: string; checked: boolean }>;
} {
  const $ = cheerio.load(html);
  const toggles: Array<{ label: string; checked: boolean }> = [];
  $('[role="switch"]').each((_index, element) => {
    const parentText = $(element).parent().text();
    toggles.push({
      label: clean(parentText.split("\n")[0] ?? ""),
      checked: `${$(element).attr("aria-checked")}`.toLowerCase() === "true",
    });
  });
  return { text: $("body").text().replace(/\r/g, "\n"), toggles };
}
function toggle(
  toggles: Array<{ label: string; checked: boolean }>,
  ...needles: string[]
): boolean | null {
  const found = toggles.find((item) =>
    needles.every((needle) => item.label.toLowerCase().includes(needle)),
  );
  return found?.checked ?? null;
}
async function pageHtml(
  url: string,
  session?: string | null,
  media?: string | null,
  options: { claude?: boolean; contentSelector?: string } = {},
): Promise<string> {
  if (options.claude && url.includes("claude.ai/settings/"))
    await warmClaudeSession(session, media);
  await openPage(url, session, media, options.contentSelector);
  return browserEvalString(
    "document.documentElement.outerHTML",
    session,
    "Failed to extract billing page HTML",
  );
}
function result<T extends { toMarkdown(): string }>(html: string, structured: T): ScrapeResult<T> {
  return { full_html: html, selected_html: "", markdown: structured.toMarkdown(), structured };
}

export async function scrapeAnthropicBilling(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<AnthropicBilling>> {
  const html = options.html ?? (await pageHtml(url, options.session, options.media));
  const { text, toggles } = textAndToggles(html);
  const lowered = text.toLowerCase();
  if (lowered.includes("log in") && lowered.includes("continue with google")) {
    throw new AgentscrapeAuthError(
      "Anthropic billing authentication required - browser is not signed in",
    );
  }
  const balance = money(
    capture(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*Remaining Balance/is, text) ||
      capture(/Remaining Balance\s*[:-]?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/is, text),
  );
  if (balance === null) {
    throw new PresetDriftError(
      "Anthropic billing page missing required remaining-balance landmark",
    );
  }
  let organization = capture(/Organization(?:\s+name)?\s*[:\n]\s*([^\n]+)/is, text);
  if (!organization)
    organization =
      text
        .split(/\n+/)
        .map(clean)
        .find(
          (line) =>
            line.length > 1 &&
            !/organization|billing|remaining balance|charged to|auto reload|settings|^\$?\d/i.test(
              line,
            ),
        ) ?? "";
  const explicit = capture(
    /Auto\s*reload(?:\s+is)?\s*(enabled|disabled|on|off|true|false)/is,
    text,
  ).toLowerCase();
  const schema = new AnthropicBilling(
    organization,
    balance,
    explicit ? ["enabled", "on", "true"].includes(explicit) : toggle(toggles, "auto", "reload"),
  );
  return result(html, schema);
}

function requireOpenAiAuth(text: string, url: string): void {
  const lower = text.toLowerCase();
  if (
    ["authentication required", "please log in to access this page"].every((x) =>
      lower.includes(x),
    ) ||
    [
      "build on the openai api platform",
      "sign up or login with an openai account",
      "continue with google",
    ].every((x) => lower.includes(x)) ||
    url.includes("/login")
  )
    throw new AgentscrapeAuthError(
      "OpenAI billing authentication required - browser is not signed in",
    );
}
export async function scrapeOpenAiBilling(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<OpenAIBilling>> {
  const html = options.html ?? (await pageHtml(url, options.session, options.media));
  const { text, toggles } = textAndToggles(html);
  requireOpenAiAuth(text, url);
  const plan =
    capture(/\b(Pay as you go|Prepaid|Enterprise|Custom|Free trial)\b/is, text) ||
    capture(/Plan(?: type)?\s*[:-]?\s*([^\n]+)/is, text);
  let organization = capture(/Organization(?:\s+name)?\s*[:\n]\s*([^\n]+)/is, text);
  if (!organization)
    organization =
      text
        .split(/\n+/)
        .map(clean)
        .find(
          (line) =>
            line.length > 1 &&
            line.toLowerCase() !== plan.toLowerCase() &&
            !/billing|credit balance|auto recharge|overview|settings|^\$?\d/i.test(line),
        ) ?? "";
  let balance = money(
    capture(/Credit balance(?:\s*\([^)]*\))?\s*[:-]?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/is, text),
  );
  if (balance === null)
    balance = money(
      capture(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*(?:remaining\s*)?(?:credit balance|balance)/is, text),
    );
  if (balance === null) {
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    const index = lines.findIndex(
      (line) =>
        /credit balance/i.test(line) ||
        ["balance", "current balance", "remaining balance"].includes(line.toLowerCase()),
    );
    if (index >= 0) {
      for (const line of lines.slice(index, index + 5)) {
        const candidate = money(line);
        if (candidate !== null) {
          balance = candidate;
          break;
        }
      }
    }
  }
  if (balance === null) {
    throw new PresetDriftError("OpenAI billing page missing required credit-balance landmark");
  }
  const explicit = capture(
    /Auto\s*recharge(?:\s+is)?\s*(on|off|enabled|disabled|true|false)/is,
    text,
  ).toLowerCase();
  return result(
    html,
    new OpenAIBilling(
      organization,
      plan,
      balance,
      explicit ? ["on", "enabled", "true"].includes(explicit) : toggle(toggles, "auto", "recharge"),
    ),
  );
}

export function resolvePerplexityBillingUrl(current: string): string {
  if (/^https:\/\/console\.perplexity\.ai\/group\/[^/]+\/billing(?:[/?#].*)?$/i.test(current))
    return current;
  const match = current.match(
    /^(https:\/\/console\.perplexity\.ai\/group\/[^/]+)\/settings(?:[/?#].*)?$/i,
  );
  return match ? `${match[1]}/billing` : "";
}
export async function scrapePerplexityBilling(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<PerplexityBilling>> {
  let html = options.html;
  if (html === undefined || html === null) {
    await openPage(url, options.session, options.media);
    const current = await browserEvalString(
      "window.location.href",
      options.session,
      "Failed to get Perplexity billing URL",
    );
    const billing = resolvePerplexityBillingUrl(current);
    if (billing && billing !== current) await openPage(billing, options.session, options.media);
    html = await browserEvalString(
      "document.documentElement.outerHTML",
      options.session,
      "Failed to extract Perplexity billing page HTML",
    );
  }
  const { text, toggles } = textAndToggles(html);
  if (
    ["sign in or create an account", "continue with email"].every((x) =>
      text.toLowerCase().includes(x),
    )
  )
    throw new AgentscrapeAuthError(
      "Perplexity billing authentication required - browser is not signed in",
    );
  const raw =
    capture(/(\$\s*\d[\d,]*(?:\.\d+)?\s*remaining)/is, text) ||
    capture(/Credit balance\s*[:-]?\s*([^\n]+)/is, text);
  const balance = money(raw);
  if (balance === null) {
    throw new PresetDriftError("Perplexity billing page missing required credit-balance landmark");
  }
  const tier = capture(/Usage tier\s*[:-]?\s*([0-9]+)/is, text);
  const explicit = capture(
    /Auto\s*reload\s*[:-]?\s*(enabled|disabled|on|off|true|false)/is,
    text,
  ).toLowerCase();
  return result(
    html,
    new PerplexityBilling(
      balance,
      tier ? Number(tier) : 0,
      explicit ? ["enabled", "on", "true"].includes(explicit) : toggle(toggles, "auto", "reload"),
    ),
  );
}

function section(text: string, start: RegExp, ends: RegExp[]): string {
  const startMatch = start.exec(text);
  if (!startMatch) return "";
  const rest = text.slice(startMatch.index + startMatch[0].length);
  const boundaries = ends
    .map((pattern) => pattern.exec(rest)?.index)
    .filter((x): x is number => x !== undefined);
  return rest.slice(0, boundaries.length ? Math.min(...boundaries) : undefined);
}
function resetSeconds(text: string, now = new Date()): number | null {
  const payload = capture(/(Resets[^\n]*)/is, text).replace(/^Resets\s*/i, "");
  if (!payload) return null;
  if (payload.startsWith("in ")) {
    let total = 0;
    for (const match of payload.matchAll(
      /(\d+)\s*(day|days|hr|hrs|hour|hours|min|mins|minute|minutes)/gi,
    )) {
      const amount = Number(match[1]);
      total += match[2]!.toLowerCase().startsWith("day")
        ? amount * 86400
        : match[2]!.toLowerCase().startsWith("h")
          ? amount * 3600
          : amount * 60;
    }
    return total || null;
  }
  const time = payload.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (time) {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    let hour = (Number(time[2]) % 12) + (time[4]!.toUpperCase() === "PM" ? 12 : 0);
    if (!Number.isFinite(hour)) hour = 0;
    let ahead = (days.indexOf(time[1]!.slice(0, 3).toLowerCase()) - now.getDay() + 7) % 7;
    const target = new Date(now);
    target.setHours(hour, Number(time[3]), 0, 0);
    if (ahead === 0 && target <= now) ahead = 7;
    target.setDate(target.getDate() + ahead);
    return Math.floor((target.getTime() - now.getTime()) / 1000);
  }
  const parsed = Date.parse(payload);
  return Number.isFinite(parsed) && parsed >= now.getTime()
    ? Math.floor((parsed - now.getTime()) / 1000)
    : null;
}
function ratio(text: string, remaining = false): number | null {
  const value = capture(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s*${remaining ? "remaining" : "used"}`, "is"),
    text,
  );
  return value ? Number(value) / 100 : null;
}
export async function scrapeClaudeUsage(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<ClaudeUsage>> {
  const html =
    options.html ??
    (await pageHtml(url, options.session, options.media, {
      claude: true,
      contentSelector: CLAUDE_APP_READY_SELECTOR,
    }));
  const { text, toggles } = textAndToggles(html);
  const lower = text.toLowerCase();
  if (
    ["continue with google", "continue with email", "meet claude"].every((x) =>
      lower.includes(x),
    ) &&
    !["current balance", "current session", "weekly limits", "monthly spend"].some((x) =>
      lower.includes(x),
    )
  )
    throw new AgentscrapeAuthError(
      "Claude usage authentication required - browser is not signed in",
    );
  const ends = [
    /Weekly limits?/i,
    /All models/i,
    /Extra usage/i,
    /Monthly spending limit/i,
    /Current balance/i,
    /Auto[-\s]?reload/i,
  ];
  const current = section(text, /Current session/i, ends);
  const allModels = section(text, /All models/i, [/Sonnet(?: only)?/i, ...ends.slice(2)]);
  const sonnet = section(text, /Sonnet(?: only)?/i, ends.slice(2));
  const extra = section(text, /Extra usage/i, ends.slice(3));
  const monthly =
    /Unlimited\s*Monthly spend limit|Monthly spend(?:ing)? limit\s*[:-]?\s*Unlimited/i.test(text)
      ? 0
      : (money(
          capture(/Monthly spend(?:ing)? limit\s*[:-]?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/is, text),
        ) ?? 0);
  const schema = new ClaudeUsage({
    current_session_pct: ratio(current),
    current_session_reset: resetSeconds(current),
    weekly_all_models_pct: ratio(allModels),
    weekly_all_models_reset: resetSeconds(allModels),
    weekly_sonnet_pct: ratio(sonnet),
    weekly_sonnet_reset: resetSeconds(sonnet),
    extra_usage_enabled: toggle(toggles, "extra") ?? false,
    extra_usage_spent: money(capture(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*spent/is, extra || text)) ?? 0,
    extra_usage_reset: resetSeconds(extra),
    monthly_spending_limit: monthly,
    current_balance:
      money(
        capture(/Current balance\s*[:-]?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/is, text) ||
          capture(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*Current balance/is, text),
      ) ?? 0,
    auto_reload: toggle(toggles, "auto") ?? false,
  });
  return result(html, schema);
}

export async function scrapeClaudeBilling(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<ClaudeBilling>> {
  const html =
    options.html ??
    (await pageHtml(url, options.session, options.media, {
      claude: true,
      contentSelector: CLAUDE_APP_READY_SELECTOR,
    }));
  const { text } = textAndToggles(html);
  if (
    ["continue with google", "continue with email", "meet claude"].every((x) =>
      text.toLowerCase().includes(x),
    )
  )
    throw new AgentscrapeAuthError(
      "Claude billing authentication required - browser is not signed in",
    );
  const $ = cheerio.load(html);
  const rows: string[][] = [];
  $("table tr").each((_index, row) => {
    rows.push(
      $(row)
        .find("th,td")
        .map((_i, cell) => clean($(cell).text()))
        .get(),
    );
  });
  let headers: Record<string, number> = {};
  const invoices = rows.flatMap((row) => {
    const lowerRow = row.map((x) => x.toLowerCase());
    if (lowerRow.includes("date") && lowerRow.includes("total") && lowerRow.includes("status")) {
      headers = Object.fromEntries(lowerRow.map((x, i) => [x, i]));
      return [];
    }
    if (!row.length) return [];
    const due = headers.due;
    const totalIndex = headers.total ?? (due !== undefined ? 2 : 1);
    const statusIndex = headers.status ?? (due !== undefined ? 3 : 2);
    return [
      {
        date: row[headers.date ?? 0] ?? "",
        due: due === undefined ? "" : (row[due] ?? ""),
        total: money(row[totalIndex] ?? ""),
        status: row[statusIndex] ?? "",
      },
    ];
  });
  if (
    !/\b(free|pro|max|team|enterprise)\b/i.test(text) &&
    !/current balance|invoices/i.test(text) &&
    rows.length === 0
  ) {
    throw new PresetDriftError(
      "Claude billing page missing required plan/balance/invoice landmark",
    );
  }
  const plan = capture(/\b((?:Pro|Max)(?:\s+plan)?)\b/is, text);
  const multiplier = capture(/\b(5x|20x)\s+more usage than Pro\b/is, text);
  const autoSection = section(text, /Auto[-\s]?reload/i, [
    /Invoices/i,
    /Cancellation/i,
  ]).toLowerCase();
  const auto = autoSection.includes("turn off")
    ? true
    : autoSection.includes("turn on")
      ? false
      : null;
  return result(
    html,
    new ClaudeBilling({
      plan_label: plan,
      current_plan: multiplier
        ? Number(multiplier.replace("x", ""))
        : /pro/i.test(plan || text)
          ? 1
          : 0,
      plan_details: multiplier ? `${multiplier} more usage than Pro` : "",
      renews_on: capture(/auto renew on ([^.]+)/is, text),
      current_balance: money(
        capture(/Current balance\s*[:-]?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/is, text) ||
          capture(/(\$\s*\d[\d,]*(?:\.\d+)?)\s*Current balance/is, text),
      ),
      auto_reload: auto,
      invoices,
    }),
  );
}

export async function scrapeCodexUsage(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<CodexUsage>> {
  const html = options.html ?? (await pageHtml(url, options.session, options.media));
  const { text } = textAndToggles(html);
  const lower = text.toLowerCase();
  if (
    [
      "choose an account to continue.",
      "log in to another account",
      "verify your identity",
      "enter your password",
      "log in to get answers based on saved chats",
      "get responses tailored to you",
    ].some((x) => lower.includes(x))
  )
    throw new AgentscrapeAuthError(
      "ChatGPT Codex authentication required - browser is not signed in",
    );
  const five = section(text, /5\s*hour usage limit/i, [
    /Weekly usage limit/i,
    /Code review/i,
    /Credits remaining/i,
  ]);
  const weekly = section(text, /Weekly usage limit/i, [/Code review/i, /Credits remaining/i]);
  const review = section(text, /Code review/i, [/Credits remaining/i]);
  const schema = new CodexUsage({
    plan: ["TEAM", "PRO", "PLUS"].find((plan) => new RegExp(`\\b${plan}\\b`, "i").test(text)) ?? "",
    five_hour_remaining_pct: ratio(five, true),
    five_hour_reset: resetSeconds(five),
    weekly_remaining_pct: ratio(weekly, true),
    weekly_reset: resetSeconds(weekly),
    code_review_remaining_pct: ratio(review, true),
    credits_remaining:
      Number(
        capture(/Credits remaining\s*[:-]?\s*([0-9][0-9,]*(?:\.\d+)?)/is, text).replaceAll(",", ""),
      ) || null,
  });
  if (
    schema.five_hour_remaining_pct === null &&
    schema.weekly_remaining_pct === null &&
    schema.code_review_remaining_pct === null
  )
    throw new PresetDriftError("Codex usage page missing required quota landmarks");
  return result(html, schema);
}

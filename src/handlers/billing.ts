import * as cheerio from "cheerio";
import { CLAUDE_APP_READY_SELECTOR, openPage, warmClaudeSession } from "../browser";
import { browserEvalString } from "../browser-eval";
import { AgentscrapeAuthError, PresetDriftError } from "../errors";
import { AnthropicBilling, ClaudeBilling, OpenAIBilling, PerplexityBilling } from "../schemas";
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

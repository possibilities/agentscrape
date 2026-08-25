import * as cheerio from "cheerio";
import {
  currentBrowserArtifactRetention,
  openPage,
  requireAgentBrowserSuccess,
  runAgentBrowser,
} from "./browser";
import { decodeBrowserEval, decodeBrowserEvalString } from "./browser-eval";
import { cssSelectorProblem } from "./css-selector";
import { AgentscrapeBrowserError, AgentscrapeUsageError } from "./errors";
import type { HandlerOptions, ScrapeResult } from "./handlers/types";
import { convertHtml } from "./html";
import { GenericPage } from "./schemas";

function browserText(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "string" ? parsed : stdout;
  } catch {
    return stdout;
  }
}

export async function detectContentSelector(options: HandlerOptions = {}): Promise<string> {
  const code = `(() => {
    const hasText = (el) => !!el?.innerText && el.innerText.trim().length > 50;
    const mains = [...document.querySelectorAll("main")];
    if (mains.length === 1 && hasText(mains[0])) return "main";
    if (mains.length > 1) {
      const ancestors = (el) => { const out=[]; while (el.parentElement) { el=el.parentElement; out.push(el); } return out; };
      const all = mains.map(ancestors);
      for (const candidate of all[0]) {
        if (candidate === document.body) break;
        if (!all.every((items) => items.includes(candidate))) continue;
        if (candidate.id && document.querySelectorAll("#" + CSS.escape(candidate.id)).length === 1) return "#" + CSS.escape(candidate.id);
        const parts=[]; let el=candidate;
        while (el && el !== document.body && el !== document.documentElement) {
          const siblings=[...(el.parentElement?.children || [])].filter((item) => item.tagName === el.tagName);
          let part=el.tagName.toLowerCase();
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(el)+1) + ")";
          parts.unshift(part); el=el.parentElement;
        }
        const selector=parts.join(" > ");
        if (selector && document.querySelectorAll(selector).length === 1) return selector;
      }
    }
    const articles=[...document.querySelectorAll("article")];
    if (articles.length === 1 && hasText(articles[0])) return "article";
    return "body";
  })()`;
  const result = await runAgentBrowser(["eval", code], options.session);
  // Selector auto-detection is intentionally best-effort; body is the documented fallback.
  return result.exitCode === 0
    ? browserText(result.stdout).trim().replace(/^"|"$/g, "") || "body"
    : "body";
}

export async function scrapePage(
  url: string,
  selector: string | undefined = undefined,
  options: HandlerOptions = {},
): Promise<ScrapeResult<GenericPage>> {
  const callerSelector = selector !== undefined;
  const defaultedSelector = selector ?? "body";
  const selectorProblem = cssSelectorProblem(defaultedSelector);
  if (selectorProblem)
    throw new AgentscrapeUsageError(`Invalid selector '${defaultedSelector}': ${selectorProblem}`);
  await openPage(url, options.session, options.media);
  const chosen = callerSelector ? defaultedSelector : await detectContentSelector(options);
  const selection = await runAgentBrowser(
    [
      "eval",
      `(() => { const items=document.querySelectorAll(${JSON.stringify(chosen)}); if(items.length!==1) return {error:items.length===0?"no_match":"multiple_match",count:items.length}; return {html:items[0].outerHTML}; })()`,
    ],
    options.session,
  );
  requireAgentBrowserSuccess(selection, "Failed to query selector");
  const decoded = decodeBrowserEval(selection.stdout, "Failed to query selector");
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new AgentscrapeBrowserError("Failed to query selector: invalid eval result");
  const value = decoded as { error?: unknown; count?: unknown; html?: unknown };
  if (value.error === "no_match") {
    if (value.count !== 0)
      throw new AgentscrapeBrowserError("Failed to query selector: invalid eval result");
    const error = `Selector '${chosen}' matched no elements`;
    throw callerSelector ? new AgentscrapeUsageError(error) : new AgentscrapeBrowserError(error);
  }
  if (value.error === "multiple_match") {
    if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 2)
      throw new AgentscrapeBrowserError("Failed to query selector: invalid eval result");
    const error = `Selector '${chosen}' matched ${value.count} elements, expected exactly 1`;
    throw callerSelector ? new AgentscrapeUsageError(error) : new AgentscrapeBrowserError(error);
  }
  if (typeof value.html !== "string")
    throw new AgentscrapeBrowserError("Failed to query selector: invalid eval result");
  const selectedHtml = value.html;
  let fullHtml = "";
  if (currentBrowserArtifactRetention()) {
    const full = await runAgentBrowser(
      ["eval", "document.documentElement.outerHTML"],
      options.session,
    );
    requireAgentBrowserSuccess(full, "Failed to get page HTML");
    fullHtml = decodeBrowserEvalString(full.stdout, "Failed to get page HTML");
  }
  const $ = cheerio.load(selectedHtml);
  $("script,style,noscript,svg,iframe,button").remove();
  const markdown = convertHtml($.html());
  const structured = new GenericPage(url, markdown);
  return {
    full_html: fullHtml,
    selected_html: selectedHtml,
    markdown: structured.toMarkdown(),
    structured,
  };
}

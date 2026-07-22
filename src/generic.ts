import * as cheerio from "cheerio";
import { openPage, runAgentBrowser } from "./browser";
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
  return result.exitCode === 0
    ? browserText(result.stdout).trim().replace(/^"|"$/g, "") || "body"
    : "body";
}

export async function scrapePage(
  url: string,
  selector = "body",
  options: HandlerOptions = {},
): Promise<ScrapeResult<GenericPage>> {
  await openPage(url, options.session, options.media);
  const chosen = selector === "body" ? await detectContentSelector(options) : selector;
  const full = await runAgentBrowser(
    ["eval", "document.documentElement.outerHTML"],
    options.session,
  );
  if (full.exitCode !== 0) throw new Error(`Failed to get page HTML: ${full.stderr}`);
  const selection = await runAgentBrowser(
    [
      "eval",
      `(() => { const items=document.querySelectorAll(${JSON.stringify(chosen)}); if(items.length!==1) return {error:items.length===0?"no_match":"multiple_match",count:items.length}; return {html:items[0].outerHTML}; })()`,
    ],
    options.session,
  );
  if (selection.exitCode !== 0) throw new Error(`Failed to query selector: ${selection.stderr}`);
  let value: { error?: string; count?: number; html?: string };
  try {
    value = JSON.parse(selection.stdout) as typeof value;
    if (typeof value === "string") value = JSON.parse(value) as typeof value;
  } catch {
    value = { html: selection.stdout };
  }
  if (value.error === "no_match") throw new Error(`Selector '${chosen}' matched no elements`);
  if (value.error === "multiple_match")
    throw new Error(`Selector '${chosen}' matched ${value.count} elements, expected exactly 1`);
  const selectedHtml = value.html ?? "";
  const $ = cheerio.load(selectedHtml);
  $("script,style,noscript,svg,iframe,button").remove();
  const markdown = convertHtml($.html());
  const structured = new GenericPage(url, markdown);
  return {
    full_html: browserText(full.stdout),
    selected_html: selectedHtml,
    markdown: structured.toMarkdown(),
    structured,
  };
}

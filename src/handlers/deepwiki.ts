import * as cheerio from "cheerio";
import { openPage, runAgentBrowser } from "../browser";
import { browserEvalString } from "../browser-eval";
import { AgentscrapeAuthError, AgentscrapeRuntimeError, PresetDriftError } from "../errors";
import { renderRichMarkdown, safeLink } from "../html";
import {
  DeepWikiCitation,
  DeepWikiQARound,
  DeepWikiSearchConversation,
  DeepWikiWikiPage,
} from "../schemas";
import type { HandlerOptions, ScrapeResult } from "./types";

const WIKI_ROOT = "codebase-wiki-repo-page";
const SEARCH_ROOT = "deepwiki-search-conversation";
function repoFromUrl(url: string): string {
  const match = url.match(/deepwiki\.com\/(?!search\/)([^/]+)\/([^/?#]+)/);
  return match ? `${match[1]}/${match[2]}` : "";
}
function citation(href: string, label: string, baseUrl: string, context: string): DeepWikiCitation {
  const target = safeLink(href, baseUrl);
  if (!target) throw new PresetDriftError(`${context}: citation target has an unsafe URL`);
  const url = new URL(target);
  const blob = url.pathname.match(/\/blob\/[^/]+\/([^#?]+)/);
  const range = url.hash.slice(1).match(/^L(\d+)(?:-L(\d+))?$/);
  const start = range ? Number(range[1]) : null;
  const end = range ? Number(range[2] ?? range[1]) : null;
  if (start !== null && end !== null && end < start)
    throw new PresetDriftError(`${context}: citation line range is inverted (L${start}-L${end})`);
  return new DeepWikiCitation({
    label: label.trim() || href,
    target_url: target,
    repo_path: blob ? decodeURIComponent(blob[1]!) : "",
    line_start: start,
    line_end: end,
  });
}
function citations(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  selector: string,
  url: string,
  context: string,
): DeepWikiCitation[] {
  const result: DeepWikiCitation[] = [];
  root
    .find(selector)
    .first()
    .find("a[href]")
    .each((_index, anchor) => {
      result.push(citation($(anchor).attr("href")!, $(anchor).text(), url, context));
    });
  return result;
}
function parseWiki(html: string, url: string): DeepWikiWikiPage {
  const $ = cheerio.load(html);
  if ($('[data-testid="wiki-auth-required"]').length)
    throw new AgentscrapeAuthError("DeepWiki wiki page requires authentication");
  if ($('[data-testid="wiki-loading-state"]').length)
    throw new AgentscrapeRuntimeError(
      "DeepWiki wiki page did not finish loading: timed out waiting",
    );
  const roots = $(`#${WIKI_ROOT}`);
  if (roots.length !== 1)
    throw new PresetDriftError(`expected exactly one #${WIKI_ROOT} root, found ${roots.length}`);
  const root = roots.first();
  const contents = root.find('[data-testid="wiki-page-content"]');
  if (contents.length !== 1)
    throw new PresetDriftError(
      `expected exactly one [data-testid=wiki-page-content] subtree, found ${contents.length}`,
    );
  const title = root
    .find('[data-testid="wiki-page-title"]')
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();
  if (!title)
    throw new PresetDriftError("[data-testid=wiki-page-title] title root missing or empty");
  const repository =
    root.find('[data-testid="wiki-repo-breadcrumb"]').first().text().replace(/\s+/g, " ").trim() ||
    repoFromUrl(url);
  const markdown = renderRichMarkdown($.html(contents.first()), { baseUrl: url });
  if (!markdown.trim())
    throw new PresetDriftError("[data-testid=wiki-page-content] content rendered no Markdown");
  return new DeepWikiWikiPage({
    url,
    repository,
    title,
    markdown,
    citations: citations($, root, '[data-testid="wiki-page-citations"]', url, "wiki page"),
  });
}
function parseSearch(html: string, url: string): DeepWikiSearchConversation {
  const $ = cheerio.load(html);
  if ($('[data-testid="search-auth-required"]').length)
    throw new AgentscrapeAuthError("DeepWiki search conversation requires authentication");
  if ($('[data-testid="search-loading-shell"]').length)
    throw new AgentscrapeRuntimeError(
      "DeepWiki search conversation did not finish loading: timed out waiting",
    );
  const roots = $(`[data-testid="${SEARCH_ROOT}"]`);
  if (roots.length !== 1)
    throw new PresetDriftError(
      `expected exactly one [data-testid=${SEARCH_ROOT}] root, found ${roots.length}`,
    );
  const root = roots.first();
  const elements = root.find('[data-testid="search-qa-round"]');
  if (!elements.length)
    throw new PresetDriftError("DeepWiki search conversation has no Q&A rounds");
  const rounds: DeepWikiQARound[] = [];
  elements.each((index, element) => {
    const round = $(element);
    if (round.find('[data-testid="search-round-generating"]').length)
      throw new AgentscrapeRuntimeError(
        "DeepWiki search conversation has not reached a terminal state: timed out waiting for a round to finish generating",
      );
    round.find('[data-testid="search-source-preview"]').remove();
    const question = round
      .find('[data-testid="search-question"]')
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const answer = round.find('[data-testid="search-answer"]').first();
    const context = `search conversation round ${index + 1}`;
    const markdown = answer.length ? renderRichMarkdown($.html(answer), { baseUrl: url }) : "";
    if (!question || !markdown.trim())
      throw new PresetDriftError(`${context} is incomplete (missing question or answer content)`);
    rounds.push(
      new DeepWikiQARound({
        question,
        answer: markdown,
        citations: citations($, round, '[data-testid="search-citations"]', url, context),
      }),
    );
  });
  const repository =
    root
      .find('[data-testid="search-repo-breadcrumb"]')
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || repoFromUrl(url);
  return new DeepWikiSearchConversation({ url, repository, rounds });
}
async function liveHtml(
  url: string,
  options: HandlerOptions,
  selector: string,
  terminal = false,
): Promise<string> {
  await openPage(url, options.session, options.media, selector);
  let html = "";
  for (let attempt = 0; attempt < (terminal ? 30 : 1); attempt += 1) {
    html = await browserEvalString(
      "document.documentElement.outerHTML",
      options.session,
      "Failed to get DeepWiki page HTML",
    );
    if (!terminal || !cheerio.load(html)('[data-testid="search-round-generating"]').length)
      return html;
    await runAgentBrowser(["wait", "2000"], options.session);
  }
  throw new AgentscrapeRuntimeError(
    "DeepWiki search conversation did not reach a terminal state: timed out waiting",
  );
}
export async function scrapeWikiPage(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<DeepWikiWikiPage>> {
  const html = options.html ?? (await liveHtml(url, options, `#${WIKI_ROOT}`));
  const structured = parseWiki(html, url);
  return { full_html: html, selected_html: "", markdown: structured.toMarkdown(), structured };
}
export async function scrapeSearchConversation(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<DeepWikiSearchConversation>> {
  const html =
    options.html ?? (await liveHtml(url, options, `[data-testid="${SEARCH_ROOT}"]`, true));
  const structured = parseSearch(html, url);
  return { full_html: html, selected_html: "", markdown: structured.toMarkdown(), structured };
}
export { parseSearch as parseDeepWikiSearch, parseWiki as parseDeepWikiWiki };

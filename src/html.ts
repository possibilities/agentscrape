import * as cheerio from "cheerio";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { PresetDriftError } from "./errors";

const DROP = "script,style,noscript,svg,iframe";

export function convertHtml(html: string): string {
  const $ = cheerio.load(html);
  $(DROP).remove();
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return service.turndown($.html()).replace(/\n{3,}/g, "\n\n");
}
export function safeLink(href: string | undefined, baseUrl = ""): string | null {
  const value = (href ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl || undefined);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Semantic HTML serializer with adaptive code fences and round-trip verification. */
export function renderRichMarkdown(
  html: string,
  options: { baseUrl?: string; fenceLanguage?: boolean; sanitizeLinks?: boolean } = {},
): string {
  const $ = cheerio.load(html, null, false);
  if (options.sanitizeLinks !== false) {
    $("a[href]").each((_index, element) => {
      const link = safeLink($(element).attr("href"), options.baseUrl ?? "");
      if (link) $(element).attr("href", link);
      else $(element).replaceWith($(element).contents());
    });
  }
  const expected: string[] = [];
  const blocks = new Map<string, string>();
  $("pre")
    .filter((_index, element) => $(element).parents("pre").length === 0)
    .each((index, element) => {
      const codeElement = $(element).find("code").first();
      const source = codeElement.length ? codeElement : $(element);
      const code = source.text().replace(/^\n+|\n+$/g, "");
      let language = "";
      for (const className of `${source.attr("class") ?? ""} ${$(element).attr("class") ?? ""}`.split(
        /\s+/,
      )) {
        const match = className.match(/^(?:lang(?:uage)?)-([\w+.-]+)$/);
        if (match) language = match[1]!;
      }
      expected.push(code);
      const fence = fenceFor(code);
      const token = `AGENTSCRAPECODEBLOCK${index}MARKER`;
      blocks.set(
        token,
        `${fence}${options.fenceLanguage === false ? "" : language}\n${code}\n${fence}`,
      );
      $(element).replaceWith(`<p>${token}</p>`);
    });
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    bulletListMarker: "*",
  });
  let markdown = service
    .turndown($.html() ?? "")
    .replace(/^(\s*)[*+-]\s{3}/gm, "$1* ")
    .replace(/\n[ \t]+\n(?=\s*[*+-] )/g, "\n")
    .replace(/\n {4}\n/g, "\n\n")
    .replace(/^ {4}(?=\S)/gm, "  ")
    .replace(/\n{3,}/g, "\n\n");
  for (const [token, block] of blocks) markdown = markdown.replace(token, block);
  markdown = markdown.replace(/[ \t]+$/gm, "").trim();
  const tokens = new MarkdownIt("commonmark").parse(markdown, {});
  const actual = tokens
    .filter((token) => token.type === "fence")
    .map((token) => token.content.replace(/\n$/, ""));
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new PresetDriftError("rendered markdown code block content diverged from source");
  }
  return markdown;
}

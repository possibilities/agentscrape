import * as cheerio from "cheerio";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { PresetDriftError } from "./errors";

const DROP = "script,style,noscript,svg,iframe";
const FORBIDDEN_LINK_CHAR = /[\p{White_Space}\p{Cc}\p{Cf}\\<>"'`]/u;
const MALFORMED_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HTTP_SCHEME = /^https?:/i;
const CREDENTIAL_MARKER = /^https?:(?:\/\/?)?[^/?#]*@/i;
const MAX_CLASSIFICATION_DECODES = 6;

function invalidClassifiedLink(value: string, originallyAbsolute: boolean): boolean {
  return (
    FORBIDDEN_LINK_CHAR.test(value) ||
    MALFORMED_PERCENT.test(value) ||
    value.startsWith("//") ||
    CREDENTIAL_MARKER.test(value) ||
    (!originallyAbsolute && SCHEME.test(value)) ||
    (originallyAbsolute && SCHEME.test(value) && !HTTP_SCHEME.test(value))
  );
}

function decodeHtmlEntities(value: string): string {
  const $ = cheerio.load("<span></span>", null, false);
  return $("span").html(value).text();
}

function classifiedLink(value: string): { absolute: boolean; valid: boolean } {
  const absolute = SCHEME.test(value);
  if (invalidClassifiedLink(value, absolute)) return { absolute, valid: false };

  let copy = value;
  for (let count = 0; count < MAX_CLASSIFICATION_DECODES; count += 1) {
    let decoded = copy;
    if (decoded.includes("%")) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        return { absolute, valid: false };
      }
    }
    if (invalidClassifiedLink(decoded, absolute)) return { absolute, valid: false };
    if (decoded.includes("&")) decoded = decodeHtmlEntities(decoded);
    if (invalidClassifiedLink(decoded, absolute)) return { absolute, valid: false };
    if (decoded === copy) return { absolute, valid: true };
    copy = decoded;
  }
  return { absolute, valid: false };
}

export function safeLink(href: string | undefined, baseUrl = ""): string | null {
  const value = (href ?? "").trim();
  if (!value) return null;
  const classification = classifiedLink(value);
  if (!classification.valid) return null;

  if (!classification.absolute && !baseUrl) return value;
  try {
    let base: URL | undefined;
    if (baseUrl) {
      const baseValue = baseUrl.trim();
      const baseClassification = classifiedLink(baseValue);
      if (!baseClassification.valid || !baseClassification.absolute) return null;
      base = new URL(baseValue);
      if (!HTTP_SCHEME.test(base.protocol) || base.username || base.password) return null;
    }
    const url = new URL(value, base);
    if (!HTTP_SCHEME.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function markdownLink(label: string, destination: string | undefined, baseUrl = ""): string {
  const escapedLabel = label.replace(/\r\n?|\n|\u2028|\u2029/g, " ").replace(/[\\[\]]/g, "\\$&");
  const link = safeLink(destination, baseUrl);
  return link ? `[${escapedLabel}](${link.replace(/[()]/g, "\\$&")})` : escapedLabel;
}

function plainMarkdownText(value: string): string {
  return value
    .replace(/\r\n?|\n|\u2028|\u2029/g, " ")
    .replace(/[!-/:-@[-`{-~]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function sanitizeDestinations($: cheerio.CheerioAPI, baseUrl = ""): void {
  $(DROP).remove();
  $("a[href]").each((_index, element) => {
    const link = safeLink($(element).attr("href"), baseUrl);
    if (link) $(element).attr("href", link);
    else $(element).replaceWith($(element).contents());
  });
  $("img").each((_index, element) => {
    const link = safeLink($(element).attr("src"), baseUrl);
    if (link) {
      $(element).attr("src", link);
      return;
    }
    const alt = $(element).attr("alt");
    if (alt) $(element).replaceWith($("<span>").text(plainMarkdownText(alt)).contents());
    else $(element).remove();
  });
}

export function convertHtml(html: string): string {
  const $ = cheerio.load(html);
  sanitizeDestinations($);
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return service.turndown($.html()).replace(/\n{3,}/g, "\n\n");
}
const SAFE_FENCE_INFO = /^[A-Za-z0-9_+.-]{1,64}$/;

/** Build a Markdown code block whose fence cannot collide with its content. */
export function fencedCodeBlock(code: string, language = ""): string {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  const info = SAFE_FENCE_INFO.test(language) ? language : "";
  return `${fence}${info}\n${code}${code && !code.endsWith("\n") ? "\n" : ""}${fence}`;
}

/** Semantic HTML serializer with adaptive code fences and round-trip verification. */
export function renderRichMarkdown(
  html: string,
  options: { baseUrl?: string; fenceLanguage?: boolean } = {},
): string {
  const $ = cheerio.load(html, null, false);
  sanitizeDestinations($, options.baseUrl ?? "");
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
      const token = `AGENTSCRAPECODEBLOCK${index}MARKER`;
      blocks.set(token, fencedCodeBlock(code, options.fenceLanguage === false ? "" : language));
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

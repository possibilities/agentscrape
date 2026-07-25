import * as cheerio from "cheerio";
import { openPage } from "../browser";
import { browserEvalString } from "../browser-eval";
import { PresetDriftError } from "../errors";
import { renderRichMarkdown } from "../html";
import { ChatGPTConversation, ConversationTurn } from "../schemas";
import type { HandlerOptions, ScrapeResult } from "./types";

export function isChatGptUrl(url: string): boolean {
  return /^https?:\/\/chatgpt\.com\/(?:c|share)\//.test(url);
}
export async function scrapeConversation(
  url: string,
  options: HandlerOptions = {},
): Promise<ScrapeResult<ChatGPTConversation>> {
  let html = options.html ?? null;
  if (html === null) {
    await openPage(url, options.session, options.media, "article[data-turn-id]");
    html = await browserEvalString(
      "document.documentElement.outerHTML",
      options.session,
      "Failed to extract conversation",
    );
  }
  const $ = cheerio.load(html);
  const turns: ConversationTurn[] = [];
  $("article[data-turn-id]").each((_index, article) => {
    const element = $(article).find(".markdown").first().length
      ? $(article).find(".markdown").first()
      : $(article).find(".whitespace-pre-wrap").first();
    if (!element.length) return;
    const role = $(article).attr("data-turn") ?? "unknown";
    turns.push(
      new ConversationTurn(
        role,
        renderRichMarkdown(element.html() ?? "", {
          fenceLanguage: false,
          sanitizeLinks: false,
        }).trim(),
      ),
    );
  });
  if (!turns.length) {
    throw new PresetDriftError("ChatGPT conversation has no turns (missing article[data-turn-id])");
  }
  if (!turns.some((turn) => turn.content.trim())) {
    throw new PresetDriftError("ChatGPT conversation turns rendered no content");
  }
  const structured = new ChatGPTConversation(turns);
  return { full_html: html, selected_html: "", markdown: structured.toMarkdown(), structured };
}

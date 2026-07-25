import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
} from "./errors";
import type { ScrapeResult } from "./handlers/types";
import { eligibleExtractionUrl, extractionOutboundUrls } from "./handlers/x";
import { isSecureHttpUrl, redactDiagnostic, redactUrl } from "./redaction";
import {
  AnthropicBilling,
  ChatGPTConversation,
  ClaudeBilling,
  DeepWikiSearchConversation,
  DeepWikiWikiPage,
  type ExtractionEnvelope,
  type FailureClass,
  GenericPage,
  OpenAIBilling,
  PerplexityBilling,
  TweetContent,
  TweetThread,
  XArticle,
  XProfile,
  XTimeline,
} from "./schemas";

const VERSION = "0.1.0";
const MESSAGES: Record<FailureClass, string> = {
  invalid_request: "The extraction request is invalid.",
  authentication_required: "The source requires authentication.",
  upstream_unavailable: "An extraction dependency is unavailable.",
  timeout: "The extraction timed out.",
  browser_error: "The browser extraction failed.",
  provider_error: "The source provider failed.",
  malformed_provider_output: "The extractor returned an invalid result.",
  empty_content: "The extractor returned no usable content.",
  output_limit_exceeded: "The extraction exceeds its configured output limit.",
  cancelled: "The extraction was cancelled.",
  internal_error: "The extraction failed unexpectedly.",
};

export class EnvelopeBuildError extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "EnvelopeBuildError";
  }
}

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}
function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    new URL(value);
    return redactUrl(value, 4096);
  } catch {
    return redactDiagnostic(value, 4096);
  }
}
export function validateEnvelopeRequest(
  url: unknown,
  maxContentBytes: unknown,
  maxRelations: unknown,
): string {
  if (typeof url !== "string" || !url)
    throw new EnvelopeBuildError("invalid_request", "URL must be a non-empty string");
  if (new TextEncoder().encode(url).byteLength > 4096)
    throw new EnvelopeBuildError("invalid_request", "URL exceeds 4096 UTF-8 bytes");
  if (!isSecureHttpUrl(url))
    throw new EnvelopeBuildError(
      "invalid_request",
      "URL must be an absolute HTTP or HTTPS URL without credentials or embedded secrets",
    );
  if (!Number.isInteger(maxContentBytes) || (maxContentBytes as number) < 1)
    throw new EnvelopeBuildError("invalid_request", "max content bytes must be a positive integer");
  if (!Number.isInteger(maxRelations) || (maxRelations as number) < 0)
    throw new EnvelopeBuildError("invalid_request", "max relations must be a non-negative integer");
  return url;
}
export function validateProviderFinalUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096)
    throw new EnvelopeBuildError("malformed_provider_output", "extractor final URL is invalid");
  if (!isSecureHttpUrl(value))
    throw new EnvelopeBuildError("malformed_provider_output", "extractor final URL is invalid");
  return value;
}

interface Metadata {
  content_type: "web_page" | "social_post" | "article";
  content_kind?: "post" | "thread" | "article";
  content_item_count?: number;
  title: string;
  author_name: string;
  author_handle: string;
  published_at: string;
  source_id: string;
  warnings: "partial_content"[];
}
function metadata(
  contentType: Metadata["content_type"],
  values: Partial<Omit<Metadata, "content_type">> = {},
): Metadata {
  return {
    content_type: contentType,
    ...(values.content_kind !== undefined ? { content_kind: values.content_kind } : {}),
    ...(values.content_item_count !== undefined
      ? { content_item_count: values.content_item_count }
      : {}),
    title: values.title ?? "",
    author_name: values.author_name ?? "",
    author_handle: values.author_handle ?? "",
    published_at: values.published_at ?? "",
    source_id: values.source_id ?? "",
    warnings: values.warnings ?? [],
  };
}
function idFrom(pattern: RegExp, finalUrl: string, requestedUrl: string): string {
  return pattern.exec(finalUrl)?.[1] ?? pattern.exec(requestedUrl)?.[1] ?? "";
}
function sanitizedTweetContent(
  value: TweetContent,
  requested: string,
  final: string,
): TweetContent {
  const links = uniqueEligible(value.links, requested, final, Number.POSITIVE_INFINITY);
  const permalink = value.permalink ? (eligibleExtractionUrl(value.permalink) ?? "") : "";
  return new TweetContent({
    text: value.text,
    timestamp: value.timestamp,
    permalink,
    links,
  });
}
function sanitizedTweetMarkdown(value: TweetThread, requested: string, final: string): string {
  const authorHandle = value.author_handle.replace(/^@/, "");
  const authorUrl = /^[A-Za-z0-9_]{1,100}$/.test(authorHandle)
    ? `https://x.com/${authorHandle}`
    : "";
  return new TweetThread({
    author_name: value.author_name,
    author_handle: value.author_handle,
    author_url: authorUrl,
    tweets: value.tweets.map((tweet) => sanitizedTweetContent(tweet, requested, final)),
    quoted_tweet: value.quoted_tweet
      ? sanitizedTweetContent(value.quoted_tweet, requested, final)
      : null,
  }).toMarkdown();
}
function uniqueEligible(
  values: Iterable<string>,
  requested: string,
  final: string,
  max: number,
): string[] {
  const result: string[] = [];
  for (const value of values) {
    const url = eligibleExtractionUrl(value, [requested, final]);
    if (url && !result.includes(url)) result.push(url);
    if (result.length > max) break;
  }
  return result;
}
function genericRelations(
  result: ScrapeResult,
  content: string,
  requested: string,
  final: string,
  max: number,
): string[] {
  const candidates: string[] = [];
  if (result.selected_html.trim()) {
    const $ = cheerio.load(result.selected_html);
    $("a[href]").each((_index, anchor) => {
      const element = $(anchor);
      if (element.closest("nav,header,footer,aside,[role=navigation],[role=menu]").length) return;
      const tokens = element
        .parents()
        .addBack()
        .map(
          (_i, node) =>
            `${$(node).attr("class") ?? ""} ${$(node).attr("id") ?? ""} ${$(node).attr("data-testid") ?? ""}`,
        )
        .get()
        .join(" ");
      if (
        /\b(nav|navigation|sidebar|footer|header|menu|breadcrumb|pagination|toolbar|toc)\b/i.test(
          tokens,
        )
      )
        return;
      const href = element.attr("href");
      if (href) {
        try {
          candidates.push(new URL(href, final).href);
        } catch {
          /* omit */
        }
      }
    });
  } else {
    const visible = content
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    for (const match of visible.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)) {
      try {
        candidates.push(new URL(match[1]!, final).href);
      } catch {
        /* omit */
      }
    }
    for (const match of visible.matchAll(/<((?:https?):\/\/[^<>\s]+)>/g))
      candidates.push(match[1]!);
  }
  return uniqueEligible(candidates, requested, final, max);
}

interface Projection {
  implementation: string;
  content: string;
  metadata: Metadata;
  relations: string[];
}
function project(
  result: ScrapeResult,
  requested: string,
  final: string,
  hint: string,
  max: number,
): Projection {
  const value = result.structured;
  if (value instanceof GenericPage) {
    const content = value.toMarkdown();
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
    return {
      implementation: hint,
      content,
      metadata: metadata("web_page", { title: bounded(title, 500) }),
      relations: genericRelations(result, content, requested, final, max),
    };
  }
  if (value instanceof TweetThread) {
    if (!value.tweets.some((tweet) => tweet.text.trim()) && !value.quoted_tweet?.text.trim())
      throw new EnvelopeBuildError("empty_content", "X post extraction returned no post text");
    return {
      implementation: "x-tweet",
      content: sanitizedTweetMarkdown(value, requested, final),
      metadata: metadata("social_post", {
        content_kind: value.tweets.length > 1 ? "thread" : "post",
        content_item_count: value.tweets.length,
        author_name: bounded(value.author_name, 200),
        author_handle: bounded(value.author_handle.replace(/^@/, ""), 100),
        published_at: bounded(value.tweets[0]?.timestamp ?? "", 100),
        source_id: idFrom(/\/status\/(\d+)/, final, requested),
      }),
      relations: extractionOutboundUrls(value, requested, final, max),
    };
  }
  if (value instanceof XArticle) {
    if (!value.markdown.trim())
      throw new EnvelopeBuildError(
        "empty_content",
        "X Article extraction returned no article body",
      );
    let warnings: "partial_content"[] = value.warnings.some(
      (warning) => warning.code === "partial_article_extract",
    )
      ? ["partial_content"]
      : [];
    if (result.selected_html.trim()) {
      const $ = cheerio.load(result.selected_html);
      const reader = $('[data-testid="twitterArticleReadView"]');
      if (!reader.length)
        throw new EnvelopeBuildError("empty_content", "X Article reader was not found");
      if (
        !reader.find(
          '[data-testid="twitterArticleRichTextView"],[data-testid="longformRichTextComponent"]',
        ).length
      )
        warnings = ["partial_content"];
    }
    const clean = new XArticle({ ...value, warnings: [] });
    return {
      implementation: "x-article",
      content: clean.toMarkdown(),
      metadata: metadata("article", {
        content_kind: "article",
        content_item_count: 1,
        title: bounded(value.title, 500),
        author_handle: bounded(value.author_handle.replace(/^@/, ""), 100),
        published_at: bounded(value.published_at, 100),
        source_id: idFrom(/\/(?:articles?|status)\/(\d+)/, final, requested),
        warnings,
      }),
      relations: extractionOutboundUrls(value, requested, final, max),
    };
  }
  if (value instanceof XProfile) {
    const handle = value.handle.replace(/^@/, "");
    return {
      implementation: "x-profile",
      content: value.toMarkdown(),
      metadata: metadata("web_page", {
        title: bounded(value.display_name || (handle ? `@${handle}` : ""), 500),
        author_name: bounded(value.display_name, 200),
        author_handle: bounded(handle, 100),
      }),
      relations: uniqueEligible(
        value.recent_posts_structured.flatMap((tweet) => tweet.links),
        requested,
        final,
        max,
      ),
    };
  }
  if (value instanceof XTimeline) {
    const handle = value.handle.replace(/^@/, "");
    const partial = value.warnings.some((warning) =>
      ["scroll_stalled", "max_scrolls_reached"].includes(warning.code),
    );
    return {
      implementation: "x-timeline",
      content: value.toMarkdown(),
      metadata: metadata("web_page", {
        title: handle ? `@${handle} timeline` : "",
        author_handle: bounded(handle, 100),
        warnings: partial ? ["partial_content"] : [],
      }),
      relations: uniqueEligible(
        value.tweets.flatMap((tweet) => tweet.article_urls),
        requested,
        final,
        max,
      ),
    };
  }
  if (value instanceof ChatGPTConversation) {
    if (!value.turns.some((turn) => turn.content.trim()))
      throw new EnvelopeBuildError(
        "empty_content",
        "ChatGPT conversation extraction returned no turn content",
      );
    const content = value.toMarkdown();
    return {
      implementation: "chatgpt-conversation",
      content,
      metadata: metadata("article", {
        source_id: idFrom(/\/(?:c|share)\/([\w-]+)/, final, requested),
      }),
      relations: genericRelations(result, content, requested, final, max),
    };
  }
  if (value instanceof DeepWikiWikiPage)
    return {
      implementation: "deepwiki-wiki-page",
      content: value.toMarkdown(),
      metadata: metadata("article", {
        title: bounded(value.title, 500),
        source_id: bounded(value.repository, 200),
      }),
      relations: uniqueEligible(
        value.citations.map((citation) => citation.target_url),
        requested,
        final,
        max,
      ),
    };
  if (value instanceof DeepWikiSearchConversation)
    return {
      implementation: "deepwiki-search-conversation",
      content: value.toMarkdown(),
      metadata: metadata("article", { source_id: bounded(value.repository, 200) }),
      relations: uniqueEligible(
        value.rounds.flatMap((round) => round.citations.map((citation) => citation.target_url)),
        requested,
        final,
        max,
      ),
    };
  const billing =
    value instanceof ClaudeBilling
      ? "claude-billing"
      : value instanceof AnthropicBilling
        ? "anthropic-billing"
        : value instanceof OpenAIBilling
          ? "openai-billing"
          : value instanceof PerplexityBilling
            ? "perplexity-billing"
            : null;
  if (billing) {
    const content = value.toMarkdown();
    return {
      implementation: billing,
      content,
      metadata: metadata("web_page", {
        title: bounded(content.split("\n", 1)[0]!.replace(/^#{1,6}\s+/, ""), 500),
      }),
      relations: [],
    };
  }
  throw new EnvelopeBuildError(
    "malformed_provider_output",
    `unsupported structured result type: ${value?.constructor?.name ?? "null"}`,
  );
}

export function buildSuccessEnvelope(
  result: ScrapeResult,
  options: {
    requestedUrl: string;
    finalUrl: string;
    implementationHint: string;
    maxContentBytes: number;
    maxRelations: number;
  },
): ExtractionEnvelope {
  validateEnvelopeRequest(options.requestedUrl, options.maxContentBytes, options.maxRelations);
  validateProviderFinalUrl(options.finalUrl);
  const projected = project(
    result,
    options.requestedUrl,
    options.finalUrl,
    options.implementationHint,
    options.maxRelations,
  );
  if (!projected.content.trim())
    throw new EnvelopeBuildError("empty_content", "extracted content is empty");
  const bytes = new TextEncoder().encode(projected.content);
  if (bytes.byteLength > options.maxContentBytes)
    throw new EnvelopeBuildError(
      "output_limit_exceeded",
      `content is ${bytes.byteLength} bytes; limit is ${options.maxContentBytes} bytes`,
    );
  if (projected.relations.length > options.maxRelations)
    throw new EnvelopeBuildError(
      "output_limit_exceeded",
      `relation count is ${projected.relations.length}; limit is ${options.maxRelations}`,
    );
  return {
    schema_version: "1",
    status: "success",
    requested_url: safeUrl(options.requestedUrl),
    final_url: safeUrl(options.finalUrl),
    extractor: {
      name: "agentscrape",
      version: VERSION,
      implementation: bounded(projected.implementation, 100),
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content: projected.content,
        size_bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    metadata: projected.metadata,
    relations: projected.relations.map((target_url) => ({
      relation_type: "references" as const,
      target_url,
    })),
    failure: null,
  };
}

export function classifyFailure(error: unknown): [FailureClass, boolean, string] {
  const value = error instanceof Error ? error : new Error(String(error));
  if (value instanceof EnvelopeBuildError)
    return [value.failureClass, value.retryable, value.message];
  if (value instanceof AgentscrapeAuthError)
    return ["authentication_required", false, value.message];
  if (value instanceof AgentscrapeCancelledError) return ["cancelled", false, value.message];
  if (value instanceof AgentscrapeTimeoutError) return ["timeout", true, value.message];
  if (value instanceof AgentscrapeBrowserError)
    return ["browser_error", value.retryable, value.message];
  if (value instanceof AgentscrapeProviderError)
    return ["provider_error", value.retryable, value.message];
  if (value instanceof AgentscrapeUpstreamDownError)
    return ["upstream_unavailable", true, value.message];
  if (value instanceof PresetSelectionError) return ["invalid_request", false, value.message];
  if (value instanceof PresetConfigError) return ["internal_error", false, value.message];
  if (value instanceof PresetOutputError || value instanceof PresetDriftError)
    return ["malformed_provider_output", false, value.message];
  if (value instanceof AgentscrapeError) {
    if (value.errorClass === "usage") return ["invalid_request", false, value.message];
    if (value.errorClass === "auth" || /authentication required/i.test(value.message))
      return ["authentication_required", false, value.message];
    const permanent = /not found|unsupported|does not exist|invalid/i.test(value.message);
    return ["provider_error", !permanent, value.message];
  }
  if (/authentication required/i.test(value.message))
    return ["authentication_required", false, value.message];
  if (value.name === "AbortError" || /cancelled|canceled|interrupted/i.test(value.message))
    return ["cancelled", false, value.message];
  if (/timed out|timeout/i.test(value.message)) return ["timeout", true, value.message];
  if (/upstream down|ECONN|network|fetch failed|rate limit/i.test(value.message))
    return ["upstream_unavailable", true, value.message];
  if (value instanceof SyntaxError || value instanceof URIError)
    return ["malformed_provider_output", false, value.message];
  if (/selector|preset '|could not extract status id from url/i.test(value.message))
    return ["invalid_request", false, value.message];
  if (/browser|navigation|content not found|failed to open/i.test(value.message))
    return ["browser_error", true, value.message];
  return ["internal_error", false, value.message];
}
export function buildFailureEnvelope(
  error: unknown,
  options: { requestedUrl: unknown; finalUrl?: string | null; implementation: string },
): ExtractionEnvelope {
  const [failureClass, retryable, evidence] = classifyFailure(error);
  return {
    schema_version: "1",
    status: "failure",
    requested_url: safeUrl(options.requestedUrl),
    final_url: options.finalUrl ? safeUrl(options.finalUrl) : null,
    extractor: {
      name: "agentscrape",
      version: VERSION,
      implementation: bounded(options.implementation || "unknown", 100),
      implementation_version: "1",
    },
    artifacts: [],
    metadata: null,
    relations: [],
    failure: {
      failure_class: failureClass,
      retryable,
      message: MESSAGES[failureClass],
      evidence: redactDiagnostic(evidence),
    },
  };
}
export function failureExitCode(failureClass: FailureClass): number {
  return failureClass === "authentication_required" ? 2 : failureClass === "cancelled" ? 130 : 1;
}
export function implementationHint(url: string, preset?: string | null): string {
  if (preset && /^[A-Za-z0-9_.-]{1,100}$/.test(preset)) return preset;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (["x.com", "twitter.com"].includes(host) && /\/(?:i\/)?articles?\/\d+/.test(parsed.pathname))
      return "x-article";
    if (["x.com", "twitter.com"].includes(host) && /\/status\/\d+/.test(parsed.pathname))
      return "x-tweet";
    if (["github.com", "gist.github.com"].includes(host)) return "github";
    if (parsed.pathname.endsWith(".md")) return "direct-markdown";
  } catch {
    return "unknown";
  }
  return "generic-page";
}

import * as cheerio from "cheerio";
import { PresetConfigError } from "./errors";
import {
  scrapeAnthropicBilling,
  scrapeClaudeBilling,
  scrapeOpenAiBilling,
  scrapePerplexityBilling,
} from "./handlers/billing";
import { scrapeConversation } from "./handlers/chatgpt";
import { scrapeSearchConversation, scrapeWikiPage } from "./handlers/deepwiki";
import type { ContentHandler, ScrapeResult } from "./handlers/types";
import {
  eligibleExtractionUrl,
  extractionOutboundUrls,
  scrapeArticle,
  scrapeProfile,
  scrapeTimeline,
  scrapeTweet,
} from "./handlers/x";
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
  ScrapeSchema,
  TweetContent,
  TweetThread,
  XArticle,
  XProfile,
  XTimeline,
} from "./schemas";

export type ScrapeSchemaConstructor = abstract new (...args: any[]) => ScrapeSchema;

export interface ContentHandlerCapabilities {
  readonly browser?: boolean;
  readonly links?: boolean;
}

export interface ContentHandlerRegistration {
  handlerName: string;
  schemaName: string;
  handler: ContentHandler;
  schema: ScrapeSchemaConstructor;
  capabilities?: ContentHandlerCapabilities;
}

export type XExtractorRole = "status" | "article";

export interface ExtractorCapabilities {
  readonly browser: boolean;
  readonly markdown: boolean;
  readonly links: boolean;
  readonly timelineOptions: boolean;
  readonly xRole: XExtractorRole | null;
}

export type ExtractorImplementationIdentity =
  | Readonly<{ kind: "fixed"; value: string }>
  | Readonly<{ kind: "preset" }>;

export type ProjectionMetadata = NonNullable<ExtractionEnvelope["metadata"]>;

export interface ExtractorProjection {
  implementation: string;
  content: string;
  metadata: ProjectionMetadata;
  relations: string[];
}

interface ProjectorContext {
  requestedUrl: string;
  finalUrl: string;
  maxRelations: number;
}

export type ExtractorProjector = (
  result: ScrapeResult,
  context: Readonly<ProjectorContext>,
) => Omit<ExtractorProjection, "implementation">;

export interface ExtractorDefinition {
  readonly handlerName: string;
  readonly schemaName: string;
  readonly handler: ContentHandler;
  readonly schema: ScrapeSchemaConstructor;
  readonly projector: ExtractorProjector;
  readonly implementationIdentity: ExtractorImplementationIdentity;
  readonly capabilities: ExtractorCapabilities;
}

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

function metadata(
  contentType: ProjectionMetadata["content_type"],
  values: Partial<Omit<ProjectionMetadata, "content_type">> = {},
): ProjectionMetadata {
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

function wrongStructuredType(value: unknown): EnvelopeBuildError {
  return new EnvelopeBuildError(
    "malformed_provider_output",
    `unsupported structured result type: ${(value as object | null)?.constructor?.name ?? "null"}`,
  );
}

function structured<T extends ScrapeSchema>(
  result: ScrapeResult,
  schema: abstract new (...args: any[]) => T,
): T {
  if (!(result.structured instanceof schema)) throw wrongStructuredType(result.structured);
  return result.structured;
}

function projectGeneric(
  result: ScrapeResult,
  context: Readonly<ProjectorContext>,
): Omit<ExtractorProjection, "implementation"> {
  const value = result.structured;
  if (!(value instanceof ScrapeSchema)) throw wrongStructuredType(value);
  const content = value.toMarkdown();
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  return {
    content,
    metadata: metadata("web_page", { title: bounded(title, 500) }),
    relations: genericRelations(
      result,
      content,
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
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

const projectTweet: ExtractorProjector = (result, context) => {
  const value = structured(result, TweetThread);
  if (!value.tweets.some((tweet) => tweet.text.trim()) && !value.quoted_tweet?.text.trim())
    throw new EnvelopeBuildError("empty_content", "X post extraction returned no post text");
  return {
    content: sanitizedTweetMarkdown(value, context.requestedUrl, context.finalUrl),
    metadata: metadata("social_post", {
      content_kind: value.tweets.length > 1 ? "thread" : "post",
      content_item_count: value.tweets.length,
      author_name: bounded(value.author_name, 200),
      author_handle: bounded(value.author_handle.replace(/^@/, ""), 100),
      published_at: bounded(value.tweets[0]?.timestamp ?? "", 100),
      source_id: idFrom(/\/status\/(\d+)/, context.finalUrl, context.requestedUrl),
    }),
    relations: extractionOutboundUrls(
      value,
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectArticle: ExtractorProjector = (result, context) => {
  const value = structured(result, XArticle);
  if (!value.markdown.trim())
    throw new EnvelopeBuildError("empty_content", "X Article extraction returned no article body");
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
    content: clean.toMarkdown(),
    metadata: metadata("article", {
      content_kind: "article",
      content_item_count: 1,
      title: bounded(value.title, 500),
      author_handle: bounded(value.author_handle.replace(/^@/, ""), 100),
      published_at: bounded(value.published_at, 100),
      source_id: idFrom(/\/(?:articles?|status)\/(\d+)/, context.finalUrl, context.requestedUrl),
      warnings,
    }),
    relations: extractionOutboundUrls(
      value,
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectProfile: ExtractorProjector = (result, context) => {
  const value = structured(result, XProfile);
  const handle = value.handle.replace(/^@/, "");
  return {
    content: value.toMarkdown(),
    metadata: metadata("web_page", {
      title: bounded(value.display_name || (handle ? `@${handle}` : ""), 500),
      author_name: bounded(value.display_name, 200),
      author_handle: bounded(handle, 100),
    }),
    relations: uniqueEligible(
      value.recent_posts_structured.flatMap((tweet) => tweet.links),
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectTimeline: ExtractorProjector = (result, context) => {
  const value = structured(result, XTimeline);
  const handle = value.handle.replace(/^@/, "");
  const partial = value.warnings.some((warning) =>
    ["scroll_stalled", "max_scrolls_reached"].includes(warning.code),
  );
  return {
    content: value.toMarkdown(),
    metadata: metadata("web_page", {
      title: handle ? `@${handle} timeline` : "",
      author_handle: bounded(handle, 100),
      warnings: partial ? ["partial_content"] : [],
    }),
    relations: uniqueEligible(
      value.tweets.flatMap((tweet) => tweet.article_urls),
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectConversation: ExtractorProjector = (result, context) => {
  const value = structured(result, ChatGPTConversation);
  if (!value.turns.some((turn) => turn.content.trim()))
    throw new EnvelopeBuildError(
      "empty_content",
      "ChatGPT conversation extraction returned no turn content",
    );
  const content = value.toMarkdown();
  return {
    content,
    metadata: metadata("article", {
      source_id: idFrom(/\/(?:c|share)\/([\w-]+)/, context.finalUrl, context.requestedUrl),
    }),
    relations: genericRelations(
      result,
      content,
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectWikiPage: ExtractorProjector = (result, context) => {
  const value = structured(result, DeepWikiWikiPage);
  return {
    content: value.toMarkdown(),
    metadata: metadata("article", {
      title: bounded(value.title, 500),
      source_id: bounded(value.repository, 200),
    }),
    relations: uniqueEligible(
      value.citations.map((citation) => citation.target_url),
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectSearchConversation: ExtractorProjector = (result, context) => {
  const value = structured(result, DeepWikiSearchConversation);
  return {
    content: value.toMarkdown(),
    metadata: metadata("article", { source_id: bounded(value.repository, 200) }),
    relations: uniqueEligible(
      value.rounds.flatMap((round) => round.citations.map((citation) => citation.target_url)),
      context.requestedUrl,
      context.finalUrl,
      context.maxRelations,
    ),
  };
};

const projectBilling: ExtractorProjector = (result) => {
  const content = result.structured.toMarkdown();
  return {
    content,
    metadata: metadata("web_page", {
      title: bounded(content.split("\n", 1)[0]!.replace(/^#{1,6}\s+/, ""), 500),
    }),
    relations: [],
  };
};

function capabilities(values: Partial<ExtractorCapabilities> = {}): ExtractorCapabilities {
  return Object.freeze({
    browser: values.browser ?? true,
    markdown: values.markdown ?? true,
    links: values.links ?? false,
    timelineOptions: values.timelineOptions ?? false,
    xRole: values.xRole ?? null,
  });
}

function fixed(value: string): ExtractorImplementationIdentity {
  return Object.freeze({ kind: "fixed" as const, value });
}

function officialDefinition(
  value: Omit<ExtractorDefinition, "capabilities" | "implementationIdentity"> & {
    implementation: string;
    capabilities?: Partial<ExtractorCapabilities>;
  },
): ExtractorDefinition {
  return Object.freeze({
    handlerName: value.handlerName,
    schemaName: value.schemaName,
    handler: value.handler,
    schema: value.schema,
    projector: value.projector,
    implementationIdentity: fixed(value.implementation),
    capabilities: capabilities(value.capabilities),
  });
}

export const officialExtractorDefinitions = Object.freeze([
  officialDefinition({
    handlerName: "anthropic_billing.scrape_anthropic_billing",
    schemaName: "AnthropicBilling",
    handler: scrapeAnthropicBilling,
    schema: AnthropicBilling,
    projector: projectBilling,
    implementation: "anthropic-billing",
  }),
  officialDefinition({
    handlerName: "chatgpt.scrape_conversation",
    schemaName: "ChatGPTConversation",
    handler: scrapeConversation,
    schema: ChatGPTConversation,
    projector: projectConversation,
    implementation: "chatgpt-conversation",
  }),
  officialDefinition({
    handlerName: "claude_billing.scrape_claude_billing",
    schemaName: "ClaudeBilling",
    handler: scrapeClaudeBilling,
    schema: ClaudeBilling,
    projector: projectBilling,
    implementation: "claude-billing",
  }),
  officialDefinition({
    handlerName: "deepwiki.scrape_search_conversation",
    schemaName: "DeepWikiSearchConversation",
    handler: scrapeSearchConversation,
    schema: DeepWikiSearchConversation,
    projector: projectSearchConversation,
    implementation: "deepwiki-search-conversation",
  }),
  officialDefinition({
    handlerName: "deepwiki.scrape_wiki_page",
    schemaName: "DeepWikiWikiPage",
    handler: scrapeWikiPage,
    schema: DeepWikiWikiPage,
    projector: projectWikiPage,
    implementation: "deepwiki-wiki-page",
  }),
  officialDefinition({
    handlerName: "openai_billing.scrape_openai_billing",
    schemaName: "OpenAIBilling",
    handler: scrapeOpenAiBilling,
    schema: OpenAIBilling,
    projector: projectBilling,
    implementation: "openai-billing",
  }),
  officialDefinition({
    handlerName: "perplexity_billing.scrape_perplexity_billing",
    schemaName: "PerplexityBilling",
    handler: scrapePerplexityBilling,
    schema: PerplexityBilling,
    projector: projectBilling,
    implementation: "perplexity-billing",
  }),
  officialDefinition({
    handlerName: "x.scrape_article",
    schemaName: "XArticle",
    handler: scrapeArticle,
    schema: XArticle,
    projector: projectArticle,
    implementation: "x-article",
    capabilities: { xRole: "article" },
  }),
  officialDefinition({
    handlerName: "x.scrape_profile",
    schemaName: "XProfile",
    handler: scrapeProfile,
    schema: XProfile,
    projector: projectProfile,
    implementation: "x-profile",
  }),
  officialDefinition({
    handlerName: "x.scrape_timeline",
    schemaName: "XTimeline",
    handler: scrapeTimeline,
    schema: XTimeline,
    projector: projectTimeline,
    implementation: "x-timeline",
    capabilities: { links: true, timelineOptions: true },
  }),
  officialDefinition({
    handlerName: "x.scrape_tweet",
    schemaName: "TweetThread",
    handler: scrapeTweet,
    schema: TweetThread,
    projector: projectTweet,
    implementation: "x-tweet",
    capabilities: { xRole: "status" },
  }),
] as const);

const customDefinitions = new Map<string, ExtractorDefinition>();

function allDefinitions(): Iterable<ExtractorDefinition> {
  return {
    *[Symbol.iterator]() {
      yield* officialExtractorDefinitions;
      yield* customDefinitions.values();
    },
  };
}

export function extractorDefinitionForHandler(handlerName: string): ExtractorDefinition | null {
  for (const definition of allDefinitions())
    if (definition.handlerName === handlerName) return definition;
  return null;
}

export function extractorDefinitionForSchema(schemaName: string): ExtractorDefinition | null {
  for (const definition of allDefinitions())
    if (definition.schemaName === schemaName) return definition;
  return null;
}

export function resolveExtractorDefinition(
  handlerName: string,
  schemaName: string,
): ExtractorDefinition | null {
  const definition = extractorDefinitionForHandler(handlerName);
  return definition?.schemaName === schemaName ? definition : null;
}

export function extractorSchemaNames(): string[] {
  return [...allDefinitions()].map((definition) => definition.schemaName).sort();
}

export function isCurrentExtractorDefinition(definition: ExtractorDefinition): boolean {
  return (
    officialExtractorDefinitions.includes(
      definition as (typeof officialExtractorDefinitions)[number],
    ) || customDefinitions.get(definition.handlerName) === definition
  );
}

function customCapabilities(value: unknown): ExtractorCapabilities {
  if (value === undefined)
    return capabilities({
      browser: false,
      markdown: true,
      links: false,
      timelineOptions: false,
      xRole: null,
    });
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PresetConfigError("content handler capabilities must be an object");
  const keys = Reflect.ownKeys(value);
  const unknown = keys.filter(
    (key) => typeof key !== "string" || !["browser", "links"].includes(key),
  );
  if (unknown.length)
    throw new PresetConfigError(
      `content handler capabilities contain unknown keys: ${unknown
        .map((key) => (typeof key === "symbol" ? key.toString() : key))
        .sort()
        .join(", ")}`,
    );
  const candidate = value as Record<string, unknown>;
  for (const key of keys as Array<"browser" | "links">)
    if (typeof candidate[key] !== "boolean")
      throw new PresetConfigError(`content handler capability '${key}' must be a boolean`);
  return capabilities({
    browser: (candidate.browser as boolean | undefined) ?? false,
    markdown: true,
    links: (candidate.links as boolean | undefined) ?? false,
    timelineOptions: false,
    xRole: null,
  });
}

/**
 * Register one trusted in-process TypeScript content handler and its structured schema.
 *
 * Registration is explicit and process-local: configuration and environment variables never load
 * executable modules. The returned function unregisters only this exact registration.
 */
export function registerContentHandler(registration: ContentHandlerRegistration): () => void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(registration.handlerName))
    throw new PresetConfigError("content handler name is invalid");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(registration.schemaName))
    throw new PresetConfigError("content schema name is invalid");
  if (typeof registration.handler !== "function")
    throw new PresetConfigError("content handler must be a function");
  if (
    typeof registration.schema !== "function" ||
    !(registration.schema.prototype instanceof ScrapeSchema)
  )
    throw new PresetConfigError("content schema must extend ScrapeSchema");
  const normalizedCapabilities = customCapabilities(registration.capabilities);
  if (extractorDefinitionForHandler(registration.handlerName))
    throw new PresetConfigError(
      `content handler '${registration.handlerName}' is already registered`,
    );
  if (extractorDefinitionForSchema(registration.schemaName))
    throw new PresetConfigError(
      `content schema '${registration.schemaName}' is already registered`,
    );
  const definition = Object.freeze({
    handlerName: registration.handlerName,
    schemaName: registration.schemaName,
    handler: registration.handler,
    schema: registration.schema,
    projector: projectGeneric,
    implementationIdentity: Object.freeze({ kind: "preset" as const }),
    capabilities: normalizedCapabilities,
  });
  customDefinitions.set(definition.handlerName, definition);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (customDefinitions.get(definition.handlerName) === definition)
      customDefinitions.delete(definition.handlerName);
  };
}

const X_ARTICLE_PRESET_NAME = "x-article";

export function articlePresetNameFor(definition: ExtractorDefinition): string | null {
  return definition.capabilities.xRole === "status" ? X_ARTICLE_PRESET_NAME : null;
}

export function projectScrapeResult(
  result: ScrapeResult,
  options: {
    requestedUrl: string;
    finalUrl: string;
    implementationHint: string;
    maxRelations: number;
    definition?: ExtractorDefinition | undefined;
  },
): ExtractorProjection {
  const context = {
    requestedUrl: options.requestedUrl,
    finalUrl: options.finalUrl,
    maxRelations: options.maxRelations,
  };
  let definition = options.definition;
  if (definition) {
    if (!isCurrentExtractorDefinition(definition)) throw wrongStructuredType(result.structured);
    if (!(result.structured instanceof definition.schema))
      throw wrongStructuredType(result.structured);
  } else if (result.structured instanceof ScrapeSchema) {
    definition = officialExtractorDefinitions.find(
      (candidate) => result.structured instanceof candidate.schema,
    );
  }
  if (definition) {
    const projected = definition.projector(result, context);
    const implementation =
      definition.implementationIdentity.kind === "fixed"
        ? definition.implementationIdentity.value
        : options.implementationHint;
    return { implementation, ...projected };
  }
  if (result.structured instanceof GenericPage) {
    const projected = projectGeneric(result, context);
    return { implementation: options.implementationHint, ...projected };
  }
  throw wrongStructuredType(result.structured);
}

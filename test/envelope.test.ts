import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  classifyFailure,
  EnvelopeBuildError,
  validateEnvelopeRequest,
} from "../src/envelope";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeNetworkPolicyError,
  AgentscrapeProviderError,
  AgentscrapeRuntimeError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  type ErrorClass,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
} from "../src/errors";
import type { ScrapeResult } from "../src/handlers/types";
import {
  AnthropicBilling,
  ChatGPTConversation,
  ClaudeBilling,
  ConversationTurn,
  DeepWikiCitation,
  DeepWikiQARound,
  DeepWikiSearchConversation,
  DeepWikiWikiPage,
  type FailureClass,
  GenericPage,
  OpenAIBilling,
  PerplexityBilling,
  ScrapeWarning,
  TweetContent,
  TweetThread,
  XArticle,
  XProfile,
  XTimeline,
  XTimelineTweet,
} from "../src/schemas";

const result = <T extends { toMarkdown(): string }>(
  structured: T,
  selected = "",
): ScrapeResult => ({
  full_html: "",
  selected_html: selected,
  markdown: structured.toMarkdown(),
  structured,
});
const build = (value: ScrapeResult, requested = "https://example.com/start", final = requested) =>
  buildSuccessEnvelope(value, {
    requestedUrl: requested,
    finalUrl: final,
    implementationHint: "generic-page",
    maxContentBytes: 1_000_000,
    maxRelations: 256,
  });

describe("version 1 extraction envelope", () => {
  test("matches the reviewed generic projection", () => {
    const markdown = "# Example\n\nSee [Guide](https://docs.example/guide).";
    const envelope = build(
      result(
        new GenericPage("https://example.com/start", markdown),
        readFileSync(join(import.meta.dir, "fixtures/extraction-generic.html"), "utf8"),
      ),
      "https://example.com/start",
      "https://example.com/final",
    );
    const expected = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures/extraction-generic.expected.json"), "utf8"),
    );
    expect(envelope).toEqual(expected);
    expect(envelope.schema_version).toBe("1");
    expect(envelope.extractor.name).toBe("agentscrape");
  });
  test("rejects invalid URL and bound requests", () => {
    expect(() => validateEnvelopeRequest("file:///tmp/a", 100, 1)).toThrow("HTTP");
    expect(() => validateEnvelopeRequest("https://user:pw@example.com", 100, 1)).toThrow(
      "without credentials",
    );
    expect(() => validateEnvelopeRequest("https://example.com", 0, 1)).toThrow("positive integer");
    expect(() => validateEnvelopeRequest("https://example.com", 1, -1)).toThrow("non-negative");
  });
  test("enforces content and relation limits", () => {
    const value = result(new GenericPage("https://example.com", "hello"));
    expect(() =>
      buildSuccessEnvelope(value, {
        requestedUrl: "https://example.com",
        finalUrl: "https://example.com",
        implementationHint: "generic-page",
        maxContentBytes: 4,
        maxRelations: 1,
      }),
    ).toThrow("content is 5 bytes");
    const links = "[one](https://one.example/x) [two](https://two.example/x)";
    expect(() =>
      buildSuccessEnvelope(result(new GenericPage("https://example.com", links)), {
        requestedUrl: "https://example.com",
        finalUrl: "https://example.com",
        implementationHint: "generic-page",
        maxContentBytes: 1000,
        maxRelations: 1,
      }),
    ).toThrow("relation count is 2");
  });
  test("generic projection excludes navigation links", () => {
    const selected =
      '<main><nav><a href="https://example.com/menu">Menu</a></nav><p><a href="https://docs.example/x">Doc</a></p></main>';
    const envelope = build(result(new GenericPage("https://example.com", "content"), selected));
    expect(envelope.relations).toEqual([
      { relation_type: "references", target_url: "https://docs.example/x" },
    ]);
  });
  test("X post projection emits social metadata and safe relations", () => {
    const thread = new TweetThread({
      author_name: "Example",
      author_handle: "@example",
      tweets: [
        new TweetContent({
          text: "hello",
          timestamp: "now",
          links: ["https://docs.example/a", "https://example.com/token?secret=bad"],
        }),
      ],
    });
    const envelope = build(
      result(thread),
      "https://x.com/example/status/123",
      "https://x.com/example/status/123",
    );
    expect(envelope.metadata).toMatchObject({
      content_type: "social_post",
      content_kind: "post",
      content_item_count: 1,
      source_id: "123",
    });
    expect(envelope.relations.map((item) => item.target_url)).toEqual(["https://docs.example/a"]);
    expect(envelope.artifacts[0]?.content).not.toContain("secret=bad");
  });
  test("X thread projection persists parser-observed item count", () => {
    const thread = new TweetThread({
      author_name: "Example",
      author_handle: "example",
      tweets: [new TweetContent({ text: "first" }), new TweetContent({ text: "second" })],
    });
    const envelope = build(
      result(thread),
      "https://x.com/example/status/123",
      "https://x.com/example/status/123",
    );
    expect(envelope.metadata).toMatchObject({
      content_type: "social_post",
      content_kind: "thread",
      content_item_count: 2,
    });
  });
  test("X relation filtering removes profiles, analytics, media, nested secrets, and source URLs", () => {
    const thread = new TweetThread({
      author_name: "A",
      author_handle: "a",
      tweets: [
        new TweetContent({
          text: "links",
          links: [
            "https://github.com/person",
            "https://www.youtube.com/@person",
            "https://plausible.io/api/event",
            "https://example.com/token/do-not-leak",
            "https://example.com/redirect?url=https%3A%2F%2Ftarget%2F%3Ftoken%3Dnope",
            "https://pbs.twimg.com/media/image.jpg",
            "https://x.com/a/status/1?s=20",
            "https://twitter.com/peer/status/2?s=20#fragment",
            "https://example.com/reference?keep=yes#fragment",
          ],
        }),
      ],
    });
    const envelope = build(result(thread), "https://x.com/a/status/1", "https://x.com/a/status/1");
    expect(envelope.relations.map((item) => item.target_url)).toEqual([
      "https://x.com/peer/status/2",
      "https://example.com/reference?keep=yes",
    ]);
    expect(envelope.artifacts[0]?.content).not.toContain("do-not-leak");
  });
  test("X article requires body and verifies provider HTML", () => {
    const article = new XArticle({
      url: "https://x.com/i/article/7",
      title: "T",
      markdown: "Body",
    });
    expect(() => build(result(article, "<main>Body</main>"))).toThrow("reader was not found");
    const selected =
      '<div data-testid="twitterArticleReadView"><div data-testid="twitterArticleRichTextView">Body</div></div>';
    const envelope = build(result(article, selected), "https://x.com/i/article/7");
    expect(envelope.metadata).toMatchObject({
      content_type: "article",
      content_kind: "article",
      content_item_count: 1,
      source_id: "7",
    });
  });
  test("every official structured schema has a central projector", () => {
    const citation = new DeepWikiCitation({ label: "src", target_url: "https://github.com/a/b" });
    const values = [
      new XProfile({ display_name: "A", handle: "a", bio: "bio" }),
      new XTimeline({
        handle: "a",
        tweets: [new XTimelineTweet({ id: "1", url: "https://x.com/a/status/1", text: "x" })],
        warnings: [new ScrapeWarning("scroll_stalled", "partial")],
      }),
      new ChatGPTConversation([new ConversationTurn("user", "hello")]),
      new DeepWikiWikiPage({ title: "Wiki", markdown: "body", citations: [citation] }),
      new DeepWikiSearchConversation({
        rounds: [new DeepWikiQARound({ question: "Q", answer: "A", citations: [citation] })],
      }),
      new ClaudeBilling({ current_plan: 1 }),
      new AnthropicBilling("org", 0, false),
      new OpenAIBilling("org", "Prepaid", 0, false),
      new PerplexityBilling(0, 1, false),
    ];
    for (const structured of values) {
      const envelope = build(result(structured));
      expect(envelope.status).toBe("success");
      expect(envelope.extractor.implementation).not.toBe("generic-page");
    }
  });
});

describe("failure projection and redaction", () => {
  test("classifies every authoritative typed error without message heuristics", () => {
    const typed = [
      [new AgentscrapeUsageError("usage"), "invalid_request", false],
      [new AgentscrapeNetworkPolicyError("private_destination"), "invalid_request", false],
      [new AgentscrapeNetworkPolicyError("browser_egress_unverifiable"), "invalid_request", false],
      [new PresetSelectionError("selection"), "invalid_request", false],
      [new AgentscrapeAuthError("auth"), "authentication_required", false],
      [new AgentscrapeUpstreamDownError("upstream"), "upstream_unavailable", true],
      [new PresetConfigError("config"), "internal_error", false],
      [new PresetOutputError("output"), "malformed_provider_output", false],
      [new PresetDriftError("drift"), "malformed_provider_output", false],
      [new AgentscrapeBrowserError("browser", false), "browser_error", false],
      [new AgentscrapeProviderError("provider", true), "provider_error", true],
      [new AgentscrapeTimeoutError("timeout"), "timeout", true],
      [new AgentscrapeCancelledError("cancelled"), "cancelled", false],
      [new AgentscrapeRuntimeError("runtime"), "internal_error", false],
    ] as const;
    for (const [error, failureClass, retryable] of typed)
      expect(classifyFailure(error).slice(0, 2), error.message).toEqual([failureClass, retryable]);

    const baseMappings: Array<[ErrorClass, FailureClass, boolean]> = [
      ["usage", "invalid_request", false],
      ["selection", "invalid_request", false],
      ["auth", "authentication_required", false],
      ["upstream", "upstream_unavailable", true],
      ["config", "internal_error", false],
      ["runtime", "internal_error", false],
      ["output", "malformed_provider_output", false],
      ["drift", "malformed_provider_output", false],
      ["browser", "browser_error", true],
      ["provider", "provider_error", false],
      ["timeout", "timeout", true],
      ["cancelled", "cancelled", false],
    ];
    for (const [errorClass, failureClass, retryable] of baseMappings)
      expect(
        classifyFailure(new AgentscrapeError("misleading timeout auth selector", errorClass)),
      ).toEqual([failureClass, retryable, "misleading timeout auth selector"]);
    for (const message of ["timed out", "authentication required", "selector is invalid"])
      expect(classifyFailure(new AgentscrapeRuntimeError(message)).slice(0, 2)).toEqual([
        "internal_error",
        false,
      ]);
  });
  test("keeps only the approved raw-error compatibility mappings", () => {
    for (const [error, failureClass, retryable] of [
      [new Error("authentication required"), "authentication_required", false],
      [new Error("operation canceled"), "cancelled", false],
      [new Error("request timed out"), "timeout", true],
      [new Error("fetch failed with ECONNRESET"), "upstream_unavailable", true],
      [new Error("browser navigation failed"), "browser_error", true],
      [new SyntaxError("bad JSON"), "malformed_provider_output", false],
      [new URIError("bad URI"), "malformed_provider_output", false],
      [new DOMException("aborted", "AbortError"), "cancelled", false],
      [new DOMException("deadline", "TimeoutError"), "timeout", true],
      [new Error("selector '#missing' matched nothing"), "internal_error", false],
    ] as const)
      expect(classifyFailure(error).slice(0, 2), error.message).toEqual([failureClass, retryable]);
  });
  test("raw concrete error types take precedence over misleading messages", () => {
    for (const [error, failureClass, retryable] of [
      [new DOMException("timed out", "AbortError"), "cancelled", false],
      [new DOMException("operation cancelled", "TimeoutError"), "timeout", true],
      [new SyntaxError("browser navigation failed"), "malformed_provider_output", false],
      [new URIError("browser navigation failed"), "malformed_provider_output", false],
    ] as const)
      expect(classifyFailure(error).slice(0, 2), error.message).toEqual([failureClass, retryable]);
  });
  test("build errors preserve explicit classes", () => {
    expect(classifyFailure(new EnvelopeBuildError("empty_content", "empty"))).toEqual([
      "empty_content",
      false,
      "empty",
    ]);
  });
  test("failure evidence is bounded and secret-safe", () => {
    const envelope = buildFailureEnvelope(
      new Error(`Authorization: Bearer secret-value token=hidden ${"x".repeat(5000)}`),
      {
        requestedUrl: "https://example.com/path?api_key=secret",
        implementation: "generic-page",
      },
    );
    expect(envelope.status).toBe("failure");
    expect(envelope.requested_url).not.toContain("secret");
    expect(envelope.failure?.evidence).not.toContain("secret-value");
    expect(new TextEncoder().encode(envelope.failure?.evidence).byteLength).toBeLessThanOrEqual(
      1024,
    );
    expect(envelope.artifacts).toEqual([]);
    expect(envelope.metadata).toBeNull();
  });
});

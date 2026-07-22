import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PresetDriftError } from "../src/errors";
import {
  scrapeAnthropicBilling,
  scrapeClaudeBilling,
  scrapeOpenAiBilling,
  scrapePerplexityBilling,
} from "../src/handlers/billing";
import { scrapeConversation } from "../src/handlers/chatgpt";
import {
  parseDeepWikiSearch,
  parseDeepWikiWiki,
  scrapeSearchConversation,
  scrapeWikiPage,
} from "../src/handlers/deepwiki";
import { scrapeArticle, scrapeProfile, scrapeTweet } from "../src/handlers/x";

const fixtures = join(import.meta.dir, "fixtures");
const corpus = join(import.meta.dir, "corpus");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const _corpusHtml = (preset: string, sample = "sample-001") =>
  readFileSync(join(corpus, preset, sample, "page.html"), "utf8");

describe("official billing invariants", () => {
  test("Anthropic accepts labeled zero and rejects a missing landmark", async () => {
    const zero = await scrapeAnthropicBilling("https://platform.claude.com/settings/billing", {
      html: fixture("preset-audit-anthropic-billing-zero.html"),
    });
    expect(zero.structured.credit_balance).toBe(0);
    expect(
      scrapeAnthropicBilling("https://platform.claude.com/settings/billing", {
        html: fixture("preset-audit-anthropic-billing-missing-landmark.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("Anthropic recognizes an authentication shell", async () => {
    expect(
      scrapeAnthropicBilling("https://platform.claude.com/settings/billing", {
        html: fixture("preset-audit-anthropic-billing-login.html"),
      }),
    ).rejects.toThrow("authentication required");
  });
  test("OpenAI accepts labeled zero and rejects a missing landmark", async () => {
    const zero = await scrapeOpenAiBilling(
      "https://platform.openai.com/settings/organization/billing",
      { html: fixture("preset-audit-openai-billing-zero.html") },
    );
    expect(zero.structured.credit_balance).toBe(0);
    expect(
      scrapeOpenAiBilling("https://platform.openai.com/settings/organization/billing", {
        html: fixture("preset-audit-openai-billing-missing-landmark.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("Perplexity accepts labeled zero and rejects a missing landmark", async () => {
    const zero = await scrapePerplexityBilling("https://www.perplexity.ai/account/api/billing", {
      html: fixture("preset-audit-perplexity-billing-zero.html"),
    });
    expect(zero.structured.credit_balance).toBe(0);
    expect(
      scrapePerplexityBilling("https://www.perplexity.ai/account/api/billing", {
        html: fixture("preset-audit-perplexity-billing-missing-landmark.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("Claude accepts positive page-specific evidence and rejects a shell", async () => {
    const zero = await scrapeClaudeBilling("https://claude.ai/settings/billing", {
      html: fixture("preset-audit-claude-billing-zero.html"),
    });
    expect(zero.structured.current_balance).toBe(0);
    expect(
      scrapeClaudeBilling("https://claude.ai/settings/billing", {
        html: fixture("preset-audit-claude-billing-missing-landmark.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
});

describe("conversation and social fail-closed handlers", () => {
  test("ChatGPT preserves adaptive code fences", async () => {
    const result = await scrapeConversation("https://chatgpt.com/share/example", {
      html: fixture("chatgpt-code-blocks.html"),
    });
    expect(result.markdown.trim()).toBe(fixture("chatgpt-code-blocks.expected.md").trim());
  });
  test("ChatGPT rejects a page without conversation turns", async () => {
    expect(
      scrapeConversation("https://chatgpt.com/share/nope", {
        html: fixture("preset-audit-chatgpt-no-turns.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("X post requires its core post container", async () => {
    expect(
      scrapeTweet("https://x.com/nobody/status/1", {
        html: fixture("preset-audit-x-tweet-no-tweet.html"),
      }),
    ).rejects.toThrow("core structure missing");
  });
  test("X post repairs truncated wrapped-link text without live redirect expansion", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><span>Alice</span><span>@alice</span></div>
      <div data-testid="tweetText"><a href="https://example.com/full/path">example.com/full…</a></div>
    </article>`;
    const result = await scrapeTweet("https://x.com/alice/status/1", { html });
    expect(result.markdown).toContain("https://example.com/full/path");
    expect(result.markdown).not.toContain("example.com/full…");
  });
  test("X profile requires its username root", async () => {
    expect(
      scrapeProfile("https://x.com/nobody", {
        html: fixture("preset-audit-x-profile-no-username.html"),
      }),
    ).rejects.toThrow("core structure missing");
  });
  test("X article requires a reader and non-empty body", async () => {
    expect(
      scrapeArticle("https://x.com/i/article/1", {
        html: fixture("preset-audit-x-article-no-container.html"),
      }),
    ).rejects.toThrow("reader container not found");
    expect(
      scrapeArticle("https://x.com/i/article/1", {
        html: fixture("preset-audit-x-article-empty-body.html"),
      }),
    ).rejects.toThrow("rendered no body content");
  });
  test("X article warning vocabulary contains only reachable partial warning", async () => {
    const html =
      '<div data-testid="twitterArticleReadView"><div data-testid="twitterArticleRichTextView"><p>Body</p></div></div>';
    const result = await scrapeArticle("https://x.com/i/article/1", { html });
    expect(result.structured.warnings.map((warning) => warning.code)).toEqual([
      "partial_article_extract",
    ]);
  });
});

describe("DeepWiki page-kind contracts", () => {
  test("wiki page scopes title, repository, body, and citations", () => {
    const page = parseDeepWikiWiki(
      fixture("deepwiki-wiki-page.html"),
      "https://deepwiki.com/acme/widget/2-configuration",
    );
    expect(page.title).toBeTruthy();
    expect(page.repository).toBe("acme/widget");
    expect(page.citations.length).toBeGreaterThan(0);
    expect(page.toMarkdown()).not.toContain("Repository navigation");
  });
  test("wiki page rejects auth, loading, duplicate content, and missing roots", async () => {
    expect(
      scrapeWikiPage("https://deepwiki.com/acme/widget", {
        html: fixture("deepwiki-wiki-page-auth.html"),
      }),
    ).rejects.toThrow("requires authentication");
    expect(
      scrapeWikiPage("https://deepwiki.com/acme/widget", {
        html: fixture("deepwiki-wiki-page-loading.html"),
      }),
    ).rejects.toThrow("timed out");
    for (const name of [
      "deepwiki-wiki-page-duplicate-content.html",
      "deepwiki-wiki-page-missing-root.html",
    ]) {
      expect(
        scrapeWikiPage("https://deepwiki.com/acme/widget", { html: fixture(name) }),
      ).rejects.toBeInstanceOf(PresetDriftError);
    }
  });
  test("search removes source previews and keeps ordered rounds", () => {
    const search = parseDeepWikiSearch(
      fixture("deepwiki-search-conversation.html"),
      "https://deepwiki.com/search/example_abc",
    );
    expect(search.rounds.length).toBeGreaterThan(0);
    expect(search.toMarkdown()).not.toContain("SOURCE PREVIEW ONLY");
  });
  test("search rejects auth, loading, generating, and incomplete states", async () => {
    for (const [name, text] of [
      ["deepwiki-search-auth.html", "requires authentication"],
      ["deepwiki-search-generating.html", "terminal state"],
      ["deepwiki-search-incomplete.html", "incomplete"],
    ] as const) {
      expect(
        scrapeSearchConversation("https://deepwiki.com/search/example_abc", {
          html: fixture(name),
        }),
      ).rejects.toThrow(text);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentscrapeTimeoutError, AgentscrapeUsageError, PresetDriftError } from "../src/errors";
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
import { scrapeArticle, scrapeProfile, scrapeTimeline, scrapeTweet } from "../src/handlers/x";

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
    expect(
      scrapePerplexityBilling("https://www.perplexity.ai/account/api/billing", {
        html: "",
        media: "offline-sentinel",
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
  test("X route mismatches are usage errors while captured DOM drift remains drift", async () => {
    for (const request of [
      scrapeTweet("https://x.com/nobody", { media: "offline-sentinel" }),
      scrapeTweet("https://x.com/nobody?next=/somebody/status/1", {
        html: fixture("preset-audit-x-tweet-no-tweet.html"),
      }),
      scrapeArticle("https://x.com/nobody?next=/i/article/1", {
        html: fixture("preset-audit-x-article-no-container.html"),
      }),
    ])
      await expect(request).rejects.toBeInstanceOf(AgentscrapeUsageError);
    await expect(
      scrapeTweet("https://x.com/nobody/status/1", {
        html: fixture("preset-audit-x-tweet-no-tweet.html"),
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("X status validation accepts canonical URLs and trailing pathname segments", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Post body</div>
      <a href="/alice/status/1"><time>now</time></a>
    </article>`;
    for (const url of [
      "https://x.com/alice/status/1",
      "https://twitter.com/alice/status/1/photo/1?view=full#media",
    ])
      expect((await scrapeTweet(url, { html })).structured.tweets[0]?.text).toBe("Post body");
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
  test("X thread compares author handles case-insensitively", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/OpenRouter"><span>OpenRouter</span><span>@OpenRouter</span></a></div>
      <div data-testid="tweetText">First post</div>
      <a href="/OpenRouter/status/1"><time>now</time></a>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/OpenRouter"><span>OpenRouter</span><span>@OpenRouter</span></a></div>
      <div data-testid="tweetText">Second post</div>
      <a href="/OpenRouter/status/2"><time>later</time></a>
    </article>`;
    const result = await scrapeTweet("https://x.com/i/status/1", { html });
    expect(result.structured.author_handle).toBe("openrouter");
    expect(result.structured.tweets.map((tweet) => tweet.text)).toEqual([
      "First post",
      "Second post",
    ]);
  });
  test("X thread keeps a same-author quote separate from top-level continuations", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/Alice"><span>Alice</span><span>@Alice</span></a></div>
      <div data-testid="tweetText">Outer post</div>
      <a href="/Alice/status/1"><time>first</time></a>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
        <div data-testid="tweetText">Quoted words</div>
        <a href="/alice/status/9"><time>quoted</time></a>
      </article>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/ALICE"><span>Alice</span><span>@ALICE</span></a></div>
      <div data-testid="tweetText">Top-level continuation</div>
      <a href="/alice/status/2"><time>second</time></a>
    </article>`;
    const result = await scrapeTweet("https://x.com/i/status/1", { html });

    expect(result.structured.tweets.map((tweet) => tweet.text)).toEqual([
      "Outer post",
      "Top-level continuation",
    ]);
    expect(result.structured.quoted_tweet?.text).toBe("Quoted words");
    expect(result.markdown.match(/Quoted words/g)).toHaveLength(1);
  });
  test("X thread leaves a structurally nested empty quote null", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Primary post</div>
      <a href="/alice/status/1"><time>first</time></a>
      <article data-testid="tweet"><div aria-hidden="true"></div></article>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Primary continuation</div>
      <a href="/alice/status/2"><time>second</time></a>
    </article>`;
    const result = await scrapeTweet("https://x.com/i/status/1", { html });

    expect(result.structured.tweets.map((tweet) => tweet.text)).toEqual([
      "Primary post",
      "Primary continuation",
    ]);
    expect(result.structured.quoted_tweet).toBeNull();
  });
  test("X thread ignores a different-author quote when continuing the top-level author", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">First</div>
      <a href="/alice/status/1"><time>first</time></a>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/bob"><span>Bob</span><span>@bob</span></a></div>
        <div data-testid="tweetText">Bob quote</div>
      </article>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Second</div>
      <a href="/alice/status/2"><time>second</time></a>
    </article>`;
    const result = await scrapeTweet("https://x.com/i/status/1", { html });

    expect(result.structured.tweets.map((tweet) => tweet.text)).toEqual(["First", "Second"]);
    expect(result.structured.quoted_tweet?.text).toBe("Bob quote");
  });
  test("X tweet fields belong to their nearest tweet container", async () => {
    const html = `<article data-testid="tweet">
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/bob"><span>Bob</span><span>@bob</span></a></div>
        <div data-testid="tweetText">Quote https://raw.example/owned</div>
        <a href="https://docs.example/quote">Quote link</a>
        <a href="/bob/status/10"><time>quoted time</time></a>
      </article>
    </article>`;
    const result = await scrapeTweet("https://x.com/outer/status/10", { html });
    const outer = result.structured.tweets[0]!;

    expect(result.structured.author_name).toBe("");
    expect(result.structured.author_handle).toBe("outer");
    expect(outer).toMatchObject({ text: "", timestamp: "", permalink: "", links: [] });
    expect(result.structured.quoted_tweet).toMatchObject({
      text: "Quote https://raw.example/owned",
      timestamp: "quoted time",
      permalink: "https://x.com/bob/status/10",
      links: ["https://docs.example/quote", "https://raw.example/owned"],
    });
  });
  test("X status anchoring ignores IDs owned only by nested quotes", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/bob"><span>Bob</span><span>@bob</span></a></div>
      <div data-testid="tweetText">Fallback first post</div>
      <a href="/bob/status/1"><time>first</time></a>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Wrong outer selection</div>
      <a href="/alice/status/2"><time>second</time></a>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/eve"><span>Eve</span><span>@eve</span></a></div>
        <div data-testid="tweetText">Target ID is only here</div>
        <a href="/eve/status/99"><time>nested</time></a>
      </article>
    </article>
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <div data-testid="tweetText">Later Alice post</div>
      <a href="/alice/status/3"><time>third</time></a>
    </article>`;
    const result = await scrapeTweet("https://x.com/i/status/99", { html });

    expect(result.structured.author_handle).toBe("bob");
    expect(result.structured.tweets.map((tweet) => tweet.text)).toEqual(["Fallback first post"]);
    expect(result.structured.quoted_tweet).toBeNull();
  });
  test("X timeline treats empty injected HTML as an offline capture", async () => {
    expect(
      scrapeTimeline("https://x.com/alice", {
        html: "",
        media: "offline-sentinel",
      }),
    ).rejects.toBeInstanceOf(PresetDriftError);
  });
  test("X profile requires its username root", async () => {
    expect(
      scrapeProfile("https://x.com/nobody", {
        html: fixture("preset-audit-x-profile-no-username.html"),
      }),
    ).rejects.toThrow("core structure missing");
  });
  test("X profile rejects an incompatible explicit route as usage", async () => {
    expect(
      scrapeProfile("https://x.com/alice/status/1", {
        html: "",
        media: "offline-sentinel",
      }),
    ).rejects.toBeInstanceOf(AgentscrapeUsageError);
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
    expect(
      scrapeArticle("https://x.com/i/article/1", {
        html: '<article data-testid="tweet"><div data-testid="tweetText">Ordinary post</div></article>',
      }),
    ).rejects.toThrow("reader container not found");
  });
  test("X article routes include canonical, trailing, and status forms", async () => {
    const html =
      '<div data-testid="twitterArticleReadView"><div data-testid="twitterArticleRichTextView"><p>Body</p></div></div>';
    for (const url of [
      "https://x.com/i/article/1",
      "https://x.com/alice/article/1/photo/1?view=full#media",
      "https://twitter.com/alice/articles/1",
      "https://x.com/alice/status/1",
    ]) {
      const result = await scrapeArticle(url, { html });
      expect(result.structured.warnings.map((warning) => warning.code)).toEqual([
        "partial_article_extract",
      ]);
    }
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
    ).rejects.toBeInstanceOf(AgentscrapeTimeoutError);
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
    await expect(
      scrapeSearchConversation("https://deepwiki.com/search/example_abc", {
        html: fixture("deepwiki-search-auth.html"),
      }),
    ).rejects.toThrow("requires authentication");
    for (const html of [
      '<div data-testid="search-loading-shell"></div>',
      fixture("deepwiki-search-generating.html"),
    ])
      await expect(
        scrapeSearchConversation("https://deepwiki.com/search/example_abc", { html }),
      ).rejects.toBeInstanceOf(AgentscrapeTimeoutError);
    await expect(
      scrapeSearchConversation("https://deepwiki.com/search/example_abc", {
        html: fixture("deepwiki-search-incomplete.html"),
      }),
    ).rejects.toThrow("incomplete");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  convertHtml,
  envelopeExitCode,
  extractStatusId,
  fetchMarkdown,
  registerContentHandler,
  type ScrapeResult,
  ScrapeSchema,
} from "../src/api";
import type { ExtractionEnvelope } from "../src/schemas";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-api-"));
  temporary.push(path);
  return path;
}

describe("public TypeScript API", () => {
  test("exports synchronous conversion and URL helpers", () => {
    expect(convertHtml("<h1>Hello</h1>")).toContain("# Hello");
    expect(extractStatusId("https://x.com/a/status/123?s=20")).toBe("123");
    expect(extractStatusId("https://x.com/a")).toBeNull();
    expect(registerContentHandler).toBeFunction();
    expect(ScrapeSchema).toBeFunction();
  });
  test("direct Markdown fetch returns a structured result without a browser", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# Direct\n\nBody", { headers: { "content-type": "text/markdown" } }),
    });
    try {
      const value = (await fetchMarkdown(
        `http://127.0.0.1:${server.port}/page.md`,
      )) as ScrapeResult;
      expect(value.markdown).toBe("# Direct\n\nBody");
      expect(value.structured.toMarkdown()).toBe(value.markdown);
      expect(value.full_html).toBe("");
    } finally {
      server.stop(true);
    }
  });
  test("direct Markdown envelope retains version 1 and classified limits", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("12345") });
    try {
      const envelope = (await fetchMarkdown(`http://127.0.0.1:${server.port}/page.md`, {
        envelope: true,
        maxContentBytes: 4,
      })) as ExtractionEnvelope;
      expect(envelope.schema_version).toBe("1");
      expect(envelope.status).toBe("failure");
      expect(envelope.failure?.failure_class).toBe("output_limit_exceeded");
      expect(envelopeExitCode(envelope)).toBe(1);
    } finally {
      server.stop(true);
    }
  });
  test("automatically routes status-form X Articles from rendered structure", async () => {
    const html = readFileSync(
      join(import.meta.dir, "corpus/x-article/sample-001/page.html"),
      "utf8",
    );
    const envelope = (await fetchMarkdown("https://x.com/i/status/2047794182463394072", {
      envelope: true,
      html,
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("success");
    expect(envelope.extractor.implementation).toBe("x-article");
    expect(envelope.metadata).toMatchObject({
      content_type: "article",
      content_kind: "article",
      content_item_count: 1,
    });
    expect(envelope.metadata?.title).toBe("Introducing Articles on X");
    expect(envelope.metadata?.source_id).toBe("2047794182463394072");
    expect(envelope.artifacts[0]?.content).toContain("# Introducing Articles on X");
  });
  test("keeps ordinary status pages on the X tweet contract", async () => {
    const html = readFileSync(
      join(import.meta.dir, "corpus/x-tweet/sample-001/selected.html"),
      "utf8",
    );
    const envelope = (await fetchMarkdown("https://x.com/i/status/2013334888515088526", {
      envelope: true,
      html,
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("success");
    expect(envelope.extractor.implementation).toBe("x-tweet");
    expect(envelope.metadata).toMatchObject({
      content_type: "social_post",
      content_kind: "post",
      content_item_count: 1,
      source_id: "2013334888515088526",
    });
  });
  test("classifies same-author X status sequences as threads", async () => {
    const html = readFileSync(join(import.meta.dir, "fixtures/x-thread-short.html"), "utf8");
    const envelope = (await fetchMarkdown("https://x.com/i/status/1001", {
      envelope: true,
      html,
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("success");
    expect(envelope.extractor.implementation).toBe("x-tweet");
    expect(envelope.metadata).toMatchObject({
      content_type: "social_post",
      content_kind: "thread",
      content_item_count: 2,
      source_id: "1001",
    });
  });
  test("fails closed as an Article when status-form Article structure is malformed", async () => {
    const envelope = (await fetchMarkdown("https://x.com/i/status/2047794182463394072", {
      envelope: true,
      html: '<html><body><div data-testid="twitterArticleReadView"><div data-testid="twitterArticleRichTextView"></div></div></body></html>',
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("failure");
    expect(envelope.extractor.implementation).toBe("x-article");
    expect(envelope.failure?.failure_class).toBe("malformed_provider_output");
  });
  test("classifies a bare X timeline shell as malformed provider output", async () => {
    const envelope = (await fetchMarkdown("https://x.com/sampleuser", {
      envelope: true,
      preset: "x-timeline",
      html: '<div id="primaryColumn"></div>',
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("failure");
    expect(envelope.extractor.implementation).toBe("x-timeline");
    expect(envelope.failure?.failure_class).toBe("malformed_provider_output");
  });
  test("keeps explicit X presets strict for mismatched rendered DOM", async () => {
    const articleAsTweet = (await fetchMarkdown("https://x.com/i/status/2047794182463394072", {
      envelope: true,
      preset: "x-tweet",
      html: '<html><body><div data-testid="twitterArticleReadView"><h1>Article</h1><div data-testid="twitterArticleRichTextView"><p>Body</p></div></div></body></html>',
    })) as ExtractionEnvelope;
    const tweetAsArticle = (await fetchMarkdown("https://x.com/i/status/2013334888515088526", {
      envelope: true,
      preset: "x-article",
      html: '<article data-testid="tweet"><div data-testid="tweetText">Ordinary post</div></article>',
    })) as ExtractionEnvelope;

    expect(articleAsTweet.status).toBe("failure");
    expect(articleAsTweet.extractor.implementation).toBe("x-tweet");
    expect(tweetAsArticle.status).toBe("failure");
    expect(tweetAsArticle.extractor.implementation).toBe("x-article");
  });
  test("standalone job submission is atomic and rejects indexed state before publication", async () => {
    const home = temp();
    const script = `import { submitScrapeJob } from ${JSON.stringify(join(import.meta.dir, "../src/api.ts"))}; console.log(submitScrapeJob("https://example.com/a", "/tmp/a.md", {summarize:true, frontmatter:{url:"https://example.com/a"}}));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    const path = stdout.trim();
    expect(existsSync(path)).toBeTrue();
    expect(parseYaml(readFileSync(path, "utf8"))).toEqual({
      url: "https://example.com/a",
      destination: "/tmp/a.md",
      summarize: true,
      frontmatter: { url: "https://example.com/a" },
    });

    const rejectedHome = temp();
    const rejected = `import { submitScrapeJob } from ${JSON.stringify(join(import.meta.dir, "../src/api.ts"))}; try { submitScrapeJob("https://example.com/a", "/tmp/a.md", {indexer:"agentbrain"}); } catch { process.exit(7); }`;
    const rejectedChild = Bun.spawn([process.execPath, "-e", rejected], {
      env: { ...process.env, HOME: rejectedHome },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await rejectedChild.exited).toBe(7);
    expect(existsSync(join(rejectedHome, ".local/share/agentscrape/queue"))).toBeFalse();
  });
});

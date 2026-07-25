import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
function queueEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.AGENTSCRAPE_DATA_HOME;
  delete env.XDG_DATA_HOME;
  return { ...env, ...overrides };
}
async function runSubmission(
  body: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `import { submitScrapeJob } from ${JSON.stringify(join(import.meta.dir, "../src/api.ts"))};\n${body}`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
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
  test("an explicit X Article preset accepts the official status-form route", async () => {
    const html = readFileSync(
      join(import.meta.dir, "corpus/x-article/sample-001/page.html"),
      "utf8",
    );
    const envelope = (await fetchMarkdown("https://x.com/i/status/2047794182463394072", {
      envelope: true,
      preset: "x-article",
      html,
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("success");
    expect(envelope.extractor.implementation).toBe("x-article");
    expect(envelope.metadata).toMatchObject({
      content_type: "article",
      source_id: "2047794182463394072",
    });
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
  test("projects a quote-only X post without counting the quote as a thread item", async () => {
    const html = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/alice"><span>Alice</span><span>@alice</span></a></div>
      <a href="/alice/status/1">Open post</a>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/bob"><span>Bob</span><span>@bob</span></a></div>
        <div data-testid="tweetText">Quoted content</div>
        <a href="/bob/status/2">Open quote</a>
        <a href="/bob/status/2"><time>quoted time</time></a>
      </article>
    </article>`;
    const envelope = (await fetchMarkdown("https://x.com/alice/status/1", {
      envelope: true,
      html,
    })) as ExtractionEnvelope;

    expect(envelope.status).toBe("success");
    expect(envelope.metadata).toMatchObject({
      content_type: "social_post",
      content_kind: "post",
      content_item_count: 1,
    });
    expect(envelope.artifacts[0]?.content).toContain("**Quoted Tweet:**");
    expect(envelope.artifacts[0]?.content).toContain("Quoted content");
    expect(envelope.relations).toContainEqual({
      relation_type: "references",
      target_url: "https://x.com/bob/status/2",
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
  test("classifies DeepWiki loading and generating states as retryable timeouts", async () => {
    for (const [url, name] of [
      ["https://deepwiki.com/acme/widget", "deepwiki-wiki-page-loading.html"],
      ["https://deepwiki.com/search/example_abc", "deepwiki-search-generating.html"],
    ] as const) {
      const envelope = (await fetchMarkdown(url, {
        envelope: true,
        html: readFileSync(join(import.meta.dir, "fixtures", name), "utf8"),
      })) as ExtractionEnvelope;
      expect(envelope).toMatchObject({
        status: "failure",
        failure: { failure_class: "timeout", retryable: true },
      });
    }
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
  test("separates explicit X route misuse from captured DOM drift", async () => {
    const routeMismatch = (await fetchMarkdown("https://x.com/alice", {
      envelope: true,
      preset: "x-tweet",
      html: "<html></html>",
    })) as ExtractionEnvelope;
    const capturedDrift = (await fetchMarkdown("https://x.com/alice/status/1", {
      envelope: true,
      preset: "x-tweet",
      html: "<html></html>",
    })) as ExtractionEnvelope;
    expect(routeMismatch.failure?.failure_class).toBe("invalid_request");
    expect(capturedDrift.failure?.failure_class).toBe("malformed_provider_output");
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
    expect(tweetAsArticle.failure?.failure_class).toBe("malformed_provider_output");
  });
  test("standalone submission resolves an explicit queue root at call time", async () => {
    const root = temp();
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    const importTimeRoot = join(root, "import-time-explicit");
    const callTimeRoot = join(root, "call-time-explicit");
    const result = await runSubmission(
      `process.env.AGENTSCRAPE_DATA_HOME = ${JSON.stringify(callTimeRoot)};
console.log(submitScrapeJob("https://example.com/a", "/tmp/a.md", { summarize: true, frontmatter: { url: "https://example.com/a" } }));`,
      queueEnvironment(home, {
        AGENTSCRAPE_DATA_HOME: importTimeRoot,
        XDG_DATA_HOME: xdg,
      }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const path = result.stdout.trim();
    expect(dirname(path)).toBe(join(callTimeRoot, "queue"));
    expect(existsSync(path)).toBeTrue();
    expect(parseYaml(readFileSync(path, "utf8"))).toEqual({
      url: "https://example.com/a",
      destination: "/tmp/a.md",
      summarize: true,
      frontmatter: { url: "https://example.com/a" },
    });
    expect(existsSync(join(importTimeRoot, "queue"))).toBeFalse();
    expect(existsSync(join(xdg, "agentscrape", "queue"))).toBeFalse();
    expect(existsSync(join(home, ".local", "share", "agentscrape", "queue"))).toBeFalse();
  });

  test("standalone submission uses the XDG queue fallback", async () => {
    const root = temp();
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    const result = await runSubmission(
      'console.log(submitScrapeJob("https://example.com/xdg", "/tmp/xdg.md"));',
      queueEnvironment(home, { XDG_DATA_HOME: xdg }),
    );

    expect(result.code).toBe(0);
    const path = result.stdout.trim();
    expect(dirname(path)).toBe(join(xdg, "agentscrape", "queue"));
    expect(existsSync(path)).toBeTrue();
    expect(existsSync(join(home, ".local", "share", "agentscrape", "queue"))).toBeFalse();
  });

  test("standalone submission retains the HOME queue default", async () => {
    const home = temp();
    const result = await runSubmission(
      'console.log(submitScrapeJob("https://example.com/home", "/tmp/home.md"));',
      queueEnvironment(home),
    );

    expect(result.code).toBe(0);
    const path = result.stdout.trim();
    expect(dirname(path)).toBe(join(home, ".local", "share", "agentscrape", "queue"));
    expect(existsSync(path)).toBeTrue();
  });

  test("invalid configured queue roots fail without fallback publication", async () => {
    for (const configured of ["explicit", "xdg"] as const) {
      const root = temp();
      const home = join(root, "home");
      const xdg = join(root, "xdg");
      const invalid = `relative-${configured}-${Date.now()}`;
      const env = queueEnvironment(home, {
        XDG_DATA_HOME: configured === "xdg" ? invalid : xdg,
        ...(configured === "explicit" ? { AGENTSCRAPE_DATA_HOME: invalid } : {}),
      });
      const result = await runSubmission(
        `try { submitScrapeJob("https://example.com/invalid", "/tmp/invalid.md"); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }`,
        env,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        `${configured === "explicit" ? "AGENTSCRAPE_DATA_HOME" : "XDG_DATA_HOME"} must be a non-empty absolute path without NUL bytes`,
      );
      expect(existsSync(join(xdg, "agentscrape", "queue"))).toBeFalse();
      expect(existsSync(join(home, ".local", "share", "agentscrape", "queue"))).toBeFalse();
    }
  });

  test("frozen indexed and source submissions reject before queue resolution", async () => {
    for (const options of [{ indexer: "agentbrain" }, { source: "test-ingress" }]) {
      const home = temp();
      const result = await runSubmission(
        `try { submitScrapeJob("https://example.com/frozen", "/tmp/frozen.md", ${JSON.stringify(options)}); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }`,
        queueEnvironment(home, { AGENTSCRAPE_DATA_HOME: "invalid-relative-root" }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(
        "indexed scrape queue submissions are frozen; use the dedicated ingestion command",
      );
      expect(existsSync(join(home, ".local", "share", "agentscrape", "queue"))).toBeFalse();
    }
  });
});

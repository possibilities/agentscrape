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

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBrowserProfile, withBrowserProfile } from "../src/browser";
import { checkInvariants } from "../src/canary";
import {
  atomicSample,
  CORPUS_AGGREGATE_MAX_BYTES,
  CORPUS_ARTIFACT_MAX_BYTES,
  loadMeta,
  runSample,
  testCorpus,
} from "../src/corpus";
import { isGithubUrl, parseGithubUrl } from "../src/github";
import { convertHtml, fencedCodeBlock, renderRichMarkdown, safeLink } from "../src/html";
import { loadRegistry } from "../src/presets";
import { retryDelay } from "../src/queue";
import { isSensitiveName, redactDiagnostic, sanitizeErrorInPlace } from "../src/redaction";
import { DeepWikiSearchConversation, DeepWikiWikiPage } from "../src/schemas";
import { __testChildExitTeardown, runProcess } from "../src/subprocess";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function _temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-test-"));
  temporary.push(path);
  return path;
}

describe("HTML and rich text", () => {
  test("drops active content and emits ATX Markdown", () => {
    const markdown = convertHtml(
      "<main><h1>Hello</h1><script>bad()</script><style>x{}</style><p>World</p></main>",
    );
    expect(markdown).toContain("# Hello");
    expect(markdown).toContain("World");
    expect(markdown).not.toContain("bad()");
  });
  test("fenced code helper adapts fences, filters info tokens, and preserves endings", () => {
    const cases = [
      ["a```b", "ts", "````ts\na```b\n````"],
      ["a````b", "typescript", "`````typescript\na````b\n`````"],
      ["a`````b", "c++", "``````c++\na`````b\n``````"],
      ["value", "unsafe token", "```\nvalue\n```"],
      ["value", `x${"y".repeat(64)}`, "```\nvalue\n```"],
      ["", "", "```\n```"],
      ["value", "", "```\nvalue\n```"],
      ["value\n", "", "```\nvalue\n```"],
      ["value\n\n", "", "```\nvalue\n\n```"],
    ] as const;
    for (const [code, language, expected] of cases)
      expect(fencedCodeBlock(code, language)).toBe(expected);
  });
  test("fences multi-megabyte alternating-backtick content without argument overflow", () => {
    const code = "`x".repeat(1_100_000);
    const block = fencedCodeBlock(code);
    expect(block.startsWith("```\n")).toBeTrue();
    expect(block.endsWith("\n```")).toBeTrue();
    expect(block.slice(4, -4)).toBe(code);
  });
  test("adaptive HTML fences preserve the verified code round trip", () => {
    const markdown = renderRichMarkdown(
      '<pre><code class="language-ts">const fence = "```";\n</code></pre>',
    );
    expect(markdown).toContain("````ts");
    expect(markdown).toContain('const fence = "```";');
  });
  test("safe links resolve HTTP references and reject active schemes", () => {
    expect(safeLink("/guide", "https://docs.example/base")).toBe("https://docs.example/guide");
    expect(safeLink("javascript:alert(1)", "https://docs.example")).toBeNull();
  });
});

describe("shared redaction", () => {
  test("recognizes tokenized and compact secret names", () => {
    for (const name of ["api_key", "client-secret", "oauth_state", "sessionToken"]) {
      expect(isSensitiveName(name)).toBeTrue();
    }
    expect(isSensitiveName("page")).toBeFalse();
  });
  test("removes headers, bearer values, JWTs, and assignments", () => {
    const value = redactDiagnostic(
      "Authorization: Bearer abc.def.ghi\napi_key=topsecret token: another eyJaaa.eyJbbb.ccc",
    );
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("another");
    expect(value).not.toContain("eyJaaa");
    expect(value).toContain("[REDACTED]");
    expect(redactDiagnostic("Screenshot: /tmp/private-debug.png")).toBe("Screenshot: [REDACTED]");
  });
  test("bounds diagnostics by UTF-8 bytes", () => {
    expect(
      new TextEncoder().encode(redactDiagnostic("λ".repeat(2000))).byteLength,
    ).toBeLessThanOrEqual(1024);
  });
  test("rebuilds public stacks without recursively changing aggregate causes", () => {
    const child = new Error("child remains unchanged");
    const cause = new Error("cause remains unchanged");
    const error = new AggregateError([child], "public message\napi_key=message-secret", {
      cause,
    });
    error.name = "unsafe\nidentity";
    error.stack =
      "unsafe identity: public message\nraw custom api_key=stack-secret\n/Users/private/source.ts";

    expect(sanitizeErrorInPlace(error)).toBe(error);
    expect(error.message).toBe("public message api_key=[REDACTED]");
    expect(error.stack).toBe("Error: public message api_key=[REDACTED]");
    expect(error.stack).not.toContain("stack-secret");
    expect(error.stack).not.toContain("/Users/private");
    expect(error.cause).toBe(cause);
    expect(error.errors).toEqual([child]);
    expect(cause.message).toBe("cause remains unchanged");
    expect(child.message).toBe("child remains unchanged");
  });
});

describe("browser request context", () => {
  test("keeps concurrent profile selection isolated", async () => {
    const [first, second] = await Promise.all([
      withBrowserProfile("first", async () => {
        await Bun.sleep(10);
        return currentBrowserProfile();
      }),
      withBrowserProfile("second", async () => {
        await Bun.sleep(1);
        return currentBrowserProfile();
      }),
    ]);
    expect(first).toBe("first");
    expect(second).toBe("second");
    expect(currentBrowserProfile()).toBeNull();
  });
});

describe("bounded subprocess and cancellation", () => {
  test("captures explicit argv without a shell", async () => {
    const result = await runProcess(["printf", "%s", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });
  test("times out and reaps a long process", async () => {
    const result = await runProcess(["sleep", "2"], { timeoutMs: 10 });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeTrue();
  });
  test("unrefs after rejected child-exit observation without marking it fulfilled", async () => {
    const error = new Error("synthetic child.exited rejection");
    const observed = await __testChildExitTeardown(Promise.reject(error));
    expect(observed.rejectionCallbackInvoked).toBeTrue();
    expect(observed.cause?.kind).toBe("child_exit_error");
    expect(observed.cause?.error).toBe(error);
    expect(Object.isFrozen(observed.cause)).toBeTrue();
    expect(observed.exitFulfilled).toBeFalse();
    expect(observed.unrefCalls).toBe(1);
  });
  test("does not unref after a fulfilled numeric child exit", async () => {
    const observed = await __testChildExitTeardown(Promise.resolve(17));
    expect(observed.exitFulfilled).toBeTrue();
    expect(observed.exitCode).toBe(17);
    expect(observed.rejectionCallbackInvoked).toBeFalse();
    expect(observed.cause).toBeNull();
    expect(observed.unrefCalls).toBe(0);
  });
  test("makes a non-preaborted zero timeout deterministic", async () => {
    const result = await runProcess([process.execPath, "-e", 'process.stdout.write("too late")'], {
      timeoutMs: 0,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
    expect(result.timedOut).toBeTrue();
    expect(result.truncated).toBeFalse();
  });
  test("returns pre-aborted cancellation before missing-executable lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess([join(_temp(), "missing-executable")], {
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe("operation cancelled");
    expect(result.timedOut).toBeFalse();
    expect(result.truncated).toBeFalse();
  });
  test("lets an abort observed during listener registration beat a zero timeout", async () => {
    const controller = new AbortController();
    const signal = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener(_type: string, listener: Parameters<AbortSignal["addEventListener"]>[1]) {
        controller.signal.addEventListener("abort", listener);
        controller.abort();
      },
      removeEventListener(
        _type: string,
        listener: Parameters<AbortSignal["removeEventListener"]>[1],
      ) {
        controller.signal.removeEventListener("abort", listener);
      },
    } as unknown as AbortSignal;
    const result = await runProcess(["sleep", "2"], { timeoutMs: 0, signal });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe("operation cancelled");
    expect(result.timedOut).toBeFalse();
  });
  test("honors AbortSignal cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await runProcess(["sleep", "2"], { timeoutMs: 5000, signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe("operation cancelled");
  });
  test("bounds captured output", async () => {
    const result = await runProcess(["printf", "%s", "x".repeat(100)], {
      maxOutputBytes: 10,
    });
    expect(result.stdout).toBe("x".repeat(10));
    expect(result.truncated).toBeTrue();
  });
  test("treats the first nonempty byte as overflow when the output cap is zero", async () => {
    const result = await runProcess(["printf", "%s", "x"], { maxOutputBytes: 0 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBeFalse();
    expect(result.truncated).toBeTrue();
  });
});

describe("GitHub URL routing", () => {
  test("parses repo, blob, issue, pull, tree, compare, profile, and gist shapes", () => {
    expect(parseGithubUrl("https://github.com/cli/cli")?.type).toBe("repo");
    expect(parseGithubUrl("https://github.com/cli/cli/blob/main/README.md")?.type).toBe("blob");
    expect(parseGithubUrl("https://github.com/cli/cli/issues/1")?.type).toBe("issue");
    expect(parseGithubUrl("https://github.com/cli/cli/pull/1")?.type).toBe("pr");
    expect(parseGithubUrl("https://github.com/cli/cli/tree/main/docs")?.type).toBe("tree");
    expect(parseGithubUrl("https://github.com/cli/cli/compare/main...next")?.type).toBe("compare");
    expect(parseGithubUrl("https://github.com/cli")?.type).toBe("profile");
    expect(parseGithubUrl("https://gist.github.com/user/abcdef")?.type).toBe("gist");
  });
  test("leaves unrelated and raw content hosts on normal routing", () => {
    expect(isGithubUrl("https://raw.githubusercontent.com/a/b/main/x")).toBeFalse();
    expect(parseGithubUrl("https://example.com/a")).toBeNull();
  });
});

describe("corpus, canary, and queue contracts", () => {
  test("the complete versioned corpus replays offline", async () => {
    const result = await testCorpus();
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(27);
  });
  test("corpus samples use private modes and preflight per-file and aggregate byte caps", () => {
    const root = _temp();
    const directory = join(root, "private-sample");
    const exact = "x".repeat(CORPUS_ARTIFACT_MAX_BYTES);
    const sample = atomicSample(directory, { "meta.yaml": "version: 1\n", "page.html": exact });
    expect(lstatSync(sample).mode & 0o077).toBe(0);
    for (const name of readdirSync(sample))
      expect(lstatSync(join(sample, name)).mode & 0o077).toBe(0);

    const oversizedDirectory = join(root, "oversized");
    expect(() =>
      atomicSample(oversizedDirectory, {
        "meta.yaml": "version: 1\n",
        "page.html": `${exact}x`,
      }),
    ).toThrow(`${CORPUS_ARTIFACT_MAX_BYTES}-byte limit`);
    expect(existsSync(oversizedDirectory)).toBeFalse();

    const aggregateDirectory = join(root, "aggregate");
    expect(() =>
      atomicSample(aggregateDirectory, {
        "meta.yaml": "m",
        "page.html": exact,
        "selected.html": exact,
        "expected.md": exact,
      }),
    ).toThrow(`${CORPUS_AGGREGATE_MAX_BYTES}-byte aggregate limit`);
    expect(existsSync(aggregateDirectory)).toBeFalse();
  });

  test("historical negative names reject the wrong dedicated failure category", async () => {
    const registry = loadRegistry();
    const tweetDirectory = join(import.meta.dir, "corpus/x-tweet/sample-002");
    const tweetMeta = loadMeta(tweetDirectory);
    tweetMeta.failure!.type = "ValueError";
    await expect(runSample(tweetDirectory, tweetMeta, registry.byName("x-tweet")!)).rejects.toThrow(
      "expected failure type ValueError",
    );

    const linksDirectory = join(import.meta.dir, "corpus/docs-sidebar/sample-002");
    const linksMeta = loadMeta(linksDirectory);
    linksMeta.failure!.type = "RuntimeError";
    await expect(
      runSample(linksDirectory, linksMeta, registry.byName("docs-sidebar")!),
    ).rejects.toThrow("expected failure type RuntimeError");
  });
  test("canary invariants are semantic rather than exact text", () => {
    const wiki = new DeepWikiWikiPage({ title: "T", markdown: "x".repeat(300) });
    expect(
      checkInvariants({ require_title: true, min_markdown_chars: 200 }, wiki, wiki.toMarkdown()),
    ).toEqual([]);
    expect(checkInvariants({ require_title: true }, new DeepWikiWikiPage(), "")).toContain(
      "structured.title is empty",
    );
    expect(
      checkInvariants({ min_rounds: 1 }, new DeepWikiSearchConversation({ rounds: [] }), ""),
    ).toContain("rounds count 0 is below minimum 1");
  });
  test("queue retry backoff is bounded exponential", () => {
    expect([1, 2, 3, 10].map((attempt) => retryDelay(attempt, 1, 8))).toEqual([1, 2, 4, 8]);
  });
  test("manifest description is the required action phrase", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(manifest.description).toBe(
      "Fetch and extract web content through an agent-friendly Bun CLI",
    );
  });
  test("tracked source identity uses only the standalone name", () => {
    const expected = readFileSync(
      join(import.meta.dir, "fixtures/extraction-generic.expected.json"),
      "utf8",
    );
    expect(expected).toContain('"name": "agentscrape"');
  });
});

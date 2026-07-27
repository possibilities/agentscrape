import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import {
  AgentscrapeAuthError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
} from "../src/errors";
import { fetchGithubIfApplicable } from "../src/github";
import type { ProcessOptions, ProcessResult } from "../src/subprocess";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const temporary: string[] = [];
function restoreEnv(name: "HOME" | "PATH", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restoreEnv("PATH", originalPath);
  restoreEnv("HOME", originalHome);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fakeGhExecutable(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agentscrape-gh-"));
  temporary.push(directory);
  const executable = join(directory, "gh");
  writeFileSync(executable, `#!/bin/sh\nset -eu\n${script}\n`);
  chmodSync(executable, 0o755);
  return directory;
}

type FakeResponse = Partial<Omit<ProcessResult, "argv">> & { stdout?: string };
type FakeCall = { argv: string[]; options: ProcessOptions };
function fakeProcess(
  handler: (
    argv: string[],
    options: ProcessOptions,
    index: number,
  ) => FakeResponse | Promise<FakeResponse>,
): {
  calls: FakeCall[];
  runProcess: (argv: string[], options?: ProcessOptions) => Promise<ProcessResult>;
} {
  const calls: FakeCall[] = [];
  return {
    calls,
    runProcess: async (argv, options = {}) => {
      const index = calls.length;
      calls.push({ argv: [...argv], options: { ...options } });
      const response = await handler(argv, options, index);
      return {
        argv: [...argv],
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...response,
      };
    },
  };
}
function sequence(...responses: FakeResponse[]) {
  return fakeProcess((_argv, _options, index) => {
    const response = responses[index];
    if (!response) throw new Error(`unexpected subprocess call ${index + 1}`);
    return response;
  });
}
function codeContents(markdown: string): string[] {
  return new MarkdownIt("commonmark")
    .parse(markdown, {})
    .filter((token) => token.type === "fence")
    .map((token) => token.content);
}

describe("GitHub and Gist fetching through explicit argv", () => {
  test("uses PATH-local gh through discovery and runProcess with noninteractive exact argv", async () => {
    const directory = fakeGhExecutable(`
[ "\${GH_NO_PROMPT-}" = "1" ]
[ "$#" -eq 6 ]
[ "$1" = "issue" ]
[ "$2" = "view" ]
[ "$3" = "--repo" ]
[ "$4" = "o/r" ]
[ "$5" = "--" ]
[ "$6" = "7" ]
printf 'offline issue'`);
    process.env.PATH = directory;
    process.env.HOME = directory;

    const result = await fetchGithubIfApplicable("https://github.com/o/r/issues/7");
    expect(result?.markdown).toBe("offline issue");
  });

  test("repository README resolves metadata then raw content under one byte budget", async () => {
    const process = sequence({ stdout: "a.md\n" }, { stdout: "hello" });
    const result = await fetchGithubIfApplicable("https://github.com/o/r", undefined, {
      runProcess: process.runProcess,
      maxGhOutputBytes: 10,
    });
    expect(result?.markdown).toBe("hello");
    expect(process.calls.map((call) => call.options.maxOutputBytes)).toEqual([10, 5]);
    expect(process.calls.every((call) => call.argv[0] === "gh")).toBeTrue();
  });

  test("failed gh stdout is debited across fallback calls and the next call gets the remainder", async () => {
    const process = sequence(
      { stdout: "x", stderr: "not found (HTTP 404)", exitCode: 1 },
      { stdout: "b/d\n" },
      { stdout: "ok" },
    );
    const result = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/b/d/x.txt",
      undefined,
      { runProcess: process.runProcess, maxGhOutputBytes: 7 },
    );
    expect(result?.markdown).toContain("ok");
    expect(process.calls.map((call) => call.options.maxOutputBytes)).toEqual([7, 6, 2]);
  });

  test("defensively rejects runners that return more stdout than their cap", async () => {
    const process = sequence({ stdout: "123456" });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        runProcess: process.runProcess,
        maxGhOutputBytes: 5,
      }),
    ).rejects.toMatchObject({
      message: "GitHub operation exceeded the aggregate gh output limit",
      retryable: false,
    });
  });

  test("counts aggregate stdout at exact UTF-8 byte boundaries", async () => {
    const exact = sequence({ stdout: "λλλ" });
    expect(
      (
        await fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
          runProcess: exact.runProcess,
          maxGhOutputBytes: 6,
        })
      )?.markdown,
    ).toBe("λλλ");

    const overflow = sequence({ stdout: "λλλ" });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        runProcess: overflow.runProcess,
        maxGhOutputBytes: 5,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeProviderError);
  });

  test("Gist scanner ignores blank CRLF lines and permits exactly the configured cap", async () => {
    const process = sequence(
      { stdout: "\r\none.md\r\n\r\ntwo.js\r\n\n" },
      { stdout: "# One\n" },
      { stdout: "two();\n" },
    );
    const result = await fetchGithubIfApplicable("https://gist.github.com/user/abcdef", undefined, {
      runProcess: process.runProcess,
      maxGistFiles: 2,
    });
    expect(result?.markdown).toContain("## one.md");
    expect(result?.markdown).toContain("## two.js");
    expect(process.calls).toHaveLength(3);
    expect(process.calls.slice(1).every((call) => call.argv.includes("--raw"))).toBeTrue();
  });

  test("rejects a Gist filename beyond the configured cap before raw calls", async () => {
    const process = sequence({ stdout: "one\ntwo\nthree\n" });
    await expect(
      fetchGithubIfApplicable("https://gist.github.com/user/abcdef", undefined, {
        runProcess: process.runProcess,
        maxGistFiles: 2,
      }),
    ).rejects.toMatchObject({
      message: "GitHub Gist exceeded the file-count limit",
      retryable: false,
    });
    expect(process.calls).toHaveLength(1);
  });

  test("uses production timeout and output defaults on the first injected call", async () => {
    const process = sequence({ stdout: "issue" });
    await fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
      now: () => 123,
      runProcess: process.runProcess,
    });
    expect(process.calls[0]?.options.timeoutMs).toBe(60_000);
    expect(process.calls[0]?.options.maxOutputBytes).toBe(16_000_000);
  });

  test("shares one absolute deadline from metadata through raw content and pandoc", async () => {
    let now = 0;
    const process = fakeProcess((argv, _options, index) => {
      if (index === 0) {
        now = 20;
        return { stdout: "README.rst\n" };
      }
      if (index === 1) {
        now = 70;
        return { stdout: "Heading\n=======\n" };
      }
      expect(argv[0]).toBe("pandoc");
      return { stdout: "# Heading\n" };
    });
    const result = await fetchGithubIfApplicable("https://github.com/o/r", undefined, {
      now: () => now,
      runProcess: process.runProcess,
      deadlineMs: 100,
    });
    expect(result?.markdown).toBe("# Heading\n");
    expect(process.calls.map((call) => call.options.timeoutMs)).toEqual([100, 80, 30]);
    expect(process.calls[2]?.options.maxOutputBytes).toBe(4_000_000);
  });

  test("rejects an injected runner that returns after the absolute deadline", async () => {
    let now = 0;
    const process = fakeProcess(() => {
      now = 101;
      return { stdout: "late" };
    });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        now: () => now,
        runProcess: process.runProcess,
        deadlineMs: 100,
      }),
    ).rejects.toMatchObject({
      message: "GitHub operation deadline exceeded",
      errorClass: "timeout",
    });
  });

  test("profile, compare, and tree metadata time out before JSON parsing", async () => {
    for (const url of [
      "https://github.com/person",
      "https://github.com/o/r/compare/a...b",
      "https://github.com/o/r/tree/main/docs",
    ]) {
      const process = sequence({ stdout: "not JSON" });
      let postResultChecks = 0;
      const now = () => {
        if (process.calls.length === 0) return 0;
        postResultChecks += 1;
        return postResultChecks === 1 ? 0 : 100;
      };

      await expect(
        fetchGithubIfApplicable(url, undefined, {
          now,
          runProcess: process.runProcess,
          deadlineMs: 100,
        }),
      ).rejects.toBeInstanceOf(AgentscrapeTimeoutError);
      expect(process.calls).toHaveLength(1);
      expect(postResultChecks).toBe(2);
    }
  });

  test("runner rejection preserves cancellation precedence for gh and pandoc", async () => {
    const ghController = new AbortController();
    const ghFailure = new Error("gh runner failed");
    const gh = fakeProcess(() => {
      ghController.abort(new Error("cancelled gh"));
      throw ghFailure;
    });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", ghController.signal, {
        runProcess: gh.runProcess,
      }),
    ).rejects.toMatchObject({ message: "cancelled gh", errorClass: "cancelled" });

    const pandocController = new AbortController();
    const pandocFailure = new Error("pandoc runner failed");
    const pandoc = fakeProcess((_argv, _options, index) => {
      if (index === 0) return { stdout: "Heading\n=======\n" };
      pandocController.abort(new Error("cancelled pandoc"));
      throw pandocFailure;
    });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/blob/main/doc.rst", pandocController.signal, {
        runProcess: pandoc.runProcess,
      }),
    ).rejects.toMatchObject({ message: "cancelled pandoc", errorClass: "cancelled" });

    const originalFailure = new Error("unaltered runner failure");
    const unabridged = fakeProcess(() => {
      throw originalFailure;
    });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        runProcess: unabridged.runProcess,
      }),
    ).rejects.toBe(originalFailure);
  });

  test("caller cancellation wins over timeout, truncation, overflow, and deadline", async () => {
    let now = 0;
    const controller = new AbortController();
    const process = fakeProcess(() => {
      now = 100;
      controller.abort(new Error("caller stopped"));
      return { stdout: "too much", timedOut: true, truncated: true };
    });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", controller.signal, {
        now: () => now,
        runProcess: process.runProcess,
        deadlineMs: 100,
        maxGhOutputBytes: 1,
      }),
    ).rejects.toMatchObject({ message: "caller stopped", errorClass: "cancelled" });
  });

  test("adaptive blob, Gist, and notebook fences preserve 3/4/5-backtick code", async () => {
    const blobCode = "before ``` after";
    const blob = sequence({ stdout: blobCode });
    const blobResult = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/main/app.ts",
      undefined,
      { runProcess: blob.runProcess },
    );
    expect(codeContents(blobResult!.markdown)).toEqual([`${blobCode}\n`]);
    expect(blobResult?.markdown).toContain("````typescript");

    const gistCode = "before ```` after";
    const gist = sequence({ stdout: "snippet.py\n" }, { stdout: gistCode });
    const gistResult = await fetchGithubIfApplicable(
      "https://gist.github.com/user/abcdef",
      undefined,
      { runProcess: gist.runProcess },
    );
    expect(codeContents(gistResult!.markdown)).toEqual([`${gistCode}\n`]);
    expect(gistResult?.markdown).toContain("`````python");

    const notebookCode = "before ````` after";
    const notebook = sequence({
      stdout: JSON.stringify({
        metadata: { language_info: { name: "python" } },
        cells: [{ cell_type: "code", source: [notebookCode] }],
      }),
    });
    const notebookResult = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/main/demo.ipynb",
      undefined,
      { runProcess: notebook.runProcess },
    );
    expect(codeContents(notebookResult!.markdown)).toEqual([`${notebookCode}\n`]);
    expect(notebookResult?.markdown).toContain("``````python");
  });

  test("notebooks normalize string and array sources and preserve trailing newlines", async () => {
    const stringSource = "string ``` source\n\n";
    const arraySource = ["array ```` ", "source\n"];
    const notebook = sequence({
      stdout: JSON.stringify({
        metadata: { language_info: { name: "python" } },
        cells: [
          { cell_type: "code", source: stringSource },
          { cell_type: "code", source: arraySource },
        ],
      }),
    });
    const result = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/main/demo.ipynb",
      undefined,
      { runProcess: notebook.runProcess },
    );
    expect(codeContents(result!.markdown)).toEqual([stringSource, arraySource.join("")]);
    expect(result?.markdown).toContain("````python\nstring ``` source\n\n````");
    expect(result?.markdown).toContain("`````python\narray ```` source\n`````");
  });

  test("raw Markdown remains byte-identical for blobs and single-file Gists", async () => {
    const markdown = "# Doc\n\n```\nraw\n```\n";
    const blob = sequence({ stdout: markdown });
    expect(
      (
        await fetchGithubIfApplicable("https://github.com/o/r/blob/main/doc.md", undefined, {
          runProcess: blob.runProcess,
        })
      )?.markdown,
    ).toBe(markdown);

    const gist = sequence({ stdout: "doc.md\n" }, { stdout: markdown });
    expect(
      (
        await fetchGithubIfApplicable("https://gist.github.com/user/abcdef", undefined, {
          runProcess: gist.runProcess,
        })
      )?.markdown,
    ).toBe(markdown);
  });

  test("issue and pull requests use their dedicated gh renderers", async () => {
    for (const [url, command, body] of [
      ["https://github.com/o/r/issues/7", "issue", "issue body"],
      ["https://github.com/o/r/pull/9", "pr", "pr body"],
    ] as const) {
      const process = sequence({ stdout: body });
      expect(
        (await fetchGithubIfApplicable(url, undefined, { runProcess: process.runProcess }))
          ?.markdown,
      ).toBe(body);
      expect(process.calls[0]?.argv[1]).toBe(command);
    }
  });

  test("profile, compare, and tree responses render bounded Markdown", async () => {
    const profile = sequence({
      stdout: JSON.stringify({
        login: "person",
        name: "Example",
        html_url: "https://github.com/person",
        public_repos: 10,
      }),
    });
    expect(
      (
        await fetchGithubIfApplicable("https://github.com/person", undefined, {
          runProcess: profile.runProcess,
        })
      )?.markdown,
    ).toContain("# Example");

    const compare = sequence({
      stdout: JSON.stringify({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        commits: [{ sha: "abcdef123", commit: { message: "feat: thing", author: { name: "A" } } }],
        files: [{ filename: "README.md", status: "modified", additions: 2, deletions: 1 }],
      }),
    });
    const comparison = await fetchGithubIfApplicable(
      "https://github.com/o/r/compare/a...b",
      undefined,
      { runProcess: compare.runProcess },
    );
    expect(comparison?.markdown).toContain("`abcdef1` feat: thing — A");
    expect(comparison?.markdown).toContain("`README.md` (modified, +2 -1)");

    const tree = sequence({
      stdout: JSON.stringify([
        {
          name: "guide.md",
          type: "file",
          size: 42,
          html_url: "https://github.com/o/r/blob/main/docs/guide.md",
        },
      ]),
    });
    const treeResult = await fetchGithubIfApplicable(
      "https://github.com/o/r/tree/main/docs",
      undefined,
      { runProcess: tree.runProcess },
    );
    expect(treeResult?.markdown).toContain("[`guide.md`]");
  });

  test("generated GitHub links fall back safely while raw Markdown remains unchanged", async () => {
    const profile = sequence({
      stdout: JSON.stringify({
        login: "person[x]",
        name: "Raw <name>",
        html_url: "javascript:alert(1)",
      }),
    });
    const profileResult = await fetchGithubIfApplicable("https://github.com/person", undefined, {
      runProcess: profile.runProcess,
    });
    expect(profileResult?.markdown).toContain("# Raw <name>");
    expect(profileResult?.markdown).toContain("**Login:** person\\[x\\]");
    expect(profileResult?.markdown).not.toContain("javascript:");

    const tree = sequence({
      stdout: JSON.stringify([{ name: "guide[x].md", type: "file", html_url: "data:text/html,x" }]),
    });
    const treeResult = await fetchGithubIfApplicable(
      "https://github.com/o/r/tree/main/docs",
      undefined,
      { runProcess: tree.runProcess },
    );
    expect(treeResult?.markdown).toContain("`guide\\[x\\].md`");
    expect(treeResult?.markdown).not.toContain("data:text");

    const raw = "[provider](javascript:still-raw)\n";
    const blob = sequence({ stdout: raw });
    expect(
      (
        await fetchGithubIfApplicable("https://github.com/o/r/blob/main/README.md", undefined, {
          runProcess: blob.runProcess,
        })
      )?.markdown,
    ).toBe(raw);
  });

  test("multi-file Gists preserve Markdown and source file identity", async () => {
    const process = sequence(
      { stdout: "one.md\ntwo.js\n" },
      { stdout: "# One\n" },
      { stdout: "two();\n" },
    );
    const result = await fetchGithubIfApplicable("https://gist.github.com/user/abcdef", undefined, {
      runProcess: process.runProcess,
    });
    expect(result?.markdown).toContain("## one.md\n\n# One\n");
    expect(result?.markdown).toContain("## two.js\n\n```javascript\ntwo();\n```");
  });

  test("slash-containing branches are resolved against the real branch list", async () => {
    const process = sequence(
      { stderr: "not found (HTTP 404)", exitCode: 1 },
      { stdout: "main\nfeature/foo\n" },
      { stdout: "SLASH BRANCH\n" },
    );
    const result = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/feature/foo/dir/app.txt",
      undefined,
      { runProcess: process.runProcess },
    );
    expect(result?.markdown).toContain("SLASH BRANCH");
  });

  test("exit status maps authentication, rate limits, not found, and legal blocks", async () => {
    const auth = sequence({ exitCode: 4 });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        runProcess: auth.runProcess,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeAuthError);
    for (const [status, message] of [
      [403, "rate limit"],
      [404, "not found"],
      [451, "legal reasons"],
    ] as const) {
      const process = sequence({ stderr: `failed (HTTP ${status})`, exitCode: 1 });
      try {
        await fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
          runProcess: process.runProcess,
        });
        throw new Error("request unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentscrapeError);
        expect((error as Error).message).toContain(message);
      }
    }
  });

  test("reported subprocess timeouts use the stable operation deadline error", async () => {
    const process = sequence({ timedOut: true, exitCode: 124 });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", undefined, {
        runProcess: process.runProcess,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeTimeoutError);
  });

  test("hostile owners and parent path components fail before the runner", async () => {
    const process = sequence({ stdout: "must not run" });
    await expect(
      fetchGithubIfApplicable("https://github.com/-evil/repo", undefined, {
        runProcess: process.runProcess,
      }),
    ).rejects.toThrow("invalid GitHub owner");
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/blob/main/../secret", undefined, {
        runProcess: process.runProcess,
      }),
    ).rejects.toThrow("contains '..'");
    expect(process.calls).toHaveLength(0);
  });

  test("already-aborted callers do not construct or invoke the injected runner", async () => {
    const controller = new AbortController();
    controller.abort();
    const process = sequence({ stdout: "must not run" });
    await expect(
      fetchGithubIfApplicable("https://github.com/o/r/issues/1", controller.signal, {
        runProcess: process.runProcess,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeCancelledError);
    expect(process.calls).toHaveLength(0);
  });
});

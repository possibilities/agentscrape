import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchMarkdown } from "../src/api";
import {
  AGENT_BROWSER_BIN_ENV,
  AGENT_BROWSER_TIMEOUT_ENV,
  openPage,
  requireAgentBrowserSuccess,
  resetBrowserUnavailableCache,
  runAgentBrowser,
} from "../src/browser";
import { browserEval } from "../src/browser-eval";
import {
  buildFailureEnvelope,
  classifyFailure,
  validateEnvelopeRequest,
  validateProviderFinalUrl,
} from "../src/envelope";
import {
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeHttpError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
} from "../src/errors";
import { fetchGithubIfApplicable } from "../src/github";
import type { ExtractionEnvelope } from "../src/schemas";
import { runProcess } from "../src/subprocess";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalBrowserBin = process.env[AGENT_BROWSER_BIN_ENV];
const originalBrowserTimeout = process.env[AGENT_BROWSER_TIMEOUT_ENV];
const temporary: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-runtime-"));
  temporary.push(path);
  return path;
}
function executable(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt += 1) await Bun.sleep(5);
  expect(existsSync(path)).toBeTrue();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBrowserBin === undefined) delete process.env[AGENT_BROWSER_BIN_ENV];
  else process.env[AGENT_BROWSER_BIN_ENV] = originalBrowserBin;
  if (originalBrowserTimeout === undefined) delete process.env[AGENT_BROWSER_TIMEOUT_ENV];
  else process.env[AGENT_BROWSER_TIMEOUT_ENV] = originalBrowserTimeout;
  resetBrowserUnavailableCache();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded subprocess runtime", () => {
  test("kills an infinite writer as soon as either output ceiling is crossed", async () => {
    const directory = temp();
    const writer = executable(
      directory,
      "writer",
      `chunk='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
while :; do printf '%s' "$chunk"; done`,
    );
    const started = performance.now();
    const result = await runProcess([writer], { maxOutputBytes: 1024, timeoutMs: 5000 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.exitCode).not.toBe(0);
    expect(result.truncated).toBeTrue();
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1024);
  });

  test("kills descendants in the isolated process group on timeout", async () => {
    const directory = temp();
    const parent = executable(
      directory,
      "parent",
      `sleep 30 &
printf '%s\\n' "$!"
while :; do sleep 30; done`,
    );
    const result = await runProcess([parent], { timeoutMs: 100, maxOutputBytes: 1024 });
    expect(result.timedOut).toBeTrue();
    const descendant = Number(result.stdout.trim().split(/\s+/)[0]);
    expect(Number.isInteger(descendant)).toBeTrue();
    for (let attempt = 0; attempt < 50 && alive(descendant); attempt += 1) await Bun.sleep(10);
    expect(alive(descendant)).toBeFalse();
  });
});

describe("provider cancellation", () => {
  test("passes AbortSignal into gh and pandoc subprocesses", async () => {
    const directory = temp();
    const ghStarted = join(directory, "gh-started");
    executable(directory, "gh", `printf '%s' "$PPID" > ${JSON.stringify(ghStarted)}\nsleep 30`);
    process.env.PATH = `${directory}:${originalPath}`;
    const ghController = new AbortController();
    const ghRequest = fetchGithubIfApplicable(
      "https://github.com/o/r/issues/1",
      ghController.signal,
    );
    await waitFor(ghStarted);
    ghController.abort();
    await expect(ghRequest).rejects.toBeInstanceOf(AgentscrapeCancelledError);

    const pandocStarted = join(directory, "pandoc-started");
    executable(directory, "gh", "printf 'Heading\\n=======\\n'");
    executable(
      directory,
      "pandoc",
      `printf '%s' "$PPID" > ${JSON.stringify(pandocStarted)}\nsleep 30`,
    );
    const pandocController = new AbortController();
    const pandocRequest = fetchGithubIfApplicable(
      "https://github.com/o/r/blob/main/doc.rst",
      pandocController.signal,
    );
    await waitFor(pandocStarted);
    pandocController.abort();
    await expect(pandocRequest).rejects.toBeInstanceOf(AgentscrapeCancelledError);
  });
});

describe("streaming direct Markdown", () => {
  test("cancels an oversized chunked response at the hard byte limit", async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(700));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as unknown as typeof fetch;
    const envelope = (await fetchMarkdown("https://example.com/large.md", {
      envelope: true,
      maxContentBytes: 1024,
    })) as ExtractionEnvelope;
    expect(envelope.failure?.failure_class).toBe("output_limit_exceeded");
    expect(cancelled).toBeTrue();
  });

  test("rejects a redirect final URL containing nested credentials before following it", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://user:redirect-secret@example.com/final.md?next=token%3Dnested-secret",
        },
      });
    }) as unknown as typeof fetch;
    const envelope = (await fetchMarkdown("https://example.com/start.md", {
      envelope: true,
    })) as ExtractionEnvelope;
    expect(envelope.failure?.failure_class).toBe("malformed_provider_output");
    expect(calls).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain("redirect-secret");
    expect(JSON.stringify(envelope)).not.toContain("nested-secret");
  });

  test("maps direct HTTP status and cancellation into stable failure classes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const status = Number(new URL(request.url).pathname.slice(1).split(".")[0]);
        return new Response("failure", { status });
      },
    });
    try {
      for (const [status, failureClass, retryable] of [
        [401, "authentication_required", false],
        [403, "authentication_required", false],
        [404, "provider_error", false],
        [429, "provider_error", true],
        [503, "provider_error", true],
      ] as const) {
        const envelope = (await fetchMarkdown(`http://127.0.0.1:${server.port}/${status}.md`, {
          envelope: true,
        })) as ExtractionEnvelope;
        expect(envelope.failure?.failure_class).toBe(failureClass);
        expect(envelope.failure?.retryable).toBe(retryable);
      }
    } finally {
      server.stop(true);
    }

    let cancelled = false;
    let propagatedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      propagatedSignal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(1000);
            controller.enqueue(new Uint8Array([120]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }) as typeof fetch;
    const controller = new AbortController();
    const request = fetchMarkdown("https://example.com/slow.md", {
      envelope: true,
      signal: controller.signal,
    }) as Promise<ExtractionEnvelope>;
    setTimeout(() => controller.abort(), 20);
    const envelope = await request;
    expect(envelope.failure?.failure_class).toBe("cancelled");
    expect(propagatedSignal).toBeDefined();
    expect(propagatedSignal).not.toBe(controller.signal);
    expect(propagatedSignal?.aborted).toBeTrue();
    expect(cancelled).toBeTrue();
  });
});

describe("envelope URL and diagnostic security", () => {
  test("rejects credentialed, nested-secret, and secret-path request and final URLs", () => {
    for (const url of [
      "https://user:password@example.com/page.md",
      "https://example.com/token/path-secret/page.md",
      "https://example.com/page.md?next=https%3A%2F%2Fother.example%2F%3Fapi_key%3Dnested-secret",
      "https://example.com/page.md?payload=%7B%22client_secret%22%3A%22json-secret%22%7D",
    ]) {
      expect(() => validateEnvelopeRequest(url, 100, 1)).toThrow();
      expect(() => validateProviderFinalUrl(url)).toThrow();
    }
  });

  test("redacts credentials, nested names, path values, multiline payloads, and controls", () => {
    const envelope = buildFailureEnvelope(
      new Error(
        "visit https://user:basic-secret@example.com/token/path-secret?next=token%3Dnested-secret to\u0000ken=control-secret\nProvider payload (multiline):\napi_key=multiline-secret\u0000\u0085",
      ),
      {
        requestedUrl:
          "https://user:request-secret@example.com/secret/path-secret?next=https%3A%2F%2Fx.example%2F%3Ftoken%3Dnested-secret",
        finalUrl: "https://example.com/password/final-secret?redirect=api_key%3Dquery-secret",
        implementation: "generic-page",
      },
    );
    const serialized = JSON.stringify(envelope);
    for (const secret of [
      "basic-secret",
      "path-secret",
      "nested-secret",
      "multiline-secret",
      "control-secret",
      "request-secret",
      "final-secret",
      "query-secret",
    ])
      expect(serialized).not.toContain(secret);
    const evidence = envelope.failure?.evidence ?? "";
    expect(
      [...evidence].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      }),
    ).toBeFalse();
    expect(new TextEncoder().encode(evidence).byteLength).toBeLessThanOrEqual(1024);
  });

  test("classifies typed HTTP, provider, browser, and cancellation failures", () => {
    expect(classifyFailure(new AgentscrapeHttpError("busy", 503, true)).slice(0, 2)).toEqual([
      "provider_error",
      true,
    ]);
    expect(
      classifyFailure(
        new AgentscrapeProviderError("authentication required text from provider", false),
      ).slice(0, 2),
    ).toEqual(["provider_error", false]);
    expect(classifyFailure(new AgentscrapeBrowserError("navigation"))[0]).toBe("browser_error");
    expect(classifyFailure(new AgentscrapeCancelledError())[0]).toBe("cancelled");
  });
});

describe("typed agent-browser command boundary", () => {
  test("classifies eval command failures and timeout-shaped results", async () => {
    const directory = temp();
    const home = temp();
    const browser = executable(
      directory,
      "agent-browser",
      `case "$*" in
  *browser-failure*) printf 'protocol failure' >&2; exit 7 ;;
  *upstream-failure*) printf 'upstream down: browserctl unavailable' >&2; exit 1 ;;
  *timeout-failure*) printf 'browser operation timeout exceeded' >&2; exit 1 ;;
  *) printf 'null' ;;
esac`,
    );
    process.env.HOME = home;
    process.env[AGENT_BROWSER_BIN_ENV] = browser;
    resetBrowserUnavailableCache();

    await expect(browserEval("browser-failure")).rejects.toBeInstanceOf(AgentscrapeBrowserError);
    await expect(browserEval("upstream-failure")).rejects.toBeInstanceOf(
      AgentscrapeUpstreamDownError,
    );
    await expect(browserEval("timeout-failure")).rejects.toBeInstanceOf(AgentscrapeTimeoutError);
  });

  test("marks a missing browser executable nonretryable", async () => {
    process.env.HOME = temp();
    process.env[AGENT_BROWSER_BIN_ENV] = join(temp(), "missing-agent-browser");
    resetBrowserUnavailableCache();
    try {
      await runAgentBrowser(["eval", "null"]);
      throw new Error("missing executable unexpectedly ran");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentscrapeBrowserError);
      expect((error as AgentscrapeBrowserError).retryable).toBeFalse();
    }
  });

  test("the shared result guard ignores incidental stderr on success and preserves failure precedence", () => {
    for (const stderr of [
      "operation cancelled",
      "upstream down: browserctl unavailable",
      "timeout exceeded",
    ]) {
      expect(() =>
        requireAgentBrowserSuccess({
          argv: ["agent-browser"],
          exitCode: 0,
          stdout: "ok",
          stderr,
          timedOut: false,
          truncated: false,
        }),
      ).not.toThrow();
    }
    expect(() =>
      requireAgentBrowserSuccess({
        argv: ["agent-browser"],
        exitCode: 130,
        stdout: "",
        stderr: "operation cancelled after timeout",
        timedOut: true,
        truncated: false,
      }),
    ).toThrow(AgentscrapeCancelledError);
  });

  test("best-effort browser probes ignore incidental stderr on successful commands", async () => {
    process.env.HOME = temp();
    for (const [index, stderr] of [
      "operation cancelled",
      "upstream down: browserctl unavailable",
      "timeout exceeded",
    ].entries()) {
      const browser = executable(
        temp(),
        `agent-browser-${index}`,
        `printf '%s' ${JSON.stringify(stderr)} >&2
case "$*" in
  *" eval window.location.href") printf '"https://example.com/page"' ;;
esac`,
      );
      process.env[AGENT_BROWSER_BIN_ENV] = browser;
      resetBrowserUnavailableCache();
      await expect(
        openPage("https://example.com/page", `incidental-${index}`),
      ).resolves.toBeUndefined();
    }
  });
});

describe("keyed browser outage cache", () => {
  test("hits before the TTL, expires at equality, resets, and isolates key tuple fields", async () => {
    const directory = temp();
    const home = temp();
    const calls = join(directory, "calls");
    const browser = executable(
      directory,
      "agent-browser",
      `printf 'call\\n' >> ${JSON.stringify(calls)}
printf 'failed to acquire browser from browserctl: unavailable' >&2
exit 1`,
    );
    let now = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      process.env.HOME = home;
      process.env[AGENT_BROWSER_BIN_ENV] = browser;
      const first = await runAgentBrowser(["eval", "null"], "shared", "profile-a");
      now += 29_999;
      const cached = await runAgentBrowser(["eval", "other"], "shared", "profile-a");
      expect(cached.stderr).toBe(first.stderr);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);

      now += 1;
      await runAgentBrowser(["eval", "null"], "shared", "profile-a");
      await runAgentBrowser(["eval", "null"], "shared", "profile-b");
      process.env.HOME = temp();
      await runAgentBrowser(["eval", "null"], "shared", "profile-a");
      const otherBrowser = executable(
        directory,
        "other-agent-browser",
        `printf 'call\\n' >> ${JSON.stringify(calls)}
printf 'failed to acquire browser from browserctl: unavailable' >&2
exit 1`,
      );
      process.env[AGENT_BROWSER_BIN_ENV] = otherBrowser;
      await runAgentBrowser(["eval", "null"], "shared", "profile-a");
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(5);

      resetBrowserUnavailableCache();
      await runAgentBrowser(["eval", "null"], "shared", "profile-a");
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(6);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a concurrent success clears an outage cached by the same-key failure", async () => {
    const directory = temp();
    const home = temp();
    const successStarted = join(directory, "success-started");
    const failureStarted = join(directory, "failure-started");
    const releaseSuccess = join(directory, "release-success");
    const afterSuccess = join(directory, "after-success");
    const browser = executable(
      directory,
      "agent-browser",
      `case "$*" in
  *slow-success*)
    touch ${JSON.stringify(successStarted)}
    while [ ! -f ${JSON.stringify(releaseSuccess)} ]; do sleep 0.01; done
    ;;
  *acquisition-failure*)
    touch ${JSON.stringify(failureStarted)}
    printf 'failed to acquire browser from browserctl: unavailable' >&2
    exit 1
    ;;
  *after-success*) touch ${JSON.stringify(afterSuccess)} ;;
esac`,
    );
    process.env.HOME = home;
    process.env[AGENT_BROWSER_BIN_ENV] = browser;

    const successful = runAgentBrowser(["eval", "slow-success"], "shared", "profile-a");
    await waitFor(successStarted);
    const failing = runAgentBrowser(["eval", "acquisition-failure"], "shared", "profile-a");
    await waitFor(failureStarted);
    const failed = await failing;
    expect(failed.stderr).toStartWith("upstream down: ");

    writeFileSync(releaseSuccess, "release");
    expect((await successful).exitCode).toBe(0);
    const subsequent = await runAgentBrowser(["eval", "after-success"], "shared", "profile-a");
    expect(subsequent.exitCode).toBe(0);
    expect(existsSync(afterSuccess)).toBeTrue();
  });

  test("evicts the oldest entry after the bounded 64-key limit", async () => {
    const directory = temp();
    const calls = join(directory, "calls");
    process.env.HOME = temp();
    process.env[AGENT_BROWSER_BIN_ENV] = executable(
      directory,
      "agent-browser",
      `printf 'call\\n' >> ${JSON.stringify(calls)}
printf 'failed to acquire browser from browserctl: unavailable' >&2
exit 1`,
    );
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      for (let index = 0; index < 65; index += 1)
        await runAgentBrowser(["eval", "null"], `bounded-${index}`);
      await runAgentBrowser(["eval", "null"], "bounded-0");
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(66);
    } finally {
      Date.now = originalNow;
    }
  });

  test("redacts and UTF-8 bounds acquisition diagnostics before caching", async () => {
    const directory = temp();
    process.env.HOME = temp();
    process.env[AGENT_BROWSER_BIN_ENV] = executable(
      directory,
      "agent-browser",
      `printf 'failed to acquire browser from browserctl token=acquisition-secret\\n%s' '${"x".repeat(2000)}' >&2
exit 1`,
    );
    const result = await runAgentBrowser(["eval", "null"], "bounded-reason");
    expect(result.stderr).toStartWith("upstream down: ");
    expect(result.stderr).not.toContain("acquisition-secret");
    expect(new TextEncoder().encode(result.stderr).byteLength).toBeLessThanOrEqual(1024);
    expect(result.stderr).not.toContain("\n");
  });
});

describe("strict browserctl health state", () => {
  const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);

  type HealthFixture =
    | string
    | Uint8Array
    | "directory"
    | "symlink"
    | "unsafe-group-mode"
    | "unsafe-world-mode"
    | "hardlink";

  async function healthResult(
    content: HealthFixture,
  ): Promise<{ result: Awaited<ReturnType<typeof runAgentBrowser>>; invoked: boolean }> {
    const home = temp();
    const directory = temp();
    const called = join(directory, "called");
    const browser = executable(directory, "agent-browser", `touch ${JSON.stringify(called)}`);
    const path = join(home, ".local/state/browserctl/check-health-state.yaml");
    mkdirSync(dirname(path), { recursive: true });
    const downState = "is_down: true\nlast_run_at: 2026-01-02T12:00:00.000000Z\nreason: unsafe\n";
    if (content === "directory") mkdirSync(path);
    else if (content === "symlink") {
      const target = join(home, "outside-health.yaml");
      writeFileSync(target, downState);
      symlinkSync(target, path);
    } else if (content === "hardlink") {
      const target = join(home, "hardlinked-health.yaml");
      writeFileSync(target, downState, { mode: 0o600 });
      linkSync(target, path);
    } else if (content === "unsafe-group-mode" || content === "unsafe-world-mode") {
      writeFileSync(path, downState, { mode: 0o600 });
      chmodSync(path, content === "unsafe-group-mode" ? 0o620 : 0o602);
    } else writeFileSync(path, content, { mode: 0o600 });
    process.env.HOME = home;
    process.env[AGENT_BROWSER_BIN_ENV] = browser;
    const result = await runAgentBrowser(["eval", "null"], "health-test");
    return { result, invoked: existsSync(called) };
  }

  test("accepts strict RFC3339 freshness and future-skew boundaries", async () => {
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      for (const timestamp of [
        "2026-01-02T12:00:00.123456+00:00",
        "2026-01-02T13:00:00.000000+01:00",
        "2026-01-02T11:45:00.000000Z",
        "2026-01-02T12:01:00.000000Z",
      ]) {
        const { result, invoked } = await healthResult(
          `is_down: true\nlast_run_at: ${timestamp}\nreason: planned outage\n`,
        );
        expect(invoked).toBeFalse();
        expect(result.stderr).toContain("upstream down: browserctl: planned outage");
      }
    } finally {
      Date.now = originalNow;
    }
  });

  test("fails open for stale, over-future, malformed, and invalid-calendar timestamps", async () => {
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      for (const timestamp of [
        "2026-01-02T11:44:59.999000Z",
        "2026-01-02T12:01:00.000001Z",
        "2026-01-02T12:01:00.001000Z",
        "2026-02-30T12:00:00Z",
        "2026-01-02 12:00:00Z",
        "2026-01-02T12:00:00",
      ]) {
        const { result, invoked } = await healthResult(
          `is_down: true\nlast_run_at: ${timestamp}\nreason: invalid\n`,
        );
        expect(invoked).toBeTrue();
        expect(result.exitCode).toBe(0);
      }
    } finally {
      Date.now = originalNow;
    }
  });

  test("ignores unsafe modes, hardlinks, other unsafe files, and invalid content", async () => {
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      for (const content of [
        "directory" as const,
        "symlink" as const,
        "unsafe-group-mode" as const,
        "unsafe-world-mode" as const,
        "hardlink" as const,
        new Uint8Array([0xff, 0xfe]),
        `is_down: true\nis_down: true\nlast_run_at: 2026-01-02T12:00:00Z\n`,
        `is_down: true\nlast_run_at: 2026-01-02T12:00:00Z\nreason: &value down\ncopy: *value\n`,
        `is_down: true\nlast_run_at: 2026-01-02T12:00:00Z\nreason: ${"x".repeat(17_000)}\n`,
      ]) {
        const { result, invoked } = await healthResult(content);
        expect(invoked).toBeTrue();
        expect(result.exitCode).toBe(0);
      }
    } finally {
      Date.now = originalNow;
    }
  });

  test("normalizes, redacts, and bounds health reasons with a blank fallback", async () => {
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const secret = `token=health-secret\\n${"y".repeat(2000)}\\u0000`;
      const bounded = await healthResult(
        `is_down: true\nlast_run_at: 2026-01-02T12:00:00.000000Z\nreason: "${secret}"\n`,
      );
      expect(bounded.invoked).toBeFalse();
      expect(bounded.result.stderr).not.toContain("health-secret");
      expect(new TextEncoder().encode(bounded.result.stderr).byteLength).toBeLessThanOrEqual(1024);
      expect(bounded.result.stderr).not.toContain("\n");

      const fallback = await healthResult(
        "is_down: true\nlast_run_at: 2026-01-02T12:00:00Z\nreason: '   '\n",
      );
      expect(fallback.result.stderr).toContain("browserctl is down");
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("SPA navigation timeout tolerance", () => {
  test("accepts selector evidence after agent-browser open times out", async () => {
    const directory = temp();
    const home = temp();
    const state = join(directory, "opened");
    const browser = executable(
      directory,
      "agent-browser",
      `case "$*" in
  *" eval window.location.href")
    if [ -f ${JSON.stringify(state)} ]; then printf '"https://x.com/example/status/1"'; else printf '"about:blank"'; fi ;;
  *" open https://x.com/example/status/1") touch ${JSON.stringify(state)}; printf 'page.goto: Timeout 30000ms exceeded' >&2; exit 1 ;;
  *" open https://x.com/example/hard-failure") printf 'protocol failure' >&2; exit 1 ;;
  *" wait --load networkidle") sleep 30 ;;
  *primaryColumn*) exit 0 ;;
  *) exit 1 ;;
esac`,
    );
    process.env.HOME = home;
    process.env.PATH = `${directory}:${originalPath}`;
    process.env[AGENT_BROWSER_BIN_ENV] = browser;
    process.env[AGENT_BROWSER_TIMEOUT_ENV] = "0.1";
    resetBrowserUnavailableCache();
    const navigation = openPage(
      "https://x.com/example/status/1",
      "timeout-test",
      null,
      "[data-testid=primaryColumn]",
    );
    await expect(navigation).resolves.toBeUndefined();
    await expect(
      openPage("https://x.com/example/status/1", "timeout-final-url-test"),
    ).resolves.toBeUndefined();
    await expect(
      openPage(
        "https://x.com/example/hard-failure",
        "hard-failure-test",
        null,
        "[data-testid=primaryColumn]",
      ),
    ).rejects.toBeInstanceOf(AgentscrapeBrowserError);
  });
});

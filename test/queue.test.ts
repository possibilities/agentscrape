import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataHome } from "../src/queue";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { home: string; queue: string; privateRoot: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "agentscrape-queue-"));
  temporary.push(home);
  const queue = join(home, ".local/share/agentscrape/queue");
  const privateRoot = join(home, ".local/share/agentscrape/private");
  const bin = join(home, "bin");
  mkdirSync(queue, { recursive: true });
  mkdirSync(bin);
  return { home, queue, privateRoot, bin };
}

/**
 * A current-format record that fails its standalone validation, so processing publishes it to
 * failed/ and retires it without any provider call. Claim-machinery tests need exactly that: a
 * deterministic, hermetic transition whose outcome does not depend on a network fixture.
 */
function queueRecord(queue: string, name = "job.yaml"): string {
  const path = join(queue, name);
  writeFileSync(path, "url: not-a-url\ndestination: /tmp/saved.md\n");
  return path;
}

function pendingGeneration(name: string, raw: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(`pending\0${name}\0`), Buffer.from(raw)]))
    .digest("hex");
}

function _publicationTemp(directory: string): string {
  return join(directory, ".agentscrape-publish-00000000-0000-4000-8000-000000000017.tmp");
}

function _writeDueRetry(
  value: ReturnType<typeof fixture>,
  name: string,
  destination: string,
): { path: string; raw: Buffer; generationId: string } {
  const raw = Buffer.from(`url: https://example.com/${name}\ndestination: ${destination}\n`);
  const generationId = pendingGeneration(name, raw);
  const directory = join(value.home, ".local/share/agentscrape/retry");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${generationId}--attempt-1.json`);
  const envelope = {
    version: 1,
    state: "retry",
    generationId,
    logicalArea: "pending",
    originalFilename: name,
    rawByteSize: raw.byteLength,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    rawBase64: raw.toString("base64"),
    completedFailures: 1,
    nextAttemptAtMs: 0,
    policy: { initialDelaySeconds: 1, maxDelaySeconds: 60, maxAttempts: 5 },
  };
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return { path, raw, generationId };
}

function startProcess(value: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, "src/cli.ts", "process-queue"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: value.home,
      PATH: `${value.bin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

async function finish(child: ReturnType<typeof startProcess>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function retirementFiles(privateRoot: string): string[] {
  const directory = join(privateRoot, "retirement-quarantine");
  return existsSync(directory) ? readdirSync(directory) : [];
}

function claimFiles(privateRoot: string, kind: "slots" | "owners"): string[] {
  return readdirSync(join(privateRoot, "claims", kind));
}

function failedFiles(home: string): string[] {
  const directory = join(home, ".local/share/agentscrape/failed");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("queue data root resolution", () => {
  test("uses the HOME default when no queue env override is set", () => {
    const home = join(tmpdir(), "agentscrape-home-default");
    expect(resolveDataHome({}, home)).toBe(join(home, ".local", "share", "agentscrape"));
  });

  test("prefers AGENTSCRAPE_DATA_HOME over XDG_DATA_HOME", () => {
    const home = join(tmpdir(), "agentscrape-home-explicit");
    const xdg = join(tmpdir(), "agentscrape-xdg-ignored");
    const explicit = join(tmpdir(), "agentscrape-private-data-home");
    expect(resolveDataHome({ XDG_DATA_HOME: xdg, AGENTSCRAPE_DATA_HOME: explicit }, home)).toBe(
      explicit,
    );
  });

  for (const [label, env] of [
    ["empty AGENTSCRAPE_DATA_HOME", { AGENTSCRAPE_DATA_HOME: "" }],
    ["relative AGENTSCRAPE_DATA_HOME", { AGENTSCRAPE_DATA_HOME: "relative/root" }],
    ["relative XDG_DATA_HOME", { XDG_DATA_HOME: "relative/root" }],
    ["NUL-containing AGENTSCRAPE_DATA_HOME", { AGENTSCRAPE_DATA_HOME: "/tmp/queue\0root" }],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(() => resolveDataHome({ ...env }, join(tmpdir(), "agentscrape-home-invalid"))).toThrow(
        "absolute path without NUL bytes",
      );
    });
  }
});

describe("durable network consent", () => {
  test("classifies a network-policy denial as permanent without retry state", async () => {
    const value = fixture();
    writeFileSync(
      join(value.queue, "denied.yaml"),
      `url: https://example.com/denied\ndestination: ${join(value.home, "denied.md")}\n`,
    );
    const script = [
      'import { mock } from "bun:test";',
      'import { AgentscrapeNetworkPolicyError } from "./src/errors.ts";',
      'mock.module("./src/api.ts", () => ({ fetchMarkdown: async () => { throw new AgentscrapeNetworkPolicyError("browser_egress_unverifiable"); } }));',
      'const { processQueue } = await import("./src/queue.ts?network-consent-permanent");',
      "process.stdout.write(JSON.stringify(await processQueue()));",
    ].join("\n");
    const child = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(child.code, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ failed: 1, retry_scheduled: 0 });
    const retry = join(value.home, ".local/share/agentscrape/retry");
    expect(existsSync(retry) ? readdirSync(retry) : []).toEqual([]);
  });
});

describe("durable retry queue states", () => {
  test("does not follow queue record symlinks", async () => {
    const value = fixture();
    const external = join(value.home, "external.yaml");
    writeFileSync(external, "password: do-not-read\n");
    symlinkSync(external, join(value.queue, "linked.yaml"));
    const result = await finish(startProcess(value));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("processed=0 failed=0");
    expect(readFileSync(external, "utf8")).toBe("password: do-not-read\n");
    expect(failedFiles(value.home)).toEqual([]);
  });

  test("schedules an immutable retry, waits without provider work, then resumes when due", async () => {
    const value = fixture();
    const destination = join(value.home, "retry.md");
    const raw = `url: https://example.com/retry\ndestination: ${destination}\nallow_private_network: true\n`;
    writeFileSync(join(value.queue, "retry.yaml"), raw);
    const outageScript = [
      'import { mock } from "bun:test";',
      'import { AgentscrapeUpstreamDownError } from "./src/errors.ts";',
      'mock.module("./src/api.ts", () => ({',
      '  fetchMarkdown: async () => { throw new AgentscrapeUpstreamDownError("down"); },',
      "  resetBrowserUnavailableCache() {},",
      "}));",
      'const { processQueue } = await import("./src/queue.ts?retry-schedule-test");',
      "process.stdout.write(JSON.stringify(await processQueue({ now: () => 1000 })));",
    ].join("\n");
    const outage = await finish(
      Bun.spawn([process.execPath, "-e", outageScript], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: value.home,
          AGENTSCRAPE_PROCESS_QUEUE_RETRY_INITIAL_DELAY_SECONDS: "0.1234",
        },
      }),
    );
    expect(outage.code, outage.stderr).toBe(0);
    expect(JSON.parse(outage.stdout)).toMatchObject({
      processed: 0,
      failed: 0,
      retry_scheduled: 1,
      retry_waiting: 0,
    });
    const retryDirectory = join(value.home, ".local/share/agentscrape/retry");
    const retryPath = join(retryDirectory, readdirSync(retryDirectory)[0]!);
    const retry = JSON.parse(readFileSync(retryPath, "utf8"));
    expect(retry).toMatchObject({
      state: "retry",
      completedFailures: 1,
      nextAttemptAtMs: 1124,
      policy: { initialDelaySeconds: 0.1234, maxDelaySeconds: 60, maxAttempts: 5 },
    });
    expect(Buffer.from(retry.rawBase64, "base64").toString("utf8")).toBe(raw);

    // Recreate the exact ready predecessor to model a crash after retry publication but before
    // ready retirement. A not-due pass must still drain it so QueueDirectories can go idle.
    writeFileSync(join(value.queue, "retry.yaml"), raw);
    const waitingScript = [
      'import { mock } from "bun:test";',
      'mock.module("./src/api.ts", () => ({',
      '  fetchMarkdown: async () => { throw new Error("provider must not run"); },',
      '  resetBrowserUnavailableCache() { throw new Error("cache must not reset"); },',
      "}));",
      'const { processQueue } = await import("./src/queue.ts?retry-wait-test");',
      "process.stdout.write(JSON.stringify(await processQueue({ now: () => 1123 })));",
    ].join("\n");
    const waiting = await finish(
      Bun.spawn([process.execPath, "-e", waitingScript], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(waiting.code, waiting.stderr).toBe(0);
    expect(JSON.parse(waiting.stdout).retry_waiting).toBe(1);
    expect(existsSync(retryPath)).toBeTrue();
    expect(existsSync(join(value.queue, "retry.yaml"))).toBeFalse();

    const dueScript = [
      'import { mock } from "bun:test";',
      'import { writeFileSync } from "node:fs";',
      'mock.module("./src/api.ts", () => ({',
      "  fetchMarkdown: async (_url, options) => { if (options.allowPrivateNetwork !== true) throw new Error('consent not preserved'); writeFileSync(options.destination, '# retry success\\n'); },",
      '  resetBrowserUnavailableCache() { throw new Error("queue must not reset browser cache"); },',
      "}));",
      'const { processQueue } = await import("./src/queue.ts?retry-due-test");',
      "process.stdout.write(JSON.stringify(await processQueue({ now: () => 1124 })));",
    ].join("\n");
    const due = await finish(
      Bun.spawn([process.execPath, "-e", dueScript], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(due.code, due.stderr).toBe(0);
    expect(JSON.parse(due.stdout).processed).toBe(1);
    expect(existsSync(retryPath)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toBe("# retry success\n");
  });

  test("exhausts the persisted maximum into exact deterministic failed evidence", async () => {
    const value = fixture();
    const name = "exhaust.yaml";
    const destination = join(value.home, "exhaust.md");
    const raw = Buffer.from(`url: https://example.com/exhaust\ndestination: ${destination}\n`);
    writeFileSync(join(value.queue, name), raw);
    const script = (query: string, now: number) =>
      [
        'import { mock } from "bun:test";',
        'import { AgentscrapeUpstreamDownError } from "./src/errors.ts";',
        'mock.module("./src/api.ts", () => ({ fetchMarkdown: async () => { throw new AgentscrapeUpstreamDownError("down"); }, resetBrowserUnavailableCache() {} }));',
        `const { processQueue } = await import("./src/queue.ts?${query}");`,
        `process.stdout.write(JSON.stringify(await processQueue({ now: () => ${now} })));`,
      ].join("\n");
    const first = await finish(
      Bun.spawn([process.execPath, "-e", script("exhaust-first", 0)], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: value.home,
          AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS: "2",
        },
      }),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ retry_scheduled: 1, retry_exhausted: 0 });

    const exhausted = await finish(
      Bun.spawn([process.execPath, "-e", script("exhaust-final", 1000)], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: value.home,
          // The envelope's persisted maximum remains authoritative.
          AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS: "99",
        },
      }),
    );
    expect(exhausted.code, exhausted.stderr).toBe(0);
    expect(JSON.parse(exhausted.stdout)).toMatchObject({
      failed: 1,
      retry_scheduled: 0,
      retry_exhausted: 1,
    });
    expect(readdirSync(join(value.home, ".local/share/agentscrape/retry"))).toEqual([]);
    const id = pendingGeneration(name, raw);
    const terminal = join(
      value.home,
      ".local/share/agentscrape/failed",
      `exhaust--failed-${id}.yaml`,
    );
    expect(readFileSync(terminal)).toEqual(raw);
    expect(lstatSync(terminal).mode & 0o777).toBe(0o600);
  });

  test("two workers overlap with one provider and destination effect", async () => {
    const value = fixture();
    const destination = join(value.home, "result.md");
    let calls = 0;
    let requestSeen!: () => void;
    let releaseResponse!: () => void;
    const seen = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch() {
        calls += 1;
        requestSeen();
        await released;
        return new Response("# claimed once\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    });
    try {
      writeFileSync(
        join(value.queue, "job.yaml"),
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\nallow_private_network: true\n`,
      );
      const owner = startProcess(value);
      await seen;
      const heldOwners = claimFiles(value.privateRoot, "owners").map((name) =>
        JSON.parse(readFileSync(join(value.privateRoot, "claims", "owners", name), "utf8")),
      );
      expect(heldOwners.map((claim) => claim.area).sort()).toEqual(["generation", "pending"]);
      const peer = await finish(startProcess(value));
      expect(peer.code).toBe(0);
      releaseResponse();
      const winner = await finish(owner);
      expect(winner.code).toBe(0);
      expect(calls).toBe(1);
      expect(readFileSync(destination, "utf8")).toContain("# claimed once");
      expect(existsSync(join(value.queue, "job.yaml"))).toBeFalse();
      expect(retirementFiles(value.privateRoot)).toEqual([]);
      expect(claimFiles(value.privateRoot, "slots")).toEqual([]);
      expect(claimFiles(value.privateRoot, "owners")).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("cancellation stays public and invalid records fail with claims released", async () => {
    const value = fixture();
    const destination = join(value.home, "cancelled.md");
    const summaryReady = join(value.home, "summary-ready");
    const summaryctl = join(value.bin, "summaryctl");
    writeFileSync(
      summaryctl,
      [
        "#!/usr/bin/env bun",
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.SUMMARY_READY!, "ready\\n");',
        "await Bun.sleep(30_000);",
        'process.stdout.write("too late\\n");',
        "",
      ].join("\n"),
    );
    chmodSync(summaryctl, 0o700);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# cancellation\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    const source = join(value.queue, "cancelled.yaml");
    try {
      writeFileSync(
        source,
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\nsummarize: true\nallow_private_network: true\n`,
      );
      const worker = startProcess(value, { SUMMARY_READY: summaryReady });
      await waitFor(summaryReady);
      worker.kill("SIGTERM");
      const cancelled = await finish(worker);
      expect(cancelled.code).toBe(143);
      expect(existsSync(source)).toBeTrue();
      expect(claimFiles(value.privateRoot, "slots")).toEqual([]);
      expect(claimFiles(value.privateRoot, "owners")).toEqual([]);

      rmSync(source);
      queueRecord(value.queue, "invalid.yaml");
      const invalid = await finish(startProcess(value));
      expect(invalid.code).toBe(0);
      expect(invalid.stderr).toContain("failed=1");
      expect(existsSync(join(value.queue, "invalid.yaml"))).toBeFalse();
      expect(failedFiles(value.home)).toEqual(["invalid.yaml"]);
      expect(claimFiles(value.privateRoot, "slots")).toEqual([]);
      expect(claimFiles(value.privateRoot, "owners")).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("durably creates failed before publishing evidence or retiring its source", async () => {
    const value = fixture();
    const name = "first-failure.yaml";
    const source = join(value.queue, name);
    writeFileSync(source, "url: [unterminated\n");
    const dataHome = join(value.home, ".local/share/agentscrape");
    const failedDirectory = join(dataHome, "failed");
    expect(existsSync(failedDirectory)).toBeFalse();
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const realLinkSync = realFs.linkSync;",
      "const realRenameSync = realFs.renameSync;",
      "const descriptors = new Map();",
      "const events = [];",
      `const dataHome = ${JSON.stringify(dataHome)};`,
      `const failed = ${JSON.stringify(failedDirectory)};`,
      `const source = ${JSON.stringify(source)};`,
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      '    if (descriptors.get(descriptor) === dataHome) events.push("failed-parent-sync");',
      "    return realFsyncSync(descriptor);",
      "  },",
      "  linkSync(existing, destination) {",
      '    if (String(destination).startsWith(failed + "/")) events.push("failed-final-link");',
      "    return realLinkSync(existing, destination);",
      "  },",
      "  renameSync(existing, destination) {",
      '    if (String(existing) === source) events.push("source-retire");',
      "    return realRenameSync(existing, destination);",
      "  },",
      "}));",
      'const { processQueue } = await import("./src/queue.ts?failed-parent-order");',
      "await processQueue();",
      "process.stdout.write(JSON.stringify(events));",
    ].join("\n");
    const result = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    const events = JSON.parse(result.stdout);
    expect(events).toContain("failed-parent-sync");
    expect(events).toContain("failed-final-link");
    expect(events).toContain("source-retire");
    expect(events.indexOf("failed-parent-sync")).toBeLessThan(events.indexOf("failed-final-link"));
    expect(events.indexOf("failed-final-link")).toBeLessThan(events.indexOf("source-retire"));
    expect(readFileSync(join(failedDirectory, name), "utf8")).toBe("url: [unterminated\n");
    expect(existsSync(source)).toBeFalse();
  });

  test("failed publication never overwrites a same-name failed record", async () => {
    const value = fixture();
    const failedDirectory = join(value.home, ".local/share/agentscrape/failed");
    mkdirSync(failedDirectory, { recursive: true });
    writeFileSync(join(failedDirectory, "job.yaml"), "existing failed evidence\n");
    const malformed = "url: [unterminated\nsecret: exact queue evidence\n";
    writeFileSync(join(value.queue, "job.yaml"), malformed);
    const child = Bun.spawn([process.execPath, "src/cli.ts", "process-queue"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: value.home },
    });
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(readFileSync(join(failedDirectory, "job.yaml"), "utf8")).toBe(
      "existing failed evidence\n",
    );
    const suffix = readdirSync(failedDirectory).find((name) => name.startsWith("job--failed-"));
    expect(suffix).toBeDefined();
    expect(readFileSync(join(failedDirectory, suffix!), "utf8")).toBe(malformed);
    expect(existsSync(join(value.queue, "job.yaml"))).toBeFalse();
    expect(retirementFiles(value.privateRoot)).toEqual([]);
  });
});

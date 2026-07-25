import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
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

function fixture(): { home: string; queue: string; reconciliation: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "agentscrape-queue-"));
  temporary.push(home);
  const queue = join(home, ".local/share/agentscrape/queue");
  const reconciliation = join(home, ".local/share/agentscrape/reconciliation");
  const bin = join(home, "bin");
  mkdirSync(queue, { recursive: true });
  mkdirSync(bin);
  const executable = join(bin, "agentbrain");
  writeFileSync(
    executable,
    "#!/usr/bin/env bun\nprocess.stdout.write(process.env.TEST_ACK ?? '');\n",
  );
  chmodSync(executable, 0o700);
  return { home, queue, reconciliation, bin };
}

function queueRecord(queue: string, name = "indexed.yaml"): string {
  const path = join(queue, name);
  writeFileSync(
    path,
    [
      "url: https://example.com/saved",
      "destination: /tmp/saved.md",
      "indexer: agentbrain",
      "source: test-ingress",
      "frontmatter:",
      "  authorization: never-publish-this",
      "",
    ].join("\n"),
  );
  return path;
}

function acknowledgement(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    ok: true,
    command: "submit",
    data: {
      status: "queued",
      job_id: 1,
      idempotency_key: "submit:v1:test",
      state: "queued",
      ...overrides,
    },
  });
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

function startReconcile(
  value: ReturnType<typeof fixture>,
  ack: string,
  extraEnv: Record<string, string> = {},
) {
  return Bun.spawn([process.execPath, "src/cli.ts", "reconcile-queue", "--apply"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: value.home,
      PATH: `${value.bin}:${process.env.PATH ?? ""}`,
      TEST_ACK: ack,
      ...extraEnv,
    },
  });
}

async function finish(child: ReturnType<typeof startReconcile>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function reconcile(
  value: ReturnType<typeof fixture>,
  ack: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = startReconcile(value, ack);
  return finish(child);
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function outcomeFiles(reconciliation: string): string[] {
  const directory = join(reconciliation, "outcomes");
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".json"))
    : [];
}

function retirementFiles(reconciliation: string): string[] {
  const directory = join(reconciliation, "retirement-quarantine");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("queue data root resolution", () => {
  test("uses the HOME default when no queue env override is set", () => {
    const home = join(tmpdir(), "agentscrape-home-default");
    expect(resolveDataHome({}, home)).toBe(join(home, ".local", "share", "agentscrape"));
  });

  test("uses XDG_DATA_HOME when present", () => {
    const home = join(tmpdir(), "agentscrape-home-xdg");
    const xdg = join(tmpdir(), "agentscrape-xdg-data-home");
    expect(resolveDataHome({ XDG_DATA_HOME: xdg }, home)).toBe(join(xdg, "agentscrape"));
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

describe("queue reconciliation hardening", () => {
  for (const jobId of [-1, 0, 1.5]) {
    test(`rejects invalid job id ${jobId}`, async () => {
      const value = fixture();
      const source = queueRecord(value.queue);
      const result = await reconcile(value, acknowledgement({ job_id: jobId }));
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).errors).toBe(1);
      expect(existsSync(source)).toBeTrue();
      expect(outcomeFiles(value.reconciliation)).toEqual([]);
    });
  }

  for (const [label, key] of [
    ["empty", ""],
    ["oversized", "x".repeat(501)],
  ] as const) {
    test(`rejects an ${label} idempotency key`, async () => {
      const value = fixture();
      const source = queueRecord(value.queue);
      const result = await reconcile(value, acknowledgement({ idempotency_key: key }));
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).errors).toBe(1);
      expect(existsSync(source)).toBeTrue();
      expect(outcomeFiles(value.reconciliation)).toEqual([]);
    });
  }

  test("rejects malformed acknowledgement JSON without leaking it", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const result = await reconcile(value, '{"partial":"TOP-SECRET-ACK"');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("returned invalid JSON");
    expect(result.stdout).not.toContain("TOP-SECRET-ACK");
    expect(existsSync(source)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toEqual([]);
    expect(JSON.parse(result.stdout).remaining_records).toBe(1);
  });

  test("publishes an exact receipt and durably archives after a valid acknowledgement", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const result = await reconcile(value, acknowledgement());
    expect(result.code).toBe(0);
    expect(existsSync(source)).toBeFalse();
    const files = outcomeFiles(value.reconciliation);
    expect(files).toHaveLength(1);
    const manifest = JSON.parse(
      readFileSync(join(value.reconciliation, "outcomes", files[0]!), "utf8"),
    );
    expect(manifest.agentbrain_receipt).toEqual({
      status: "queued",
      job_id: 1,
      idempotency_key: "submit:v1:test",
      state: "queued",
    });
    expect(manifest.evidence.frontmatter.authorization).toBe("[REDACTED]");
    expect(manifest.archive_record).toBe(
      `archive/pending/${manifest.record_id.slice(0, 16)}-indexed.yaml`,
    );
    expect(existsSync(join(value.reconciliation, manifest.archive_record))).toBeTrue();
    expect(retirementFiles(value.reconciliation)).toEqual([]);
  });

  test("does not follow queue record symlinks", async () => {
    const value = fixture();
    const external = join(value.home, "external.yaml");
    writeFileSync(external, "password: do-not-read\n");
    symlinkSync(external, join(value.queue, "linked.yaml"));
    const result = await reconcile(value, acknowledgement());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).total_records).toBe(0);
    expect(readFileSync(external, "utf8")).toBe("password: do-not-read\n");
  });

  test("keeps the source when outcome publication is blocked by a symlink", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const external = join(value.home, "external-outcomes");
    mkdirSync(external);
    mkdirSync(value.reconciliation, { recursive: true });
    symlinkSync(external, join(value.reconciliation, "outcomes"));
    const result = await reconcile(value, acknowledgement());
    expect(result.code).toBe(1);
    expect(existsSync(source)).toBeTrue();
    expect(readdirSync(external)).toEqual([]);
  });

  test("never overwrites a differing outcome", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const inventoryChild = Bun.spawn([process.execPath, "src/cli.ts", "reconcile-queue"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: value.home },
    });
    const [, inventoryText] = await Promise.all([
      inventoryChild.exited,
      new Response(inventoryChild.stdout).text(),
      new Response(inventoryChild.stderr).text(),
    ]);
    const recordId = JSON.parse(inventoryText).records[0].record_id;
    const outcomes = join(value.reconciliation, "outcomes");
    mkdirSync(outcomes, { recursive: true, mode: 0o700 });
    const outcome = join(outcomes, `${recordId}.json`);
    const evidence = '{"different":"outcome evidence"}\n';
    writeFileSync(outcome, evidence, { mode: 0o600 });

    const result = await reconcile(value, acknowledgement());
    expect(result.code).toBe(1);
    expect(readFileSync(outcome, "utf8")).toBe(evidence);
    expect(existsSync(source)).toBeTrue();
  });

  test("never overwrites a differing archive and resumes an identical archive", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const raw = readFileSync(source);
    const inventoryChild = Bun.spawn([process.execPath, "src/cli.ts", "reconcile-queue"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: value.home },
    });
    const [, inventoryText] = await Promise.all([
      inventoryChild.exited,
      new Response(inventoryChild.stdout).text(),
      new Response(inventoryChild.stderr).text(),
    ]);
    const recordId = JSON.parse(inventoryText).records[0].record_id;
    const archiveDirectory = join(value.reconciliation, "archive", "pending");
    mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    const archive = join(archiveDirectory, `${recordId.slice(0, 16)}-indexed.yaml`);
    writeFileSync(archive, "different archive evidence\n", { mode: 0o600 });

    const blocked = await reconcile(value, acknowledgement());
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout).remaining_records).toBe(1);
    expect(readFileSync(archive, "utf8")).toBe("different archive evidence\n");
    expect(existsSync(source)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toHaveLength(1);

    rmSync(archive);
    writeFileSync(archive, raw, { mode: 0o600 });
    const resumed = await reconcile(value, "must not be submitted again");
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout).already_reconciled).toBe(1);
    expect(readFileSync(archive)).toEqual(raw);
    expect(existsSync(source)).toBeFalse();
  });

  test("does not report success or remove the source when fsync fails", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      'mock.module("node:fs", () => ({ ...realFs, fsyncSync() { throw new Error("simulated fsync failure"); } }));',
      'const { reconcileQueue } = await import("./src/queue.ts?fsync-failure");',
      "const result = await reconcileQueue({ apply: true });",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: value.home,
        PATH: `${value.bin}:${process.env.PATH ?? ""}`,
        TEST_ACK: acknowledgement(),
      },
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).errors).toBe(1);
    expect(existsSync(source)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toEqual([]);
  });

  test("recovers an outcome after archive publication fails without resubmitting", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    mkdirSync(value.reconciliation, { recursive: true });
    writeFileSync(join(value.reconciliation, "archive"), "blocks archive directory\n");

    const failed = await reconcile(value, acknowledgement());
    expect(failed.code).toBe(1);
    expect(existsSync(source)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toHaveLength(1);

    rmSync(join(value.reconciliation, "archive"));
    const recovered = await reconcile(value, "not valid JSON and must not be submitted");
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).already_reconciled).toBe(1);
    expect(existsSync(source)).toBeFalse();
  });

  test("retries one-shot authoritative outcome file and directory sync failures", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    mkdirSync(value.reconciliation, { recursive: true });
    const archiveBlocker = join(value.reconciliation, "archive");
    writeFileSync(archiveBlocker, "blocks archive directory\n");
    const interrupted = await reconcile(value, acknowledgement());
    expect(interrupted.code).toBe(1);
    const outcomeName = outcomeFiles(value.reconciliation)[0]!;
    const outcome = join(value.reconciliation, "outcomes", outcomeName);
    const outcomeDirectory = join(value.reconciliation, "outcomes");
    const manifest = JSON.parse(readFileSync(outcome, "utf8"));
    rmSync(archiveBlocker);

    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const descriptors = new Map();",
      "let fileAttempts = 0;",
      "let directoryAttempts = 0;",
      `const outcome = ${JSON.stringify(outcome)};`,
      `const outcomeDirectory = ${JSON.stringify(outcomeDirectory)};`,
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      "    const path = descriptors.get(descriptor);",
      "    if (path === outcome && ++fileAttempts === 1)",
      '      throw new Error("one-shot outcome file fsync failure");',
      "    if (path === outcomeDirectory && ++directoryAttempts === 1)",
      '      throw new Error("one-shot outcome directory fsync failure");',
      "    return realFsyncSync(descriptor);",
      "  },",
      "}));",
      'const { reconcileQueue } = await import("./src/queue.ts?outcome-sync-retry");',
      "const result = await reconcileQueue({ apply: true });",
      "process.stdout.write(JSON.stringify({ result, fileAttempts, directoryAttempts }));",
    ].join("\n");
    const resumed = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(resumed.code, resumed.stderr).toBe(0);
    const evidence = JSON.parse(resumed.stdout);
    expect(evidence.fileAttempts).toBe(2);
    expect(evidence.directoryAttempts).toBe(2);
    expect(evidence.result.errors).toBe(0);
    expect(evidence.result.already_reconciled).toBe(1);
    expect(existsSync(join(value.reconciliation, manifest.archive_record))).toBeTrue();
    expect(existsSync(source)).toBeFalse();
  });

  test("preserves source when authoritative outcome sync persistently fails", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    mkdirSync(value.reconciliation, { recursive: true });
    const archiveBlocker = join(value.reconciliation, "archive");
    writeFileSync(archiveBlocker, "blocks archive directory\n");
    const interrupted = await reconcile(value, acknowledgement());
    expect(interrupted.code).toBe(1);
    const outcomeName = outcomeFiles(value.reconciliation)[0]!;
    const outcomeDirectory = join(value.reconciliation, "outcomes");
    rmSync(archiveBlocker);

    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const descriptors = new Map();",
      "let directoryAttempts = 0;",
      `const outcomeDirectory = ${JSON.stringify(outcomeDirectory)};`,
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      "    if (descriptors.get(descriptor) === outcomeDirectory) {",
      "      directoryAttempts += 1;",
      '      throw new Error("persistent outcome directory fsync failure");',
      "    }",
      "    return realFsyncSync(descriptor);",
      "  },",
      "}));",
      'const { reconcileQueue } = await import("./src/queue.ts?outcome-sync-persistent");',
      "const result = await reconcileQueue({ apply: true });",
      "process.stdout.write(JSON.stringify({ result, directoryAttempts }));",
    ].join("\n");
    const blocked = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(blocked.code, blocked.stderr).toBe(0);
    const evidence = JSON.parse(blocked.stdout);
    expect(evidence.directoryAttempts).toBe(2);
    expect(evidence.result.errors).toBe(1);
    expect(evidence.result.remaining_records).toBe(1);
    expect(existsSync(source)).toBeTrue();
    expect(existsSync(join(value.reconciliation, "archive"))).toBeFalse();

    const inventoryScript = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      'mock.module("node:fs", () => ({ ...realFs, fsyncSync() { throw new Error("inventory must not sync"); } }));',
      'const { reconcileQueue } = await import("./src/queue.ts?outcome-inventory-no-sync");',
      "const result = await reconcileQueue();",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const inventory = await finish(
      Bun.spawn([process.execPath, "-e", inventoryScript], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(inventory.code, inventory.stderr).toBe(0);
    const inventoryResult = JSON.parse(inventory.stdout);
    expect(inventoryResult.records[0].record_id).toBe(outcomeName.replace(/\.json$/, ""));
    expect(inventoryResult.records[0].reconciled).toBeTrue();
    expect(existsSync(source)).toBeTrue();
  });

  test("two reconciliation workers make one submit while the live owner retains its claim", async () => {
    const value = fixture();
    queueRecord(value.queue);
    const ready = join(value.home, "ready");
    const release = join(value.home, "release");
    const calls = join(value.home, "calls");
    const executable = join(value.bin, "agentbrain");
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env bun",
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        'appendFileSync(process.env.TEST_CALLS!, "call\\n");',
        'writeFileSync(process.env.TEST_READY!, "ready\\n");',
        "while (!existsSync(process.env.TEST_RELEASE!)) await Bun.sleep(10);",
        "process.stdout.write(process.env.TEST_ACK ?? '');",
        "",
      ].join("\n"),
    );
    const env = {
      TEST_READY: ready,
      TEST_RELEASE: release,
      TEST_CALLS: calls,
    };
    const owner = startReconcile(value, acknowledgement(), env);
    await waitFor(ready);
    const peerResult = await finish(startReconcile(value, acknowledgement(), env));
    expect(peerResult.code).toBe(0);
    expect(JSON.parse(peerResult.stdout).claimed_elsewhere).toBe(1);
    writeFileSync(release, "release\n");
    const ownerResult = await finish(owner);
    expect(ownerResult.code).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("call\n");
    expect(outcomeFiles(value.reconciliation)).toHaveLength(1);
    expect(readdirSync(join(value.reconciliation, "archive", "pending"))).toHaveLength(1);
    expect(retirementFiles(value.reconciliation)).toEqual([]);
  });

  test("a process-queue peer skips a pending record held by reconciliation", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const ready = join(value.home, "ready");
    const release = join(value.home, "release");
    const calls = join(value.home, "calls");
    writeFileSync(
      join(value.bin, "agentbrain"),
      [
        "#!/usr/bin/env bun",
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        'appendFileSync(process.env.TEST_CALLS!, "call\\n");',
        'writeFileSync(process.env.TEST_READY!, "ready\\n");',
        "while (!existsSync(process.env.TEST_RELEASE!)) await Bun.sleep(10);",
        "process.stdout.write(process.env.TEST_ACK ?? '');",
        "",
      ].join("\n"),
    );
    const env = { TEST_READY: ready, TEST_RELEASE: release, TEST_CALLS: calls };
    const owner = startReconcile(value, acknowledgement(), env);
    await waitFor(ready);

    const peer = await finish(startProcess(value));
    expect(peer.code).toBe(0);
    expect(peer.stderr).toContain("processed=0 failed=0 frozen=0");
    expect(existsSync(source)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toEqual([]);
    const failedDirectory = join(value.home, ".local/share/agentscrape/failed");
    expect(existsSync(failedDirectory) ? readdirSync(failedDirectory) : []).toEqual([]);

    writeFileSync(release, "release\n");
    const completed = await finish(owner);
    expect(completed.code).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("call\n");
    expect(existsSync(source)).toBeFalse();
    expect(outcomeFiles(value.reconciliation)).toHaveLength(1);
    expect(readdirSync(join(value.reconciliation, "archive", "pending"))).toHaveLength(1);
    expect(retirementFiles(value.reconciliation)).toEqual([]);
  });

  test("a killed owner is recovered and its unreceipted submit is retried", async () => {
    const value = fixture();
    queueRecord(value.queue);
    const ready = join(value.home, "ready");
    const release = join(value.home, "release");
    const calls = join(value.home, "calls");
    const executable = join(value.bin, "agentbrain");
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env bun",
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        'appendFileSync(process.env.TEST_CALLS!, "call\\n");',
        'writeFileSync(process.env.TEST_READY!, "ready\\n");',
        "while (!existsSync(process.env.TEST_RELEASE!)) await Bun.sleep(10);",
        "process.stdout.write(process.env.TEST_ACK ?? '');",
        "",
      ].join("\n"),
    );
    const env = { TEST_READY: ready, TEST_RELEASE: release, TEST_CALLS: calls };
    const doomed = startReconcile(value, acknowledgement(), env);
    await waitFor(ready);
    doomed.kill(9);
    await finish(doomed);
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env bun",
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.TEST_CALLS!, "call\\n");',
        "process.stdout.write(process.env.TEST_ACK ?? '');",
        "",
      ].join("\n"),
    );
    const recovered = await finish(startReconcile(value, acknowledgement(), env));
    expect(recovered.code).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("call\ncall\n");
    expect(outcomeFiles(value.reconciliation)).toHaveLength(1);
  });

  test("counts a replacement generation that appears between inventory and claim", async () => {
    const value = fixture();
    const source = queueRecord(value.queue, "replaced.yaml");
    const replacementPath = join(value.queue, ".replacement.tmp");
    const replacement =
      "url: https://example.com/replacement\ndestination: /tmp/replacement.md\nindexer: agentbrain\nsource: replacement\n";
    writeFileSync(replacementPath, replacement);
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realRenameSync = realFs.renameSync;",
      "let sourceOpens = 0;",
      `const source = ${JSON.stringify(source)};`,
      `const replacementPath = ${JSON.stringify(replacementPath)};`,
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    if (String(path) === source && ++sourceOpens === 2)",
      "      realRenameSync(replacementPath, source);",
      "    return realOpenSync(path, flags, mode);",
      "  },",
      "}));",
      'const { reconcileQueue } = await import("./src/queue.ts?replacement-before-claim");',
      "const result = await reconcileQueue({ apply: true });",
      "process.stdout.write(JSON.stringify(result));",
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
    const outcome = JSON.parse(result.stdout);
    expect(outcome.selected_records).toBe(0);
    expect(outcome.remaining_records).toBe(1);
    expect(outcome.errors).toBe(0);
    expect(readFileSync(source, "utf8")).toBe(replacement);
  });

  test("malformed, symlinked, and missing-owner claims are retained fail-closed", async () => {
    const value = fixture();
    for (const name of ["malformed.yaml", "symlink.yaml", "orphan.yaml"])
      queueRecord(value.queue, name);
    const claims = join(value.reconciliation, "claims");
    const slots = join(claims, "slots");
    const owners = join(claims, "owners");
    const quarantine = join(claims, "quarantine");
    mkdirSync(slots, { recursive: true, mode: 0o700 });
    mkdirSync(owners, { mode: 0o700 });
    mkdirSync(quarantine, { mode: 0o700 });
    const key = (name: string) => createHash("sha256").update(`pending\0${name}`).digest("hex");
    const malformedSlot = join(slots, key("malformed.yaml"));
    writeFileSync(malformedSlot, "not owner json\n", { mode: 0o600 });
    const external = join(value.home, "external-claim");
    writeFileSync(external, "foreign evidence\n", { mode: 0o600 });
    const symlinkSlot = join(slots, key("symlink.yaml"));
    symlinkSync(external, symlinkSlot);
    const token = randomUUID();
    const rootInfo = lstatSync(value.reconciliation, { bigint: true });
    const orphanSlot = join(slots, key("orphan.yaml"));
    writeFileSync(
      orphanSlot,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        token,
        owner: `${token}.json`,
        operation: "reconcile",
        area: "pending",
        name: "orphan.yaml",
        reconciliation_root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
        source: {
          dev: "0",
          ino: "0",
          size: "0",
          mtimeNs: "0",
          ctimeNs: "0",
          sha256: "0".repeat(64),
        },
      })}\n`,
      { mode: 0o600 },
    );

    const result = await reconcile(value, acknowledgement());
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors).toBe(3);
    expect(existsSync(malformedSlot)).toBeTrue();
    expect(lstatSync(symlinkSlot).isSymbolicLink()).toBeTrue();
    expect(existsSync(orphanSlot)).toBeTrue();
    expect(outcomeFiles(value.reconciliation)).toEqual([]);
  });
});

describe("queue processing claim publication", () => {
  for (const kind of ["malformed", "symlink", "missing-owner", "uppercase UUID"] as const) {
    test(`fails closed on a ${kind} fixed claim slot`, async () => {
      const value = fixture();
      const name = "blocked.yaml";
      const source = queueRecord(value.queue, name);
      const claims = join(value.reconciliation, "claims");
      const slots = join(claims, "slots");
      const owners = join(claims, "owners");
      mkdirSync(slots, { recursive: true, mode: 0o700 });
      mkdirSync(owners, { mode: 0o700 });
      mkdirSync(join(claims, "quarantine"), { mode: 0o700 });
      const slot = join(slots, createHash("sha256").update(`pending\0${name}`).digest("hex"));
      let retainedEvidence = slot;
      if (kind === "malformed") writeFileSync(slot, "not owner json\n", { mode: 0o600 });
      else if (kind === "symlink") {
        retainedEvidence = join(value.home, "external-claim");
        writeFileSync(retainedEvidence, "foreign evidence\n", { mode: 0o600 });
        symlinkSync(retainedEvidence, slot);
      } else {
        const token = kind === "uppercase UUID" ? randomUUID().toUpperCase() : randomUUID();
        const rootInfo = lstatSync(value.reconciliation, { bigint: true });
        const bytes = `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          owner: `${token}.json`,
          operation: "process",
          area: "pending",
          name,
          reconciliation_root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
          source: {
            dev: "0",
            ino: "0",
            size: "0",
            mtimeNs: "0",
            ctimeNs: "0",
            sha256: "0".repeat(64),
          },
        })}\n`;
        if (kind === "missing-owner") writeFileSync(slot, bytes, { mode: 0o600 });
        else {
          const owner = join(owners, `${token}.json`);
          writeFileSync(owner, bytes, { mode: 0o600 });
          linkSync(owner, slot);
        }
      }

      const result = await finish(startProcess(value));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("claim evidence blocks queue record");
      expect(existsSync(source)).toBeTrue();
      expect(existsSync(retainedEvidence)).toBeTrue();
      expect(
        kind === "symlink" ? lstatSync(slot).isSymbolicLink() : lstatSync(slot).isFile(),
      ).toBeTrue();
      expect(outcomeFiles(value.reconciliation)).toEqual([]);
    });
  }

  test("cleans both claim links when publication fsync fails after linking the slot", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const descriptors = new Map();",
      "let failed = false;",
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      '    if (!failed && descriptors.get(descriptor)?.endsWith("/claims/slots")) {',
      "      failed = true;",
      '      throw new Error("simulated slot publication fsync failure");',
      "    }",
      "    return realFsyncSync(descriptor);",
      "  },",
      "}));",
      'const { reconcileQueue } = await import("./src/queue.ts?slot-fsync-failure");',
      "const result = await reconcileQueue({ apply: true });",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: value.home,
        PATH: `${value.bin}:${process.env.PATH ?? ""}`,
        TEST_ACK: acknowledgement(),
      },
    });
    const result = await finish(child);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).errors).toBe(1);
    expect(JSON.parse(result.stdout).remaining_records).toBe(1);
    expect(existsSync(source)).toBeTrue();
    expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toEqual([]);
    expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toEqual([]);
  });

  test("keeps the owner when slot unlink synchronization fails", async () => {
    const value = fixture();
    const name = "release-sync.yaml";
    const source = queueRecord(value.queue, name);
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const descriptors = new Map();",
      "let slotSyncs = 0;",
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      '    if (descriptors.get(descriptor)?.endsWith("/claims/slots") && ++slotSyncs === 2)',
      '      throw new Error("simulated slot unlink sync failure");',
      "    return realFsyncSync(descriptor);",
      "  },",
      "}));",
      'const { processQueue } = await import("./src/queue.ts?slot-release-sync-failure");',
      "await processQueue();",
    ].join("\n");
    const result = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "claim slot for release-sync.yaml removal could not be synchronized",
    );
    expect(existsSync(source)).toBeTrue();
    const claims = join(value.reconciliation, "claims");
    const slots = join(claims, "slots");
    const owners = join(claims, "owners");
    expect(readdirSync(slots)).toEqual([]);
    const ownerNames = readdirSync(owners);
    expect(ownerNames).toHaveLength(1);
    const owner = JSON.parse(readFileSync(join(owners, ownerNames[0]!), "utf8"));
    expect(owner.name).toBe(name);
    expect(owner.owner).toBe(ownerNames[0]);
    expect(existsSync(join(owners, owner.owner))).toBeTrue();
  });

  test("does not report frozen success when exact claim release fails", async () => {
    const value = fixture();
    const source = queueRecord(value.queue, "frozen.yaml");
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realUnlinkSync = realFs.unlinkSync;",
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  unlinkSync(path) {",
      '    if (String(path).includes("/claims/slots/")) throw new Error("simulated slot unlink failure");',
      "    return realUnlinkSync(path);",
      "  },",
      "}));",
      'const { processQueue } = await import("./src/queue.ts?release-failure");',
      "await processQueue();",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: value.home },
    });
    const result = await finish(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("claim slot for frozen.yaml could not be removed");
    expect(existsSync(source)).toBeTrue();
    const slots = readdirSync(join(value.reconciliation, "claims", "slots"));
    const owners = readdirSync(join(value.reconciliation, "claims", "owners"));
    expect(slots).toHaveLength(1);
    expect(owners).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(value.reconciliation, "claims", "owners", owners[0]!), "utf8"))
        .pid,
    ).toBeGreaterThan(0);
  });

  test("does not report processed success when final claim release fails", async () => {
    const value = fixture();
    const destination = join(value.home, "processed.md");
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# processed before release\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    try {
      writeFileSync(
        join(value.queue, "normal.yaml"),
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\n`,
      );
      const script = [
        'import { mock } from "bun:test";',
        'import * as realFs from "node:fs";',
        "const realUnlinkSync = realFs.unlinkSync;",
        'mock.module("node:fs", () => ({',
        "  ...realFs,",
        "  unlinkSync(path) {",
        '    if (String(path).includes("/claims/slots/")) throw new Error("simulated slot unlink failure");',
        "    return realUnlinkSync(path);",
        "  },",
        "}));",
        'const { processQueue } = await import("./src/queue.ts?processed-release-failure");',
        "await processQueue();",
      ].join("\n");
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      });
      const result = await finish(child);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("claim slot for normal.yaml could not be removed");
      expect(readFileSync(destination, "utf8")).toContain("processed before release");
      expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toHaveLength(1);
      expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toHaveLength(1);
      expect(retirementFiles(value.reconciliation)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("preserves the operation error when claim release also fails", async () => {
    const value = fixture();
    const source = queueRecord(value.queue);
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realUnlinkSync = realFs.unlinkSync;",
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  unlinkSync(path) {",
      '    if (String(path).includes("/claims/slots/")) throw new Error("simulated slot unlink failure");',
      "    return realUnlinkSync(path);",
      "  },",
      "}));",
      'const { reconcileQueue } = await import("./src/queue.ts?primary-and-release-failure");',
      "try {",
      "  await reconcileQueue({ apply: true });",
      '  process.stdout.write(JSON.stringify({ aggregate: false, messages: ["unexpected success"] }));',
      "} catch (error) {",
      "  process.stdout.write(JSON.stringify({",
      "    aggregate: error instanceof AggregateError,",
      "    messages: error instanceof AggregateError",
      "      ? error.errors.map((item) => item instanceof Error ? item.message : String(item))",
      "      : [error instanceof Error ? error.message : String(error)],",
      "  }));",
      "}",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: value.home,
        PATH: `${value.bin}:${process.env.PATH ?? ""}`,
        TEST_ACK: '{"partial":true',
      },
    });
    const result = await finish(child);
    expect(result.code).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.aggregate).toBeTrue();
    expect(evidence.messages).toHaveLength(2);
    expect(evidence.messages[0]).toContain("agentbrain submit returned invalid JSON");
    expect(evidence.messages[1]).toContain("claim slot for indexed.yaml could not be removed");
    expect(existsSync(source)).toBeTrue();
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
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\n`,
      );
      const owner = startProcess(value);
      await seen;
      const peer = await finish(startProcess(value));
      expect(peer.code).toBe(0);
      releaseResponse();
      const winner = await finish(owner);
      expect(winner.code).toBe(0);
      expect(calls).toBe(1);
      expect(readFileSync(destination, "utf8")).toContain("# claimed once");
      expect(existsSync(join(value.queue, "job.yaml"))).toBeFalse();
      expect(retirementFiles(value.reconciliation)).toEqual([]);
      expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toEqual([]);
      expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("synchronizes the final destination file and parent before successful retirement", async () => {
    const value = fixture();
    const destination = join(value.home, "durable.md");
    const source = join(value.queue, "durable.yaml");
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# durable destination\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    try {
      writeFileSync(
        source,
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\n`,
      );
      const script = [
        'import { mock } from "bun:test";',
        'import * as realFs from "node:fs";',
        "const realOpenSync = realFs.openSync;",
        "const realCloseSync = realFs.closeSync;",
        "const realFsyncSync = realFs.fsyncSync;",
        "const realRenameSync = realFs.renameSync;",
        "const descriptors = new Map();",
        "const events = [];",
        `const destination = ${JSON.stringify(destination)};`,
        `const parent = ${JSON.stringify(value.home)};`,
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
        '    if (descriptors.get(descriptor) === destination) events.push("destination-file-sync");',
        '    if (descriptors.get(descriptor) === parent) events.push("destination-parent-sync");',
        "    return realFsyncSync(descriptor);",
        "  },",
        "  renameSync(existing, target) {",
        '    if (String(existing) === source) events.push("source-retire");',
        "    return realRenameSync(existing, target);",
        "  },",
        "}));",
        'const { processQueue } = await import("./src/queue.ts?destination-sync-order");',
        "const result = await processQueue();",
        "process.stdout.write(JSON.stringify({ result, events }));",
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
      const evidence = JSON.parse(child.stdout);
      expect(evidence.result).toEqual({ processed: 1, failed: 0, frozen: 0 });
      expect(evidence.events).toEqual([
        "destination-file-sync",
        "destination-parent-sync",
        "source-retire",
      ]);
      expect(existsSync(source)).toBeFalse();
    } finally {
      server.stop(true);
    }
  });

  test("publishes failed evidence when final destination synchronization fails", async () => {
    const value = fixture();
    const destination = join(value.home, "unsynced.md");
    const source = join(value.queue, "unsynced.yaml");
    const queueBytes = `url: https://placeholder.invalid/document.md\ndestination: ${destination}\n`;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# written but not durably retired\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    try {
      const actualQueueBytes = queueBytes.replace(
        "https://placeholder.invalid/document.md",
        new URL("document.md", server.url).href,
      );
      writeFileSync(source, actualQueueBytes);
      const script = [
        'import { mock } from "bun:test";',
        'import * as realFs from "node:fs";',
        "const realOpenSync = realFs.openSync;",
        "const realCloseSync = realFs.closeSync;",
        "const realFsyncSync = realFs.fsyncSync;",
        "const descriptors = new Map();",
        "let failed = false;",
        `const parent = ${JSON.stringify(value.home)};`,
        'mock.module("node:fs", () => ({',
        "  ...realFs,",
        "  openSync(path, flags, mode) {",
        "    const descriptor = realOpenSync(path, flags, mode);",
        "    descriptors.set(descriptor, String(path));",
        "    return descriptor;",
        "  },",
        "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
        "  fsyncSync(descriptor) {",
        "    if (!failed && descriptors.get(descriptor) === parent) {",
        "      failed = true;",
        '      throw new Error("simulated destination parent fsync failure");',
        "    }",
        "    return realFsyncSync(descriptor);",
        "  },",
        "}));",
        'const { processQueue } = await import("./src/queue.ts?destination-sync-failure");',
        "const result = await processQueue();",
        "process.stdout.write(JSON.stringify(result));",
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
      expect(JSON.parse(child.stdout)).toEqual({ processed: 0, failed: 1, frozen: 0 });
      expect(
        readFileSync(join(value.home, ".local/share/agentscrape/failed/unsynced.yaml")),
      ).toEqual(Buffer.from(actualQueueBytes));
      expect(existsSync(source)).toBeFalse();
    } finally {
      server.stop(true);
    }
  });

  test("a same-name generation replacement survives final retirement", async () => {
    const value = fixture();
    const destination = join(value.home, "result.md");
    const summaryReady = join(value.home, "summary-ready");
    const summaryRelease = join(value.home, "summary-release");
    const summaryctl = join(value.bin, "summaryctl");
    writeFileSync(
      summaryctl,
      [
        "#!/usr/bin/env bun",
        'import { existsSync, writeFileSync } from "node:fs";',
        'writeFileSync(process.env.SUMMARY_READY!, "ready\\n");',
        "while (!existsSync(process.env.SUMMARY_RELEASE!)) await Bun.sleep(10);",
        'process.stdout.write("summary\\n");',
        "",
      ].join("\n"),
    );
    chmodSync(summaryctl, 0o700);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("# original generation\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    const source = join(value.queue, "job.yaml");
    const replacement = "url: https://example.com/replacement\nindexer: agentbrain\n";
    try {
      writeFileSync(
        source,
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\nsummarize: true\n`,
      );
      const worker = startProcess(value, {
        SUMMARY_READY: summaryReady,
        SUMMARY_RELEASE: summaryRelease,
      });
      await waitFor(summaryReady);
      const temporaryReplacement = join(value.queue, ".replacement.tmp");
      writeFileSync(temporaryReplacement, replacement);
      renameSync(temporaryReplacement, source);
      writeFileSync(summaryRelease, "release\n");
      const result = await finish(worker);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("processed=1");
      expect(readFileSync(source, "utf8")).toBe(replacement);
      expect(readFileSync(destination, "utf8")).toContain("summary: summary");
      expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toEqual([]);
      expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("cancellation and frozen records stay public with claims released", async () => {
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
        `url: ${new URL("document.md", server.url).href}\ndestination: ${destination}\nsummarize: true\n`,
      );
      const worker = startProcess(value, { SUMMARY_READY: summaryReady });
      await waitFor(summaryReady);
      worker.kill("SIGTERM");
      const cancelled = await finish(worker);
      expect(cancelled.code).toBe(143);
      expect(existsSync(source)).toBeTrue();
      expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toEqual([]);
      expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toEqual([]);

      rmSync(source);
      queueRecord(value.queue, "frozen.yaml");
      const frozen = await finish(startProcess(value));
      expect(frozen.code).toBe(0);
      expect(frozen.stderr).toContain("frozen=1");
      expect(existsSync(join(value.queue, "frozen.yaml"))).toBeTrue();
      expect(readdirSync(join(value.reconciliation, "claims", "slots"))).toEqual([]);
      expect(readdirSync(join(value.reconciliation, "claims", "owners"))).toEqual([]);
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

  test("accepts a one-shot failed-directory sync ambiguity without duplicate evidence", async () => {
    const value = fixture();
    const name = "one-shot.yaml";
    const source = join(value.queue, name);
    const malformed = "url: [unterminated\none-shot: evidence\n";
    writeFileSync(source, malformed);
    const failedDirectory = join(value.home, ".local/share/agentscrape/failed");
    const script = [
      'import { mock } from "bun:test";',
      'import * as realFs from "node:fs";',
      "const realOpenSync = realFs.openSync;",
      "const realCloseSync = realFs.closeSync;",
      "const realFsyncSync = realFs.fsyncSync;",
      "const descriptors = new Map();",
      "let failed = false;",
      `const failedDirectory = ${JSON.stringify(failedDirectory)};`,
      'mock.module("node:fs", () => ({',
      "  ...realFs,",
      "  openSync(path, flags, mode) {",
      "    const descriptor = realOpenSync(path, flags, mode);",
      "    descriptors.set(descriptor, String(path));",
      "    return descriptor;",
      "  },",
      "  closeSync(descriptor) { descriptors.delete(descriptor); return realCloseSync(descriptor); },",
      "  fsyncSync(descriptor) {",
      "    if (!failed && descriptors.get(descriptor) === failedDirectory) {",
      "      failed = true;",
      '      throw new Error("one-shot failed-directory sync failure");',
      "    }",
      "    return realFsyncSync(descriptor);",
      "  },",
      "}));",
      'const { processQueue } = await import("./src/queue.ts?one-shot-failed-sync");',
      "const result = await processQueue();",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const first = await finish(
      Bun.spawn([process.execPath, "-e", script], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: value.home },
      }),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).failed).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readdirSync(failedDirectory)).toEqual([name]);
    expect(readFileSync(join(failedDirectory, name), "utf8")).toBe(malformed);

    const rerun = await finish(startProcess(value));
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(readdirSync(failedDirectory)).toEqual([name]);
  });

  test("publishes long failed names exactly and byte-bounds collision names", async () => {
    const value = fixture();
    const name = `${"a".repeat(220)}.yaml`;
    const failedDirectory = join(value.home, ".local/share/agentscrape/failed");
    const firstMalformed = "url: [first malformed\n";
    writeFileSync(join(value.queue, name), firstMalformed);
    const first = await finish(startProcess(value));
    expect(first.code, first.stderr).toBe(0);
    expect(readFileSync(join(failedDirectory, name), "utf8")).toBe(firstMalformed);

    const secondMalformed = "url: [second malformed\n";
    writeFileSync(join(value.queue, name), secondMalformed);
    const second = await finish(startProcess(value));
    expect(second.code, second.stderr).toBe(0);
    expect(readFileSync(join(failedDirectory, name), "utf8")).toBe(firstMalformed);
    const collision = readdirSync(failedDirectory).find((candidate) => candidate !== name);
    expect(collision).toBeDefined();
    expect(Buffer.byteLength(collision!)).toBeLessThanOrEqual(255);
    expect(collision).toContain("--failed-");
    expect(collision).toEndWith(".yaml");
    expect(readFileSync(join(failedDirectory, collision!), "utf8")).toBe(secondMalformed);
    expect(existsSync(join(value.queue, name))).toBeFalse();
  });

  test("archives a valid long final name without lengthening its temporary name", async () => {
    const value = fixture();
    const name = `${"b".repeat(220)}.yaml`;
    const source = queueRecord(value.queue, name);
    const result = await reconcile(value, acknowledgement());
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(source)).toBeFalse();
    const manifestName = outcomeFiles(value.reconciliation)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(value.reconciliation, "outcomes", manifestName), "utf8"),
    );
    const archiveName = manifest.archive_record.split("/").at(-1);
    expect(Buffer.byteLength(archiveName)).toBeLessThanOrEqual(255);
    expect(archiveName).toBe(`${manifest.record_id.slice(0, 16)}-${name}`);
    expect(existsSync(join(value.reconciliation, manifest.archive_record))).toBeTrue();
  });

  test("bounds an overflowing 239-byte archive name and reuses it for outcome recovery", async () => {
    const value = fixture();
    const name = `${"c".repeat(234)}.yaml`;
    expect(Buffer.byteLength(name)).toBe(239);
    const source = queueRecord(value.queue, name);
    const raw = readFileSync(source);
    const result = await reconcile(value, acknowledgement());
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(source)).toBeFalse();
    const manifestName = outcomeFiles(value.reconciliation)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(value.reconciliation, "outcomes", manifestName), "utf8"),
    );
    const archiveName = manifest.archive_record.split("/").at(-1);
    expect(Buffer.byteLength(archiveName)).toBeLessThanOrEqual(255);
    expect(archiveName).not.toBe(`${manifest.record_id.slice(0, 16)}-${name}`);
    expect(archiveName).toEndWith(
      `--${createHash("sha256").update(name).digest("hex").slice(0, 16)}.yaml`,
    );
    expect(readFileSync(join(value.reconciliation, manifest.archive_record))).toEqual(raw);

    queueRecord(value.queue, name);
    const recovered = await reconcile(value, "must not submit an existing outcome");
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).already_reconciled).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readdirSync(join(value.reconciliation, "archive", "pending"))).toEqual([archiveName]);
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
    expect(retirementFiles(value.reconciliation)).toEqual([]);
  });
});

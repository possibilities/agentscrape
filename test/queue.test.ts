import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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

async function reconcile(
  value: ReturnType<typeof fixture>,
  ack: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "reconcile-queue", "--apply"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: value.home,
      PATH: `${value.bin}:${process.env.PATH ?? ""}`,
      TEST_ACK: ack,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function outcomeFiles(reconciliation: string): string[] {
  const directory = join(reconciliation, "outcomes");
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".json"))
    : [];
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
    expect(existsSync(join(value.reconciliation, manifest.archive_record))).toBeTrue();
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
});

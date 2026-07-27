import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { probeXReadiness, xReadinessStatusExitCode } from "../scripts/check-x-readiness";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fake(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agentscrape-readiness-"));
  temporary.push(directory);
  const path = join(directory, "agentscrape");
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
async function once(path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "scripts/check-x-readiness.ts", "--once"], {
    cwd: root,
    env: { ...process.env, PATH: path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 256_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("X readiness operational helper", () => {
  test("reports ready only when both presets and the cursor flag are deployed", async () => {
    const binary = fake(`case "$1:$2" in
  show-preset:x-timeline|show-preset:x-article) exit 0 ;;
  fetch-links:--help) printf '%s\\n' 'Options: --since-id ID'; exit 0 ;;
  *) exit 1 ;;
esac`);
    const status = await probeXReadiness({ binary });
    expect(status.ready).toBeTrue();
    expect(status.agentscrape).toBe(binary);
    expect(status.presets).toEqual({ "x-timeline": true, "x-article": true });
    expect(status.timeline_flags).toBeTrue();
    expect(new Date(status.checked_at).toString()).not.toBe("Invalid Date");
    expect(xReadinessStatusExitCode(status)).toBe(0);
  });

  test("reports present-but-not-ready without turning probe output into readiness", async () => {
    const binary = fake(`case "$1:$2" in
  show-preset:x-timeline) printf 'present'; exit 0 ;;
  show-preset:x-article) exit 1 ;;
  fetch-links:--help) printf '%s\\n' 'Options: --limit N'; exit 0 ;;
  *) exit 1 ;;
esac`);
    const status = await probeXReadiness({ binary });
    expect(status.ready).toBeFalse();
    expect(status.presets["x-timeline"]).toBeTrue();
    expect(status.presets["x-article"]).toBeFalse();
    expect(status.timeline_flags).toBeFalse();
    expect(xReadinessStatusExitCode(status)).toBe(1);
  });

  test("once mode emits one JSON status and empty stderr for exits 0, 1, and 2", async () => {
    const ready = fake(`case "$1:$2" in
  show-preset:x-timeline|show-preset:x-article) exit 0 ;;
  fetch-links:--help) printf '%s\\n' 'Options: --since-id ID'; exit 0 ;;
  *) exit 1 ;;
esac`);
    const unhealthy = fake(`case "$1:$2" in
  show-preset:x-timeline) exit 0 ;;
  show-preset:x-article|fetch-links:--help) exit 1 ;;
  *) exit 1 ;;
esac`);
    const missing = mkdtempSync(join(tmpdir(), "agentscrape-readiness-path-"));
    temporary.push(missing);

    const cases: Array<{
      path: string;
      expectedCode: 0 | 1 | 2;
      expectedReady: boolean;
      expectedBinary: string | null;
    }> = [
      { path: dirname(ready), expectedCode: 0, expectedReady: true, expectedBinary: ready },
      {
        path: dirname(unhealthy),
        expectedCode: 1,
        expectedReady: false,
        expectedBinary: unhealthy,
      },
      { path: missing, expectedCode: 2, expectedReady: false, expectedBinary: null },
    ];
    for (const value of cases) {
      const result = await once(value.path);
      expect(result.code).toBe(value.expectedCode);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      const status = JSON.parse(result.stdout);
      expect(status.ready).toBe(value.expectedReady);
      expect(status.agentscrape).toBe(value.expectedBinary);
      expect(xReadinessStatusExitCode(status)).toBe(value.expectedCode);
      if (value.expectedCode === 2) expect(status.error).toBe("agentscrape not on PATH");
      else expect(status.error).toBeUndefined();
    }
  }, 50_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeXReadiness } from "../scripts/check-x-readiness";

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
  });

  test("once mode preserves JSON and the 2-missing contract", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentscrape-readiness-path-"));
    temporary.push(directory);
    const child = Bun.spawn([process.execPath, "scripts/check-x-readiness.ts", "--once"], {
      cwd: root,
      env: { ...process.env, PATH: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stderr).toBe("");
    const status = JSON.parse(stdout);
    expect(status.ready).toBeFalse();
    expect(status.agentscrape).toBeNull();
    expect(status.error).toBe("agentscrape not on PATH");
  });
});

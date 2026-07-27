import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
}

interface CheckJob {
  "runs-on": string;
  "timeout-minutes": number;
  strategy: {
    "fail-fast": boolean;
    matrix: { os: string[] };
  };
  steps: WorkflowStep[];
}

interface CiWorkflow {
  on: {
    push: { branches: string[] };
    pull_request: unknown;
    workflow_dispatch: unknown;
  };
  permissions: { contents: string };
  jobs: { check: CheckJob };
}

function loadWorkflow(): CiWorkflow {
  return parseYaml(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as CiWorkflow;
}

function commandLines(steps: WorkflowStep[]): string[] {
  return steps.flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentscrape-ci-"));
  temporary.push(directory);
  return directory;
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 50_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hermetic package checks", () => {
  test("the package-facing check sanitizes hostile state before every phase", async () => {
    const poisonHome = temporaryDirectory();
    const missingBunPreload = join(poisonHome, "missing-bun-preload.ts");
    const missingNodePreload = join(poisonHome, "missing-node-preload.cjs");
    const bunOptions = `--preload=${missingBunPreload}`;
    const nodeOptions = `--require=${missingNodePreload}`;

    const poisonedBun = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"], {
      cwd: root,
      env: { ...process.env, BUN_OPTIONS: bunOptions },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(poisonedBun.exitCode).not.toBe(0);

    const poisonedTypecheck = Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "--version"], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(poisonedTypecheck.exitCode).not.toBe(0);

    const result = await run(
      [process.execPath, "run", "check", "--", "test/fixtures/hermetic-env-probe.ts"],
      {
        ...process.env,
        HOME: poisonHome,
        HERMETIC_TEST_POISON_HOME: poisonHome,
        XDG_CONFIG_HOME: join(poisonHome, "poison-config"),
        XDG_DATA_HOME: join(poisonHome, "poison-data"),
        XDG_STATE_HOME: join(poisonHome, "poison-state"),
        XDG_FUTURE_POISON: "must-be-removed-dynamically",
        AGENTSCRAPE_DATA_HOME: join(poisonHome, "poison-agentscrape-data"),
        AGENTSCRAPE_AGENTBUILDS_ROOT: join(poisonHome, "poison-agentbuilds"),
        AGENTSCRAPE_FUTURE_POISON: "must-be-removed-dynamically",
        NODE_OPTIONS: nodeOptions,
        BUN_OPTIONS: bunOptions,
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `package-facing hermetic check exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(`${result.stdout}\n${result.stderr}`).toContain("hermetic-env-probe.ts");
  }, 55_000);

  test("package scripts route check and test through the wrapper", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.check).toBe("bash scripts/check-hermetic.sh check");
    expect(packageJson.scripts.test).toBe("bash scripts/check-hermetic.sh test");
  });
});

describe("CI workflow contract", () => {
  test("runs the exact bounded OS matrix with pinned tools and project checks", () => {
    const workflow = loadWorkflow();
    const job = workflow.jobs.check;

    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["check"]);
    expect(job["runs-on"]).toMatch(/^\$\{\{\s*matrix\.os\s*\}\}$/);
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["ubuntu-24.04", "macos-26"] },
    });

    const actionSteps = job.steps.filter((step) => step.uses !== undefined);
    expect(actionSteps.map((step) => step.uses)).toEqual([
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76",
    ]);
    for (const step of actionSteps) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(actionSteps[1]?.with).toEqual({ "bun-version": "1.3.14" });

    const lines = commandLines(job.steps);
    expect(lines).toContain("bun install --frozen-lockfile");
    expect(lines).toContain("bun run check");
  });

  test("requires portable shell, plist, whitespace, and clean-worktree gates", () => {
    const workflow = loadWorkflow();
    const steps = workflow.jobs.check.steps;
    const lines = commandLines(steps);

    expect(lines).toContain("bash -n scripts/check-hermetic.sh scripts/install.sh");
    expect(lines).toContain(
      "AGENTSCRAPE_INSTALL_LAUNCHCTL=none bash scripts/install.sh --help >/dev/null",
    );
    expect(lines).toContain(
      "shellcheck --severity=error scripts/check-hermetic.sh scripts/install.sh",
    );

    const shellValidation = steps.find((step) => step.name === "Validate shell scripts")?.run ?? "";
    expect(shellValidation).toContain("if command -v shellcheck >/dev/null 2>&1; then");
    expect(shellValidation).toContain('[[ "$RUNNER_OS" == "Linux" ]]');
    expect(shellValidation).toContain("exit 1");
    expect(shellValidation).toContain("macOS runner; continuing");

    const portablePlist = steps.find((step) => step.name === "Validate plist with Python");
    expect(portablePlist?.if).toBeUndefined();
    expect(portablePlist?.run).toContain("import plistlib");
    expect(portablePlist?.run).toContain("plistlib.load(stream)");

    const macPlist = steps.find((step) => step.name === "Lint plist with macOS plutil");
    expect(macPlist?.if).toBe("runner.os == 'macOS'");
    expect(macPlist?.run).toContain("if command -v plutil >/dev/null 2>&1; then");
    expect(lines).toContain("plutil -lint plist/agentscrape.process-queue.plist");

    expect(lines).toContain("git diff --check");
    expect(lines).toContain("git diff --exit-code");
    expect(lines).toContain("git diff --cached --exit-code");
    expect(lines).toContain('status="$(git status --porcelain --untracked-files=all)"');
    expect(lines).toContain('[[ -z "$status" ]]');
  });
});

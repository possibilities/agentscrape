import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "..");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | number>;
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

describe("hermetic package checks", () => {
  test("package scripts route check, static, test, and coverage through the wrapper", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.check).toBe("bash scripts/check-hermetic.sh check");
    expect(packageJson.scripts.static).toBe("bash scripts/check-hermetic.sh static");
    expect(packageJson.scripts.test).toBe("bash scripts/check-hermetic.sh test");
    expect(packageJson.scripts.coverage).toBe("bash scripts/check-hermetic.sh coverage");
  });

  test("coverage config and wrapper keep the exact aggregate gate contract", () => {
    const bunfigSource = readFileSync(join(root, "bunfig.toml"), "utf8");
    expect(bunfigSource).toBe("[test]\ncoverageSkipTestFiles = true\n");
    expect(Bun.TOML.parse(bunfigSource)).toEqual({
      test: { coverageSkipTestFiles: true },
    });

    const wrapper = readFileSync(join(root, "scripts/check-hermetic.sh"), "utf8");
    expect(wrapper).toContain("<check|static|test|coverage>");
    expect(wrapper).toContain("check | static | test | coverage)");
    expect(wrapper).toContain("local test_command=(bun test --parallel=1 --timeout 60000)");
    expect(
      wrapper
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("--coverage")),
    ).toEqual([
      "--coverage",
      "--coverage-reporter=text",
      "--coverage-reporter=lcov",
      "--coverage-dir=coverage",
    ]);
    expect(wrapper).toContain('if [[ "$mode" == "coverage" ]]');
    expect(
      wrapper
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("check-coverage.ts")),
    ).toEqual(["bun scripts/check-coverage.ts coverage/lcov.info 0.70"]);
    expect(wrapper).toContain(
      "coverage)\n    run_tests\n    bun scripts/check-coverage.ts coverage/lcov.info 0.70",
    );
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
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    for (const step of actionSteps) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    // CI proves the floor holds against current Bun, not against one pinned release.
    expect(actionSteps[1]?.with).toEqual({ "bun-version": "latest" });

    const lines = commandLines(job.steps);
    expect(lines).toContain("bun install --frozen-lockfile");
    // Linux gets the same tests from the coverage gate, so it runs the static
    // half here; every other runner still runs the whole check.
    const projectChecks = job.steps.find((step) => step.name === "Run project checks")?.run ?? "";
    expect(projectChecks).toContain("runner.os == 'Linux'");
    expect(projectChecks).toContain("bun run static");
    expect(projectChecks).toContain("bun run check");
  });

  test("runs the Linux-only coverage gate before the pinned LCOV upload", () => {
    const steps = loadWorkflow().jobs.check.steps;
    const projectChecksIndex = steps.findIndex((step) => step.name === "Run project checks");
    const coverageIndex = steps.findIndex((step) => step.name === "Run coverage gate");
    const uploadIndex = steps.findIndex((step) => step.name === "Upload coverage LCOV");
    const coverage = steps[coverageIndex];
    const upload = steps[uploadIndex];

    expect(coverageIndex).toBe(projectChecksIndex + 1);
    expect(uploadIndex).toBe(coverageIndex + 1);
    expect(coverage?.if).toBe("runner.os == 'Linux'");
    expect(coverage?.run).toBe("bun run coverage");
    expect(upload?.if).toBe("runner.os == 'Linux' && success()");
    expect(upload?.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(upload?.with).toEqual({
      name: "coverage-lcov-ubuntu-24.04",
      path: "coverage/lcov.info",
      "retention-days": 7,
      "if-no-files-found": "error",
    });
  });

  test("requires portable shell, whitespace, and clean-worktree gates", () => {
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

    // The process-queue plist moved to AgentStart, which owns every fleet launch
    // agent. Nothing here renders a plist, so nothing here validates one.
    expect(steps.some((step) => step.name?.includes("plist"))).toBe(false);

    expect(lines).toContain("git diff --check");
    expect(lines).toContain("git diff --exit-code");
    expect(lines).toContain("git diff --cached --exit-code");
    expect(lines).toContain('status="$(git status --porcelain --untracked-files=all)"');
    expect(lines).toContain('[[ -z "$status" ]]');
  });
});

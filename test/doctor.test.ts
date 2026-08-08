import { describe, expect, test } from "bun:test";
import packageManifest from "../package.json" with { type: "json" };
import { findAgentBrowserExecutable } from "../src/browser";
import {
  buildDoctorReport,
  detectDoctorSource,
  doctorExitCode,
  renderDoctorHuman,
  renderDoctorJson,
  renderDoctorReport,
} from "../src/doctor";
import {
  AGENTSCRAPE_VERSION,
  BUN_ENGINE_RANGE,
  MINIMUM_BUN_VERSION,
  satisfiesMinimumBunVersion,
} from "../src/version";

const sourceRoot = "/work/agentscrape";
const missing = () => null;

describe("offline doctor report", () => {
  test("uses the validated package version and Bun engine authorities", () => {
    expect(AGENTSCRAPE_VERSION).toBe(packageManifest.version);
    expect(BUN_ENGINE_RANGE).toBe(packageManifest.engines.bun);
    expect(BUN_ENGINE_RANGE).toBe(`>=${MINIMUM_BUN_VERSION}`);
  });

  test("emits the exact stable shape and capability order without extra lookups", () => {
    const executableLookups: string[] = [];
    let browserLookups = 0;
    const report = buildDoctorReport({
      bunVersion: MINIMUM_BUN_VERSION,
      sourceRoot,
      findAgentBrowserExecutable() {
        browserLookups += 1;
        return "/tools/agent-browser";
      },
      findExecutable(executable) {
        executableLookups.push(executable);
        return executable === "gh" || executable === "agentbrain" ? `/tools/${executable}` : null;
      },
    });

    expect(report).toEqual({
      schema_version: 1,
      status: "pass",
      version: AGENTSCRAPE_VERSION,
      source: { kind: "source", sha: null },
      runtime: {
        name: "bun",
        expected: BUN_ENGINE_RANGE,
        actual: MINIMUM_BUN_VERSION,
        status: "pass",
      },
      capabilities: [
        { feature: "browser", executable: "agent-browser", available: true },
        { feature: "github", executable: "gh", available: true },
        { feature: "github-rst", executable: "pandoc", available: false },
        { feature: "queue-summary", executable: "summaryctl", available: false },
        { feature: "reconciliation", executable: "agentbrain", available: true },
      ],
    });
    expect(browserLookups).toBe(1);
    expect(executableLookups).toEqual(["gh", "pandoc", "summaryctl", "agentbrain"]);
    expect(doctorExitCode(report)).toBe(0);
  });

  test("fails only below the Bun floor while optional absence remains nonfatal", () => {
    const [major = 0, minor = 0, patch = 0] = MINIMUM_BUN_VERSION.split(".").map(Number);
    for (const version of [
      MINIMUM_BUN_VERSION,
      `${major}.${minor}.${patch + 1}`,
      `${major}.${minor + 1}.0`,
      `${major + 1}.0.0`,
      `${MINIMUM_BUN_VERSION}-canary.1`,
    ]) {
      const compatible = buildDoctorReport({
        bunVersion: version,
        sourceRoot,
        findAgentBrowserExecutable: missing,
        findExecutable: missing,
      });
      expect(compatible.status, version).toBe("pass");
      expect(compatible.capabilities.every(({ available }) => !available)).toBeTrue();
      expect(doctorExitCode(compatible)).toBe(0);
    }

    // An unparseable version is below the floor, not above it.
    for (const version of [`${major}.${minor}.${patch - 1}`, "0.9.9", "not-a-version", ""])
      expect(satisfiesMinimumBunVersion(version), version).toBeFalse();

    const incompatible = buildDoctorReport({
      bunVersion: "1.0.0",
      sourceRoot,
      findAgentBrowserExecutable: () => "/tools/agent-browser",
      findExecutable: (name) => `/tools/${name}`,
    });
    expect(incompatible).toMatchObject({
      status: "fail",
      runtime: {
        name: "bun",
        expected: BUN_ENGINE_RANGE,
        actual: "1.0.0",
        status: "incompatible",
      },
    });
    expect(incompatible.capabilities.every(({ available }) => available)).toBeTrue();
    expect(doctorExitCode(incompatible)).toBe(1);
  });

  test("classifies only normalized runtime SHA roots as managed snapshots", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(detectDoctorSource(`/state/agentscrape/runtime/${sha}/../${sha}/`)).toEqual({
      kind: "managed_snapshot",
      sha,
    });
    for (const root of [
      `/state/agentscrape/runtime/${sha.toUpperCase()}`,
      `/state/agentscrape/other/${sha}`,
      `/state/agentscrape/runtime/${sha}/src`,
      `/state/agentscrape/runtime/${sha.slice(1)}`,
      sourceRoot,
    ])
      expect(detectDoctorSource(root), root).toEqual({ kind: "source", sha: null });
  });

  test("treats an invalid explicit browser override as unavailable without fallback", () => {
    const configured = "/configured/missing-agent-browser";
    const lookups: string[] = [];
    const browser = findAgentBrowserExecutable("/managed/home", configured, (name) => {
      lookups.push(name);
      return null;
    });
    expect(browser).toBeNull();
    expect(lookups).toEqual([configured]);

    const report = buildDoctorReport({
      bunVersion: MINIMUM_BUN_VERSION,
      sourceRoot,
      findAgentBrowserExecutable: () => browser,
      findExecutable: missing,
    });
    expect(report.capabilities[0]).toEqual({
      feature: "browser",
      executable: "agent-browser",
      available: false,
    });
    expect(report.status).toBe("pass");
  });

  test("renders deterministic human and JSON output without resolved paths", () => {
    const report = buildDoctorReport({
      bunVersion: MINIMUM_BUN_VERSION,
      sourceRoot,
      findAgentBrowserExecutable: () => "/private/bin/agent-browser",
      findExecutable: (name) => (name === "gh" ? `/private/bin/${name}` : null),
    });
    const human = [
      "agentscrape doctor",
      "status: pass",
      `version: ${AGENTSCRAPE_VERSION}`,
      "source: source",
      `runtime: bun actual=${MINIMUM_BUN_VERSION} expected=${BUN_ENGINE_RANGE} status=pass`,
      "capabilities:",
      "  browser: agent-browser available",
      "  github: gh available",
      "  github-rst: pandoc missing",
      "  queue-summary: summaryctl missing",
      "  reconciliation: agentbrain missing",
    ].join("\n");
    expect(renderDoctorHuman(report)).toBe(human);
    expect(renderDoctorHuman(report)).toBe(renderDoctorReport(report, "human"));
    expect(renderDoctorJson(report)).toBe(JSON.stringify(report, null, 2));
    expect(renderDoctorJson(report)).toBe(renderDoctorReport(report, "json"));
    expect(renderDoctorHuman(report)).not.toContain("/private/bin");
    expect(renderDoctorJson(report)).not.toContain("/private/bin");
  });
});

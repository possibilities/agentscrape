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
import { AGENTSCRAPE_VERSION, REQUIRED_BUN_VERSION } from "../src/version";

const sourceRoot = "/work/agentscrape";
const missing = () => null;

describe("offline doctor report", () => {
  test("uses the validated package version and Bun engine authorities", () => {
    expect(AGENTSCRAPE_VERSION).toBe(packageManifest.version);
    expect(REQUIRED_BUN_VERSION).toBe(packageManifest.engines.bun);
  });

  test("emits the exact stable shape and capability order without extra lookups", () => {
    const executableLookups: string[] = [];
    let browserLookups = 0;
    const report = buildDoctorReport({
      bunVersion: REQUIRED_BUN_VERSION,
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
        expected: REQUIRED_BUN_VERSION,
        actual: REQUIRED_BUN_VERSION,
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

  test("fails only an exact Bun mismatch while optional absence remains nonfatal", () => {
    const compatible = buildDoctorReport({
      bunVersion: REQUIRED_BUN_VERSION,
      sourceRoot,
      findAgentBrowserExecutable: missing,
      findExecutable: missing,
    });
    expect(compatible.status).toBe("pass");
    expect(compatible.capabilities.every(({ available }) => !available)).toBeTrue();
    expect(doctorExitCode(compatible)).toBe(0);

    const incompatible = buildDoctorReport({
      bunVersion: `${REQUIRED_BUN_VERSION}-different`,
      sourceRoot,
      findAgentBrowserExecutable: () => "/tools/agent-browser",
      findExecutable: (name) => `/tools/${name}`,
    });
    expect(incompatible).toMatchObject({
      status: "fail",
      runtime: {
        name: "bun",
        expected: REQUIRED_BUN_VERSION,
        actual: `${REQUIRED_BUN_VERSION}-different`,
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
      bunVersion: REQUIRED_BUN_VERSION,
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
      bunVersion: REQUIRED_BUN_VERSION,
      sourceRoot,
      findAgentBrowserExecutable: () => "/private/bin/agent-browser",
      findExecutable: (name) => (name === "gh" ? `/private/bin/${name}` : null),
    });
    const human = [
      "agentscrape doctor",
      "status: pass",
      `version: ${AGENTSCRAPE_VERSION}`,
      "source: source",
      `runtime: bun actual=${REQUIRED_BUN_VERSION} expected=${REQUIRED_BUN_VERSION} status=pass`,
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

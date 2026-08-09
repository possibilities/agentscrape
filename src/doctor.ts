import { basename, dirname, join, normalize } from "node:path";
import { findAgentBrowserExecutable } from "./browser";
import { findExecutable } from "./subprocess";
import { AGENTSCRAPE_VERSION, BUN_ENGINE_RANGE, satisfiesMinimumBunVersion } from "./version";

export interface DoctorSourceIdentity {
  kind: "managed_snapshot" | "source";
  sha: string | null;
}

export interface DoctorRuntime {
  name: "bun";
  expected: string;
  actual: string;
  status: "pass" | "incompatible";
}

export interface DoctorCapability {
  feature: "browser" | "github" | "github-rst" | "queue-summary";
  executable: "agent-browser" | "gh" | "pandoc" | "summaryctl";
  available: boolean;
}

export interface DoctorReport {
  schema_version: 1;
  status: "pass" | "fail";
  version: string;
  source: DoctorSourceIdentity;
  runtime: DoctorRuntime;
  capabilities: DoctorCapability[];
}

export interface DoctorReportInputs {
  bunVersion: string;
  findExecutable: (executable: string) => string | null;
  findAgentBrowserExecutable: () => string | null;
  sourceRoot: string;
}

const CAPABILITIES = [
  ["browser", "agent-browser"],
  ["github", "gh"],
  ["github-rst", "pandoc"],
  ["queue-summary", "summaryctl"],
] as const satisfies ReadonlyArray<
  readonly [DoctorCapability["feature"], DoctorCapability["executable"]]
>;

/** Classify only the normalized path shape; this does not verify deployment evidence. */
export function detectDoctorSource(sourceRoot: string): DoctorSourceIdentity {
  const root = normalize(sourceRoot);
  const sha = basename(root);
  if (basename(dirname(root)) === "runtime" && /^[0-9a-f]{40}$/.test(sha))
    return { kind: "managed_snapshot", sha };
  return { kind: "source", sha: null };
}

/** Build a deterministic report using only injected, side-effect-free observations. */
export function buildDoctorReport(inputs: DoctorReportInputs): DoctorReport {
  const runtimeStatus = satisfiesMinimumBunVersion(inputs.bunVersion) ? "pass" : "incompatible";
  const capabilities = CAPABILITIES.map(
    ([feature, executable]): DoctorCapability => ({
      feature,
      executable,
      available:
        feature === "browser"
          ? inputs.findAgentBrowserExecutable() !== null
          : inputs.findExecutable(executable) !== null,
    }),
  );
  return {
    schema_version: 1,
    status: runtimeStatus === "pass" ? "pass" : "fail",
    version: AGENTSCRAPE_VERSION,
    source: detectDoctorSource(inputs.sourceRoot),
    runtime: {
      name: "bun",
      expected: BUN_ENGINE_RANGE,
      actual: inputs.bunVersion,
      status: runtimeStatus,
    },
    capabilities,
  };
}

/** Inspect the current process without executing commands or contacting external systems. */
export function currentDoctorReport(): DoctorReport {
  return buildDoctorReport({
    bunVersion: Bun.version,
    findExecutable,
    findAgentBrowserExecutable,
    sourceRoot: join(import.meta.dir, ".."),
  });
}

export function renderDoctorHuman(report: DoctorReport): string {
  const source =
    report.source.kind === "managed_snapshot"
      ? `managed_snapshot sha=${report.source.sha}`
      : "source";
  return [
    "agentscrape doctor",
    `status: ${report.status}`,
    `version: ${report.version}`,
    `source: ${source}`,
    `runtime: ${report.runtime.name} actual=${report.runtime.actual} expected=${report.runtime.expected} status=${report.runtime.status}`,
    "capabilities:",
    ...report.capabilities.map(
      (capability) =>
        `  ${capability.feature}: ${capability.executable} ${capability.available ? "available" : "missing"}`,
    ),
  ].join("\n");
}

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderDoctorReport(report: DoctorReport, format: "human" | "json"): string {
  return format === "json" ? renderDoctorJson(report) : renderDoctorHuman(report);
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.runtime.status === "pass" ? 0 : 1;
}

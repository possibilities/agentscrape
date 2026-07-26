import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  closeSessionBestEffort,
  currentBrowserNetworkPolicy,
  withBrowserNetworkPolicy,
} from "./browser";
import { classifyFailure } from "./envelope";
import { AgentscrapeNetworkPolicyError, cancellationError, throwIfAborted } from "./errors";
import { loadRegistry, scrapeWithPreset, validateContentResult } from "./presets";
import { redactDiagnostic } from "./redaction";
import type { ScrapeSchema } from "./schemas";

interface Canary {
  url?: string;
  invariants?: {
    min_markdown_chars?: number;
    require_title?: boolean;
    min_rounds?: number;
    min_citations?: number;
  };
}
export interface CanaryResult {
  preset: string;
  status: "pass" | "drift" | "operational_failure" | "not_configured";
  detail: string;
}
export interface CanaryEnvelope {
  checked_at: string;
  results: CanaryResult[];
}
export function checkInvariants(
  invariants: Canary["invariants"],
  structured: ScrapeSchema,
  markdown: string,
): string[] {
  const values = invariants ?? {};
  const record = structured as unknown as Record<string, unknown>;
  const violations: string[] = [];
  if (values.min_markdown_chars !== undefined && markdown.length < values.min_markdown_chars)
    violations.push(
      `markdown length ${markdown.length} is below minimum ${values.min_markdown_chars}`,
    );
  if (values.require_title && !(typeof record.title === "string" && record.title.trim()))
    violations.push("structured.title is empty");
  for (const [key, minimum] of [
    ["rounds", values.min_rounds],
    ["citations", values.min_citations],
  ] as const) {
    if (minimum !== undefined) {
      const count = Array.isArray(record[key]) ? record[key].length : 0;
      if (count < minimum) violations.push(`${key} count ${count} is below minimum ${minimum}`);
    }
  }
  return violations;
}
export async function checkPresets(
  options: {
    presets?: string[];
    canaryPath?: string;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean | undefined;
  } = {},
): Promise<CanaryEnvelope> {
  return withBrowserNetworkPolicy(options.allowPrivateNetwork, async () => {
    const path = options.canaryPath ?? join(import.meta.dir, "../config/preset-canaries.yaml");
    const parsed = parseYaml(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("preset-canaries.yaml must be a mapping of preset name to config");
    const canaries = parsed as Record<string, Canary>;
    const names = options.presets?.length ? options.presets : Object.keys(canaries).sort();
    const registry = loadRegistry();
    const results: CanaryResult[] = [];
    for (const name of names) {
      throwIfAborted(options.signal);
      const canary = canaries[name];
      const preset = registry.byName(name);
      if (!canary) {
        results.push({ preset: name, status: "not_configured", detail: "no canary configured" });
        continue;
      }
      if (!preset) {
        results.push({
          preset: name,
          status: "not_configured",
          detail: "preset not found in registry",
        });
        continue;
      }
      if (!canary.url) {
        results.push({
          preset: name,
          status: "not_configured",
          detail: "no canary url configured",
        });
        continue;
      }
      const session = `agentscrape-canary-${process.pid}-${name}`;
      try {
        const result = await scrapeWithPreset(canary.url, preset, {
          session,
          signal: options.signal,
        });
        if (preset.mode === "content") validateContentResult(result, preset);
        const violations = checkInvariants(canary.invariants, result.structured, result.markdown);
        results.push(
          violations.length
            ? { preset: name, status: "drift", detail: redactDiagnostic(violations.join("; ")) }
            : { preset: name, status: "pass", detail: "" },
        );
      } catch (error) {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        if (error instanceof AgentscrapeNetworkPolicyError) throw error;
        const [failureClass, _retryable, evidence] = classifyFailure(error);
        const status = [
          "malformed_provider_output",
          "empty_content",
          "output_limit_exceeded",
        ].includes(failureClass)
          ? "drift"
          : "operational_failure";
        results.push({
          preset: name,
          status,
          detail: `${failureClass}: ${redactDiagnostic(evidence)}`,
        });
      } finally {
        if (currentBrowserNetworkPolicy()) await closeSessionBestEffort(session);
      }
    }
    return { checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"), results };
  });
}

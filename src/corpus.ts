import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { preflightTextArtifacts, writePreparedTextArtifacts } from "./artifacts";
import {
  closeSessionBestEffort,
  currentBrowserNetworkPolicy,
  runAgentBrowser,
  withBrowserNetworkPolicy,
} from "./browser";
import {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeNetworkPolicyError,
  AgentscrapeRuntimeError,
  AgentscrapeUpstreamDownError,
  AgentscrapeValueError,
  cancellationError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  throwIfAborted,
} from "./errors";
import type { ScrapeResult } from "./handlers/types";
import { offlineExtractLinks } from "./links";
import { loadRegistry, matchPreset, type PresetConfig, scrapeWithPreset } from "./presets";
import { redactDiagnostic, redactUrl } from "./redaction";
import { type LinkItem, LinkList } from "./schemas";

export const CORPUS_VERSION = 1;
export const CORPUS_ARTIFACT_MAX_BYTES = 8_000_000;
export const CORPUS_AGGREGATE_MAX_BYTES = 24_000_000;
const ROOT = join(import.meta.dir, "../test/corpus");
const FAILURE_TYPES: Record<string, abstract new (...args: never[]) => Error> = {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeUpstreamDownError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  Error,
  TypeError,
  RangeError,
  ValueError: AgentscrapeValueError,
  RuntimeError: AgentscrapeRuntimeError,
};
class CorpusError extends Error {}
interface Meta {
  version: number;
  preset: string;
  mode: "content" | "links" | "nav-links";
  url: string;
  expect: "success" | "failure";
  structured?: unknown;
  links?: LinkItem[];
  failure?: { type?: string; contains?: string; message_captured?: string };
  assertions?: { contains?: string[]; not_contains?: string[] };
  category_pages?: Array<{ section_url: string; page: string }>;
}
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
function loadMeta(directory: string): Meta {
  const path = join(directory, "meta.yaml");
  if (!existsSync(path)) throw new CorpusError("missing meta.yaml");
  let value: unknown;
  try {
    value = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CorpusError(`malformed meta.yaml: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CorpusError("meta.yaml must be a mapping");
  const data = value as Record<string, unknown>;
  if (data.version !== CORPUS_VERSION)
    throw new CorpusError(
      `unsupported sample contract version ${String(data.version)} (expected ${CORPUS_VERSION})`,
    );
  for (const field of ["preset", "mode", "url", "expect"])
    if (!(field in data)) throw new CorpusError(`meta.yaml missing required field: ${field}`);
  if (!["content", "links", "nav-links"].includes(data.mode as string))
    throw new CorpusError(`meta.yaml has unsupported mode: '${String(data.mode)}'`);
  if (!["success", "failure"].includes(data.expect as string))
    throw new CorpusError(
      `meta.yaml 'expect' must be 'success' or 'failure', got '${String(data.expect)}'`,
    );
  return data as unknown as Meta;
}
function rootHtml(directory: string): string {
  const selected = join(directory, "selected.html");
  if (existsSync(selected) && readFileSync(selected, "utf8").trim())
    return readFileSync(selected, "utf8");
  const page = join(directory, "page.html");
  if (existsSync(page)) return readFileSync(page, "utf8");
  throw new CorpusError("no page.html or selected.html input found");
}
function verifyFailure(meta: Meta, error: unknown): void {
  if (!meta.failure?.type) throw new CorpusError("expect: failure requires a 'failure.type' field");
  const expected = FAILURE_TYPES[meta.failure.type];
  if (!expected) throw new CorpusError(`unknown failure type in meta.yaml: '${meta.failure.type}'`);
  const value = error instanceof Error ? error : new Error(String(error));
  const matches = (candidate: Error, expectedType: abstract new (...args: never[]) => Error) =>
    candidate instanceof expectedType;
  if (!matches(value, expected))
    throw new CorpusError(
      `expected failure type ${meta.failure.type}, got ${value.constructor.name}: ${value.message}`,
    );
  if (meta.failure.type === "PresetDriftError" && !(value instanceof PresetDriftError))
    throw new CorpusError(
      `expected failure type PresetDriftError, got ${value.constructor.name}: ${value.message}`,
    );
  if (meta.failure.contains && !value.message.includes(meta.failure.contains))
    throw new CorpusError(
      `failure message missing expected substring '${meta.failure.contains}': ${value.message}`,
    );
}
function verifySuccess(directory: string, meta: Meta, markdown: string, payload: unknown): void {
  const expectedPath = join(directory, "expected.md");
  if (!existsSync(expectedPath)) throw new CorpusError("expect: success requires expected.md");
  if (markdown.trim() !== readFileSync(expectedPath, "utf8").trim())
    throw new CorpusError("markdown does not match expected.md");
  if (meta.mode === "content") {
    if ("structured" in meta && !isDeepStrictEqual(payload, meta.structured))
      throw new CorpusError("structured output does not match meta.yaml 'structured'");
  } else {
    if (!meta.links)
      throw new CorpusError(`expect: success (${meta.mode} mode) requires a 'links' field`);
    if (!isDeepStrictEqual(payload, meta.links))
      throw new CorpusError("extracted links do not match meta.yaml 'links'");
  }
  for (const needle of meta.assertions?.contains ?? [])
    if (!markdown.includes(needle))
      throw new CorpusError(`expected markdown to contain '${needle}'`);
  for (const needle of meta.assertions?.not_contains ?? [])
    if (markdown.includes(needle))
      throw new CorpusError(`expected markdown to NOT contain '${needle}'`);
}
async function replay(
  directory: string,
  meta: Meta,
  preset: PresetConfig,
): Promise<[string, unknown]> {
  if (meta.mode === "content") {
    const result = await scrapeWithPreset(meta.url, preset, { html: rootHtml(directory) });
    return [result.markdown, plain(result.structured)];
  }
  if (meta.mode === "links") {
    const section = new URL(meta.url).pathname.replace(/\/$/, "").split("/").pop() ?? "";
    const links = offlineExtractLinks(rootHtml(directory), preset.selector!, meta.url).map(
      (item) => ({ ...item, section }),
    );
    const structured = new LinkList(links);
    return [structured.toMarkdown(), links];
  }
  if (!meta.category_pages?.length)
    throw new CorpusError("nav-links mode requires 'category_pages' in meta.yaml");
  const pages = new Map(
    meta.category_pages.map((entry) => {
      const path = join(directory, entry.page);
      if (!existsSync(path)) throw new CorpusError(`missing category page fixture: ${entry.page}`);
      return [entry.section_url, path] as const;
    }),
  );
  const sections = offlineExtractLinks(rootHtml(directory), preset.section_selector!, meta.url);
  const links: LinkItem[] = [];
  for (const section of sections) {
    const page = pages.get(section.url);
    if (!page) continue;
    for (const item of offlineExtractLinks(
      readFileSync(page, "utf8"),
      preset.category_selector!,
      section.url,
    ))
      links.push({ ...item, section: section.title });
  }
  if (!links.length) throw new Error("nav-links replay produced no links");
  const structured = new LinkList(links);
  return [structured.toMarkdown(), links];
}
async function runSample(directory: string, meta: Meta, preset: PresetConfig): Promise<void> {
  if (meta.mode !== preset.mode)
    throw new CorpusError(
      `meta.yaml mode '${meta.mode}' does not match registry mode '${preset.mode}' for preset '${preset.name}'`,
    );
  try {
    const [markdown, payload] = await replay(directory, meta, preset);
    if (meta.expect === "failure")
      throw new CorpusError(`expected failure '${meta.failure?.type}' but replay succeeded`);
    verifySuccess(directory, meta, markdown, payload);
  } catch (error) {
    if (error instanceof CorpusError) throw error;
    if (meta.expect !== "failure")
      throw new CorpusError(
        `unexpected exception during replay: ${error instanceof Error ? error.message : String(error)}`,
      );
    verifyFailure(meta, error);
  }
}
export async function testCorpus(
  presetFilter?: string | null,
  root = ROOT,
): Promise<{ passed: number; failed: number; lines: string[] }> {
  if (!existsSync(root)) throw new CorpusError("No corpus directory found.");
  const registry = loadRegistry();
  let passed = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const presetName of readdirSync(root).sort()) {
    if (presetFilter && presetName !== presetFilter) continue;
    const presetDirectory = join(root, presetName);
    for (const sample of readdirSync(presetDirectory)
      .filter((name) => name.startsWith("sample-"))
      .sort()) {
      const label = `${presetName}/${sample}`;
      const directory = join(presetDirectory, sample);
      try {
        const meta = loadMeta(directory);
        const preset = registry.byName(meta.preset);
        if (!preset) throw new CorpusError(`preset '${meta.preset}' not found in registry`);
        if (preset.name !== presetName)
          throw new CorpusError(
            `meta.yaml preset '${meta.preset}' does not match directory preset '${presetName}'`,
          );
        await runSample(directory, meta, preset);
        passed += 1;
        lines.push(`  PASS: ${label}`);
      } catch (error) {
        failed += 1;
        lines.push(
          redactDiagnostic(
            `  FAIL: ${label}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }
  return { passed, failed, lines };
}
function nextSample(directory: string): string {
  const count = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith("sample-")).length
    : 0;
  return join(directory, `sample-${String(count + 1).padStart(3, "0")}`);
}
function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
export function atomicSample(directory: string, files: Record<string, string>): string {
  const entries = Object.entries(files);
  const prepared = preflightTextArtifacts(
    entries.map(([name, content]) => ({ path: name, content })),
    {
      perArtifactBytes: CORPUS_ARTIFACT_MAX_BYTES,
      aggregateBytes: CORPUS_AGGREGATE_MAX_BYTES,
    },
  );
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, ".capture-tmp-"));
  try {
    chmodSync(temporary, 0o700);
    writePreparedTextArtifacts(
      prepared.map((artifact) => ({
        path: join(temporary, artifact.path),
        bytes: artifact.bytes,
      })),
    );
    fsyncDirectory(temporary);
    const final = nextSample(directory);
    renameSync(temporary, final);
    fsyncDirectory(directory);
    return final;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
export async function captureCorpus(
  url: string,
  options: {
    preset?: string | null | undefined;
    expectFailure?: string | null | undefined;
    root?: string | undefined;
    signal?: AbortSignal | undefined;
    allowPrivateNetwork?: boolean | undefined;
  } = {},
): Promise<string> {
  return withBrowserNetworkPolicy(options.allowPrivateNetwork, async () => {
    if (options.expectFailure && !FAILURE_TYPES[options.expectFailure])
      throw new Error(
        `unknown --expect-failure type '${options.expectFailure}'. Known types: ${Object.keys(FAILURE_TYPES).sort().join(", ")}`,
      );
    const registry = loadRegistry();
    const preset = options.preset
      ? registry.byName(options.preset)
      : matchPreset(url, registry.presets);
    if (!preset)
      throw new Error(
        options.preset
          ? `preset '${options.preset}' not found`
          : "no matching preset found. Use --preset to specify one.",
      );
    if (preset.mode !== "content")
      throw new Error(
        `capture-corpus only supports content mode (preset '${preset.name}' is ${preset.mode})`,
      );
    const session = `agentscrape-capture-${process.pid}`;
    let result: ScrapeResult | undefined;
    let outcome: unknown = null;
    let rendered = "";
    try {
      throwIfAborted(options.signal);
      result = await scrapeWithPreset(url, preset, { session, signal: options.signal });
    } catch (error) {
      if (error instanceof AgentscrapeNetworkPolicyError) throw error;
      outcome = error;
    } finally {
      if (currentBrowserNetworkPolicy()) {
        try {
          const html = await runAgentBrowser(
            ["eval", "document.documentElement.outerHTML"],
            session,
            undefined,
            undefined,
            options.signal,
          );
          if (html.exitCode === 0 && !html.truncated) rendered = html.stdout;
        } catch {
          /* best effort */
        }
        await closeSessionBestEffort(session);
      }
    }
    if (options.signal?.aborted) throw cancellationError(options.signal);
    const directory = join(options.root ?? ROOT, preset.name);
    if (outcome) {
      if (!options.expectFailure) throw outcome;
      const meta: Meta = {
        version: 1,
        preset: preset.name,
        mode: preset.mode,
        url: redactUrl(url),
        expect: "failure",
        failure: {
          type: options.expectFailure,
          message_captured: redactDiagnostic(
            outcome instanceof Error ? outcome.message : String(outcome),
          ),
        },
      };
      verifyFailure(meta, outcome);
      return atomicSample(directory, {
        "meta.yaml": stringifyYaml(meta),
        ...(rendered ? { "page.html": rendered } : {}),
      });
    }
    if (options.expectFailure)
      throw new Error(`expected failure type '${options.expectFailure}' but the scrape succeeded`);
    if (!result) throw new Error("scrape returned no result");
    const meta: Meta = {
      version: 1,
      preset: preset.name,
      mode: preset.mode,
      url: redactUrl(url),
      expect: "success",
      structured: plain(result.structured),
    };
    return atomicSample(directory, {
      "meta.yaml": stringifyYaml(meta),
      ...(result.full_html ? { "page.html": result.full_html } : {}),
      ...(result.selected_html ? { "selected.html": result.selected_html } : {}),
      ...(result.markdown ? { "expected.md": result.markdown } : {}),
    });
  });
}
export { CorpusError, loadMeta, runSample };

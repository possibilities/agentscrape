#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  closeBrowserSession,
  envelopeExitCode,
  fetchLinks,
  fetchMarkdown,
  type ScrapeResult,
  structuredJson,
} from "./api";
import {
  type PreparedTextArtifact,
  prepareHtmlSidecars,
  writePreparedTextArtifacts,
} from "./artifacts";
import { requireAgentBrowserSuccess, runAgentBrowser, setMediaMode } from "./browser";
import { type CanaryResult, checkPresets } from "./canary";
import {
  CLI_SPEC,
  findCommandSpec,
  findVisibleCommandSpec,
  type ParsedArgs as Parsed,
  parseArgs,
  parseGlobalOption,
  renderAgentTeaser,
  renderHumanHelp,
  renderJsonHelp,
} from "./cli-spec";
import { renderAgentHelp, renderContractJson } from "./contract";
import { captureCorpus, testCorpus } from "./corpus";
import { currentDoctorReport, doctorExitCode, renderDoctorReport } from "./doctor";
import { AgentscrapeError, AgentscrapeUsageError, cancellationError } from "./errors";
import {
  type ArchiveOptions,
  discoverFeed,
  discoverFeedLive,
  type FeedOptions,
  type RecordedFeedInputFailureKind,
  type RecordedFeedPage,
  recordedFeedInputFailure,
} from "./feed";
import { convertHtml } from "./html";
import { convertHtmlDirectory, readRegularFileNoFollow } from "./html-files";
import { loadRegistry, validatePresetFile } from "./presets";
import { processQueue } from "./queue";
import { redactDiagnostic, sanitizeErrorInPlace } from "./redaction";
import type { ExtractionEnvelope } from "./schemas";

const SCHEMA_FIELDS: Record<string, string[]> = {
  ChatGPTConversation: ["turns: list[ConversationTurn] (required)"],
  DeepWikiSearchConversation: [
    "url: str (default='')",
    "repository: str (default='')",
    "rounds: list[DeepWikiQARound] (default_factory)",
  ],
  DeepWikiWikiPage: [
    "url: str (default='')",
    "repository: str (default='')",
    "title: str (default='')",
    "markdown: str (default='')",
    "citations: list[DeepWikiCitation] (default_factory)",
  ],
  TweetThread: [
    "author_name: str (required)",
    "author_handle: str (required)",
    "author_url: str (default='')",
    "tweets: list[TweetContent] (required)",
    "quoted_tweet: TweetContent | None (default=None)",
  ],
  XArticle: [
    "url: str (required)",
    "title: str (default='')",
    "author_handle: str (default='')",
    "published_at: str (default='')",
    "markdown: str (default='')",
    "links: list[str] (default_factory)",
    "warnings: list[ScrapeWarning] (default_factory)",
  ],
  XProfile: [
    "display_name: str (required)",
    "handle: str (required)",
    "bio: str (default='')",
    "header_text: str (default='')",
    "following_text: str (default='')",
    "followers_text: str (default='')",
    "pinned_tweet: str (default='')",
    "recent_posts: list[str] (default_factory)",
    "recent_posts_structured: list[TweetContent] (default_factory)",
    "latest_version: str (default='')",
    "latest_post_id: str (default='')",
  ],
  XTimeline: [
    "handle: str (required)",
    "next_cursor: str | None (default=None)",
    "scraped_at: str (default='')",
    "tweets: list[XTimelineTweet] (default_factory)",
    "warnings: list[ScrapeWarning] (default_factory)",
  ],
};

const one = (parsed: Parsed, name: string) => parsed.values.get(name)?.at(-1);
const all = (parsed: Parsed, name: string) => parsed.values.get(name) ?? [];
function numberOption(
  parsed: Parsed,
  name: string,
  fallback?: number,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const raw = one(parsed, name);
  if (raw === undefined) return fallback;
  if (options.integer && !/^[+-]?\d+$/.test(raw))
    throw new AgentscrapeUsageError(`${name} must be an integer`);
  if (!options.integer && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
    throw new AgentscrapeUsageError(`${name} must be a number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || (options.integer && !Number.isSafeInteger(value)))
    throw new AgentscrapeUsageError(
      `${name} must be ${options.integer ? "a safe integer" : "a finite number"}`,
    );
  if (options.min !== undefined && value < options.min)
    throw new AgentscrapeUsageError(`${name} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max)
    throw new AgentscrapeUsageError(`${name} must be at most ${options.max}`);
  return value;
}
function format(
  parsed: Parsed,
  fallback?: "json" | "yaml" | "markdown",
): "json" | "yaml" | "markdown" | "envelope" | undefined {
  const choices: Array<readonly [string, "json" | "yaml" | "markdown" | "envelope"]> = [
    ["--json", "json"],
    ["--yaml", "yaml"],
    ["--markdown", "markdown"],
    ["--envelope", "envelope"],
  ];
  const selected = choices.filter(([flag]) => parsed.flags.has(flag));
  if (selected.length > 1) throw new AgentscrapeUsageError("choose only one output format");
  return (selected[0]?.[1] as ReturnType<typeof format>) ?? fallback;
}
/**
 * Where a command's own output goes.
 *
 * A terminal run writes fd 1 and fd 2, which is what `null` means. An in-process
 * caller — `agentscrape mcp`, where fd 1 is the MCP protocol channel and a
 * stray byte on it corrupts the session — installs a sink instead, and every
 * print site below routes through `say`, `write`, and `note` so that no command
 * has its own way to reach stdout. Nothing outside this file prints.
 */
export interface OutputSink {
  /** stdout: the command's payload, verbatim, newlines included. */
  write(chunk: string): void;
  /** stderr: the asides — "Saved to …" — that are not the payload. */
  note(line: string): void;
}
let sink: OutputSink | null = null;
function write(value: string): void {
  if (sink) sink.write(value);
  else process.stdout.write(value);
}
/** `console.log`'s contract: the value, then a newline. */
function say(value: string): void {
  write(`${value}\n`);
}
function note(line: string): void {
  if (sink) sink.note(line);
  else console.error(line);
}
function output(value: string, destination?: string): void {
  if (destination) {
    writeFileSync(destination, value);
    note(`Saved to ${destination}`);
  } else write(value.endsWith("\n") ? value : `${value}\n`);
}
function resultOutput(result: ScrapeResult, selected: "json" | "yaml" | "markdown"): string {
  if (selected === "markdown") return result.markdown;
  const value = structuredJson(result);
  return selected === "json" ? JSON.stringify(value, null, 2) : stringifyYaml(value);
}
function commandHelp(parsed: Parsed, command: string): number | null {
  if (parsed.flags.has("--help-json")) {
    say(renderJsonHelp(command));
    return 0;
  }
  if (parsed.flags.has("--help")) {
    write(renderHumanHelp(command));
    return 0;
  }
  return null;
}
function writeHtmlArtifacts(artifacts: readonly PreparedTextArtifact[]): void {
  writePreparedTextArtifacts(artifacts);
  for (const artifact of artifacts) note(`Saved to ${artifact.path}`);
}
async function fetchMarkdownCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs("fetch-markdown", args);
  const helpCode = commandHelp(parsed, "fetch-markdown");
  if (helpCode !== null) return helpCode;
  const [url, destination] = parsed.positionals;
  if (!url || parsed.positionals.length > 2)
    throw new AgentscrapeUsageError("fetch-markdown requires URL and at most one DEST");
  const selected = format(parsed);
  const media = one(parsed, "--media")?.toLowerCase();
  if (media && !["light", "dark"].includes(media))
    throw new AgentscrapeUsageError("--media must be light or dark");
  const envelope = selected === "envelope";
  const retainArtifacts = parsed.flags.has("--retain-artifacts");
  // Intentionally withhold destination: the CLI owns format-aware persistence and only emits
  // HTML sidecars for actual Markdown output; retention still enables browser failure evidence.
  const result = await fetchMarkdown(url, {
    selector: one(parsed, "--selector"),
    media,
    session: one(parsed, "--session"),
    preset: one(parsed, "--preset"),
    generic: parsed.flags.has("--generic"),
    allowPrivateNetwork: parsed.flags.has("--allow-private-network") || undefined,
    envelope,
    retainArtifacts,
    maxContentBytes: numberOption(parsed, "--max-content-bytes", 1_000_000, {
      integer: true,
      min: 1,
    }),
    maxRelations: numberOption(parsed, "--max-relations", 256, { integer: true, min: 0 }),
    signal,
  });
  if (envelope) {
    const value = result as ExtractionEnvelope;
    output(JSON.stringify(value, null, 2), destination);
    return envelopeExitCode(value);
  }
  const scrape = result as ScrapeResult;
  const actual = selected ?? (scrape.links ? "yaml" : "markdown");
  const artifacts =
    destination && actual === "markdown" && retainArtifacts
      ? prepareHtmlSidecars(destination, scrape)
      : [];
  output(resultOutput(scrape, actual), destination);
  writeHtmlArtifacts(artifacts);
  return 0;
}
async function fetchLinksCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs("fetch-links", args);
  const helpCode = commandHelp(parsed, "fetch-links");
  if (helpCode !== null) return helpCode;
  const [url] = parsed.positionals;
  if (!url || parsed.positionals.length !== 1)
    throw new AgentscrapeUsageError("fetch-links requires exactly one URL");
  const media = one(parsed, "--media")?.toLowerCase();
  if (media && !["light", "dark"].includes(media))
    throw new AgentscrapeUsageError("--media must be light or dark");
  const selectedOutput = format(parsed, "yaml") as "json" | "yaml" | "markdown";
  const result = await fetchLinks(url, {
    preset: one(parsed, "--preset"),
    sectionSelector: one(parsed, "--section-selector"),
    categorySelector: one(parsed, "--category-selector"),
    toggleSelector: one(parsed, "--toggle-selector"),
    limit: numberOption(parsed, "--limit", undefined, { integer: true, min: 1 }),
    maxScrolls: numberOption(parsed, "--max-scrolls", undefined, { integer: true, min: 1 }),
    sinceId: one(parsed, "--since-id"),
    includeReplies: parsed.flags.has("--include-replies") || undefined,
    includeReposts: parsed.flags.has("--include-reposts") || undefined,
    media,
    session: one(parsed, "--session"),
    allowPrivateNetwork: parsed.flags.has("--allow-private-network") || undefined,
    signal,
  });
  output(resultOutput(result, selectedOutput));
  return 0;
}
type RecordedReadResult =
  | { ok: true; content: string }
  | { ok: false; kind: RecordedFeedInputFailureKind };
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function readBounded(path: string, max: number): RecordedReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, kind: "read" };
  }
  if (bytes.byteLength > max) return { ok: false, kind: "response_limit" };
  try {
    return { ok: true, content: fatalUtf8Decoder.decode(bytes) };
  } catch {
    return { ok: false, kind: "invalid_utf8" };
  }
}
async function discoverFeedCommand(
  args: string[],
  signal?: AbortSignal,
  globalFormat?: string,
): Promise<number> {
  const parsed = parseArgs("discover-feed", args);
  const helpCode = commandHelp(parsed, "discover-feed");
  if (helpCode !== null) return helpCode;
  const [file] = parsed.positionals;
  const recordedMode = parsed.positionals.length === 1;
  const sourceUrl = one(parsed, "--source-url");
  if (parsed.positionals.length > 1)
    throw new AgentscrapeUsageError("discover-feed accepts at most one FILE");
  if (recordedMode && file?.length === 0)
    throw new AgentscrapeUsageError("discover-feed FILE must be non-empty");
  if (!sourceUrl) throw new AgentscrapeUsageError("discover-feed requires --source-url URL");
  const sourceKind = (one(parsed, "--source-kind") ?? "auto").toLowerCase();
  if (!["auto", "feed", "archive"].includes(sourceKind))
    throw new AgentscrapeUsageError("--source-kind must be auto, feed, or archive");
  const localFormat = one(parsed, "--format")?.toLowerCase();
  if (localFormat && !["json", "yaml"].includes(localFormat))
    throw new AgentscrapeUsageError("--format must be json or yaml");
  const requestedFormat = (localFormat ?? globalFormat ?? "json").toLowerCase();
  const outputFormat = requestedFormat === "yaml" ? "yaml" : "json";
  const maxBytes = numberOption(parsed, "--max-response-bytes", 2_000_000, {
    integer: true,
    min: 1,
    max: 20_000_000,
  })!;
  const pairs = all(parsed, "--page");
  if (!recordedMode && pairs.length)
    throw new AgentscrapeUsageError("--page is available only in recorded mode with FILE");
  if (recordedMode && one(parsed, "--validator-url") !== undefined)
    throw new AgentscrapeUsageError("--validator-url is available only in live mode");
  const entrySelector = one(parsed, "--archive-entry-selector");
  let archive: ArchiveOptions | undefined;
  const archiveNames =
    findCommandSpec("discover-feed")
      ?.options.filter((option) => option.kind === "value" && option.long.startsWith("--archive-"))
      .map((option) => option.long) ?? [];
  if (entrySelector || archiveNames.some((name) => one(parsed, name) !== undefined)) {
    if (!entrySelector)
      throw new AgentscrapeUsageError("--archive-entry-selector is required for archive discovery");
    archive = {
      entrySelector,
      startUrl: one(parsed, "--archive-start-url"),
      linkSelector: one(parsed, "--archive-link-selector"),
      dateSelector: one(parsed, "--archive-date-selector"),
      dateAttribute: one(parsed, "--archive-date-attribute"),
      updatedSelector: one(parsed, "--archive-updated-selector"),
      nextSelector: one(parsed, "--archive-next-selector"),
      idAttribute: one(parsed, "--archive-id-attribute"),
      titleSelector: one(parsed, "--archive-title-selector"),
      tombstoneSelector: one(parsed, "--archive-tombstone-selector"),
    };
  }
  const feedOptions: FeedOptions = {
    sourceUrl,
    sourceKind: sourceKind as "auto" | "feed" | "archive",
    since: one(parsed, "--since"),
    maxResponseBytes: maxBytes,
    maxPages: numberOption(parsed, "--max-pages", 10, {
      integer: true,
      min: 1,
      max: 100,
    }),
    maxItems: numberOption(parsed, "--max-items", 1000, {
      integer: true,
      min: 1,
      max: 10_000,
    }),
    timeoutSeconds: numberOption(parsed, "--timeout-seconds", 10, {
      min: 0.001,
      max: 300,
    }),
    archive,
    signal,
  };
  let result: ReturnType<typeof discoverFeed>;
  if (recordedMode) {
    if (file === undefined) throw new AgentscrapeUsageError("discover-feed FILE is required");
    const pages: RecordedFeedPage[] = [];
    let readFailure: RecordedFeedInputFailureKind | null = null;
    for (let index = 0; index < pairs.length; index += 2) {
      const read = readBounded(pairs[index + 1]!, maxBytes);
      if (!read.ok) {
        readFailure = read.kind;
        break;
      }
      pages.push({ url: pairs[index]!, content: read.content });
    }
    if (readFailure) {
      result = recordedFeedInputFailure(sourceUrl, readFailure);
    } else {
      const initial = readBounded(file, maxBytes);
      result = initial.ok
        ? discoverFeed(
            {
              url: sourceUrl,
              content: initial.content,
              kind: sourceKind as RecordedFeedPage["kind"],
              validators: {
                etag: one(parsed, "--etag") ?? null,
                last_modified: one(parsed, "--last-modified") ?? null,
              },
            },
            feedOptions,
            pages,
          )
        : recordedFeedInputFailure(sourceUrl, initial.kind);
    }
  } else {
    result = await discoverFeedLive({
      ...feedOptions,
      etag: one(parsed, "--etag"),
      lastModified: one(parsed, "--last-modified"),
      validatorUrl: one(parsed, "--validator-url"),
    });
  }
  if (signal?.aborted) throw cancellationError(signal);
  const serialized =
    outputFormat === "yaml" ? stringifyYaml(result) : JSON.stringify(result, null, 2);
  output(serialized);
  return result.failure === null ? 0 : 1;
}
function presetPath(name: string): string | null {
  if (existsSync(name) && extname(name) === ".json") return name;
  const local = join(process.cwd(), "scrapers", `${name}.json`);
  if (existsSync(local)) return local;
  const official = join(import.meta.dir, "../config/presets", `${name}.json`);
  return existsSync(official) ? official : null;
}
async function presetsCommand(command: string, args: string[]): Promise<number> {
  const parsed = parseArgs(command, args);
  const helpCode = commandHelp(parsed, command);
  if (helpCode !== null) return helpCode;
  const required = command === "list-presets" ? 0 : 1;
  if (parsed.positionals.length !== required)
    throw new AgentscrapeUsageError(
      `${command} requires ${required ? "exactly one NAME" : "no positional arguments"}`,
    );
  if (command === "validate-preset") {
    const path = presetPath(parsed.positionals[0] ?? "");
    if (!path) throw new Error(`preset '${parsed.positionals[0]}' not found`);
    const errors = validatePresetFile(path);
    if (errors.length) {
      console.error(
        redactDiagnostic(
          `Validation failed for ${basename(path)}:\n${errors.map((item) => `  - ${item}`).join("\n")}`,
        ),
      );
      return 1;
    }
    say(`OK: ${basename(path)}`);
    return 0;
  }
  const registry = loadRegistry();
  if (command === "show-preset") {
    const preset = registry.byName(parsed.positionals[0] ?? "");
    if (!preset) throw new Error(`preset '${parsed.positionals[0]}' not found`);
    say(
      `Name:    ${preset.name}\nSummary: ${preset.summary}\nDomain:  ${preset.domain}${preset.aliases.length ? `\nAliases: ${preset.aliases.join(", ")}` : ""}\nMode:    ${preset.mode}`,
    );
    if (preset.mode === "content") {
      say(`Handler: ${preset.handler}`);
      if (preset.url_patterns.length)
        say(`URL Patterns:\n${preset.url_patterns.map((item) => `  - ${item}`).join("\n")}`);
      if (preset.schema) {
        say(`Schema: ${preset.schema}`);
        const fields = SCHEMA_FIELDS[preset.schema];
        if (fields?.length) say(`Fields:\n${fields.map((item) => `  - ${item}`).join("\n")}`);
      }
    } else if (preset.mode === "links")
      say(
        `Selector: ${preset.selector}${preset.toggle_selector ? `\nToggle:   ${preset.toggle_selector}` : ""}`,
      );
    else
      say(
        `Section Selector:  ${preset.section_selector}\nCategory Selector: ${preset.category_selector}${preset.toggle_selector ? `\nToggle Selector:   ${preset.toggle_selector}` : ""}`,
      );
    return 0;
  }
  for (const mode of ["content", "links", "nav-links"]) {
    const values = registry.presets.filter((preset) => preset.mode === mode);
    if (!values.length) continue;
    say(`\n${mode}:`);
    for (const preset of values)
      say(
        `  ${(preset.name + (preset.source === "local" ? " (local)" : "")).padEnd(38)} ${(preset.domain + (preset.aliases.length ? ` (${preset.aliases.join(", ")})` : "")).padEnd(25)} ${preset.summary}`,
      );
  }
  return 0;
}
async function convertCommand(args: string[]): Promise<number> {
  const parsed = parseArgs("convert-html", args);
  const helpCode = commandHelp(parsed, "convert-html");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length > 1)
    throw new AgentscrapeUsageError("convert-html accepts at most one FILE");
  const directory = one(parsed, "--dir");
  if (directory) {
    const count = convertHtmlDirectory(directory);
    if (count) say(`  Converted ${count} HTML files to markdown`);
    return 0;
  }
  const content = parsed.positionals[0]
    ? readRegularFileNoFollow(parsed.positionals[0])
    : await Bun.stdin.text();
  say(convertHtml(content));
  return 0;
}
async function corpusCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseArgs(command, args);
  const helpCode = commandHelp(parsed, command);
  if (helpCode !== null) return helpCode;
  if (command === "capture-corpus") {
    if (parsed.positionals.length !== 1)
      throw new AgentscrapeUsageError("capture-corpus requires exactly one URL");
    const path = await captureCorpus(parsed.positionals[0]!, {
      preset: one(parsed, "--preset"),
      expectFailure: one(parsed, "--expect-failure"),
      allowPrivateNetwork: parsed.flags.has("--allow-private-network") || undefined,
      signal,
    });
    note(`Captured corpus sample: ${path}`);
    return 0;
  }
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("test-corpus takes no positional arguments");
  const result = await testCorpus(one(parsed, "--preset"));
  say(`${result.lines.join("\n")}\n\nResults: ${result.passed} passed, ${result.failed} failed`);
  return result.failed ? 1 : 0;
}
export function checkPresetResultsExitCode(
  results: ReadonlyArray<Pick<CanaryResult, "status">>,
): 0 | 1 {
  return results.every((result) => result.status === "pass") ? 0 : 1;
}

async function canaryCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs("check-presets", args);
  const helpCode = commandHelp(parsed, "check-presets");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("check-presets takes no positional arguments");
  const outputFormat = (one(parsed, "--format") ?? "json").toLowerCase();
  if (!["json", "yaml"].includes(outputFormat))
    throw new AgentscrapeUsageError("--format must be json or yaml");
  if (!parsed.flags.has("--live"))
    throw new AgentscrapeUsageError("check-presets requires --live (no non-live mode is defined)");
  const result = await checkPresets({
    presets: all(parsed, "--preset"),
    allowPrivateNetwork: parsed.flags.has("--allow-private-network") || undefined,
    ...(signal ? { signal } : {}),
  });
  output(outputFormat === "yaml" ? stringifyYaml(result) : JSON.stringify(result, null, 2));
  return checkPresetResultsExitCode(result.results);
}
async function sessionCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseArgs(command, args);
  const helpCode = commandHelp(parsed, command);
  if (helpCode !== null) return helpCode;
  const name = parsed.positionals[0];
  if (!name || parsed.positionals.length !== 1)
    throw new AgentscrapeUsageError(`${command} requires exactly one NAME`);
  if (command === "close-session") {
    await closeBrowserSession(name, signal);
    return 0;
  }
  const result = await runAgentBrowser(["open", "about:blank"], name, undefined, undefined, signal);
  requireAgentBrowserSuccess(result, "Failed to open browser session");
  try {
    await setMediaMode("dark", name, signal);
  } catch {
    if (signal?.aborted) throw cancellationError(signal);
    // Media emulation is best-effort after the session itself opens successfully.
  }
  return 0;
}
async function queueCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs("process-queue", args);
  const helpCode = commandHelp(parsed, "process-queue");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("process-queue takes no positional arguments");
  const result = await processQueue(signal ? { signal } : {});
  console.error(
    `processed=${result.processed} failed=${result.failed} retry_scheduled=${result.retry_scheduled} retry_waiting=${result.retry_waiting} retry_exhausted=${result.retry_exhausted}`,
  );
  return 0;
}
function guideCommand(args: string[]): number {
  const parsed = parseArgs("guide", args);
  const helpCode = commandHelp(parsed, "guide");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("guide takes no positional arguments");
  say(parsed.flags.has("--json") ? renderContractJson() : renderAgentHelp());
  return 0;
}
function doctorCommand(args: string[]): number {
  const parsed = parseArgs("doctor", args);
  const helpCode = commandHelp(parsed, "doctor");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("doctor takes no positional arguments");
  const selected = (one(parsed, "--format") ?? "human").toLowerCase();
  if (selected !== "human" && selected !== "json")
    throw new AgentscrapeUsageError("--format must be human or json");
  const report = currentDoctorReport();
  output(renderDoctorReport(report, selected));
  return doctorExitCode(report);
}
/**
 * `agentscrape mcp`: the stdio MCP server, in this process.
 *
 * The SDK is loaded here rather than at module scope so that no other command
 * pays for it at startup, and so this file and `mcp-server.ts` — which
 * dispatches back through `main` — do not have to resolve each other eagerly.
 */
async function mcpCommand(args: string[]): Promise<number> {
  const parsed = parseArgs("mcp", args);
  const helpCode = commandHelp(parsed, "mcp");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("mcp takes no positional arguments");
  const { serveAgentscrapeMcp } = await import("./mcp");
  await serveAgentscrapeMcp();
  return 0;
}

export interface MainOptions {
  signal?: AbortSignal;
  /**
   * Where this run's output goes. Absent means fd 1 and fd 2, which is what a
   * terminal run wants; `agentscrape mcp` passes a sink because fd 1 is the
   * protocol channel there.
   */
  output?: OutputSink;
}

export async function main(
  argv = process.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  if (options.output === undefined) return dispatch(argv, options.signal);
  // The sink is module state, so two captured runs cannot overlap. The MCP
  // server serializes its calls for exactly this reason; anything else that
  // captures output gets a refusal here rather than another run's bytes.
  if (sink !== null)
    throw new Error("an output sink is already installed; captured runs may not overlap");
  sink = options.output;
  try {
    return await dispatch(argv, options.signal);
  } finally {
    sink = null;
  }
}

async function dispatch(argv: string[], signal?: AbortSignal): Promise<number> {
  let index = 0;
  let globalFormat: string | undefined;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const parsed = parseGlobalOption(argv, index);
    if (parsed.name === "--help") {
      write(renderHumanHelp());
      return 0;
    }
    if (parsed.name === "--version") {
      say(`${CLI_SPEC.name} ${CLI_SPEC.version}`);
      return 0;
    }
    if (parsed.name === "--help-json") {
      say(renderJsonHelp());
      return 0;
    }
    if (parsed.name === "--agent-help") {
      say(renderAgentHelp());
      return 0;
    }
    if (parsed.name === "--agent-teaser") {
      say(renderAgentTeaser());
      return 0;
    }
    if (parsed.name === "--format") {
      globalFormat = parsed.items[0]!.toLowerCase();
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`unhandled global option '${parsed.name}'`);
  }
  const command = argv[index];
  const args = argv.slice(index + 1);
  if (!command) throw new AgentscrapeUsageError("missing command; run agentscrape --help");
  if (command === "help") {
    const parsed = parseArgs("help", args);
    const helpCode = commandHelp(parsed, "help");
    if (helpCode !== null) return helpCode;
    if (parsed.positionals.length > 1)
      throw new AgentscrapeUsageError("help accepts at most one command");
    const target = parsed.positionals[0];
    if (target && !findVisibleCommandSpec(target))
      throw new AgentscrapeUsageError(`unknown command '${target}'`);
    write(renderHumanHelp(target));
    return 0;
  }
  if (!findVisibleCommandSpec(command))
    throw new AgentscrapeUsageError(`unknown command '${command}'`);
  if (command === "fetch-markdown") return fetchMarkdownCommand(args, signal);
  if (command === "fetch-links") return fetchLinksCommand(args, signal);
  if (command === "discover-feed") return discoverFeedCommand(args, signal, globalFormat);
  if (["list-presets", "show-preset", "validate-preset"].includes(command))
    return presetsCommand(command, args);
  if (["capture-corpus", "test-corpus"].includes(command))
    return corpusCommand(command, args, signal);
  if (command === "check-presets") return canaryCommand(args, signal);
  if (command === "convert-html") return convertCommand(args);
  if (["open-session", "close-session"].includes(command))
    return sessionCommand(command, args, signal);
  if (command === "guide") return guideCommand(args);
  if (command === "mcp") return mcpCommand(args);
  if (command === "doctor") return doctorCommand(args);
  return queueCommand(args, signal);
}

if (import.meta.main) {
  const controller = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    if (controller.signal.aborted) return;
    receivedSignal = signal;
    controller.abort(new AgentscrapeCancelledError(`interrupted by ${signal}`));
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    const value = sanitizeErrorInPlace(error);
    if (error instanceof AgentscrapeCancelledError || controller.signal.aborted) {
      process.exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
    } else {
      if (value instanceof AgentscrapeBrowserError && value.artifactDirectory)
        console.error(redactDiagnostic(`Artifacts retained: ${value.artifactDirectory}`));
      console.error(redactDiagnostic(`Error: ${value.message}`));
      process.exitCode =
        error instanceof AgentscrapeUsageError ||
        (error instanceof AgentscrapeError && error.errorClass === "usage") ||
        error instanceof AgentscrapeAuthError ||
        /authentication required/i.test(value.message)
          ? 2
          : 1;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

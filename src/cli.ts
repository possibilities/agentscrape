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
import { checkPresets } from "./canary";
import { captureCorpus, testCorpus } from "./corpus";
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
import { processQueue, reconcileQueue } from "./queue";
import { redactDiagnostic, sanitizeErrorInPlace } from "./redaction";
import type { ExtractionEnvelope } from "./schemas";

const DESCRIPTION = "Fetch and extract web content through an agent-friendly Bun CLI";
const COMMANDS: Array<[string, string]> = [
  ["fetch-markdown URL [DEST]", "Fetch a document and emit Markdown or structured output"],
  ["fetch-links URL", "Extract navigation links or an account timeline"],
  ["discover-feed [FILE]", "Discover live or recorded RSS, Atom, or archive entries"],
  ["list-presets", "List extraction presets"],
  ["show-preset NAME", "Show a preset contract"],
  ["validate-preset NAME_OR_PATH", "Validate a preset contract"],
  ["capture-corpus URL", "Capture a versioned content sample"],
  ["test-corpus", "Replay the mode-aware corpus offline"],
  ["check-presets --live", "Run configured public canaries"],
  ["convert-html [FILE]", "Convert HTML from a file, directory, or stdin"],
  ["open-session NAME", "Pre-warm a browser session"],
  ["close-session NAME", "Close a browser session"],
  ["process-queue", "Process standalone artifact jobs"],
  ["reconcile-queue", "Inventory or reconcile frozen queue records"],
];
const COMMAND_HELP: Record<string, string> = {
  "fetch-markdown": `Usage: agentscrape fetch-markdown URL [DEST] [OPTIONS]\n\nOptions:\n  --selector CSS                 CSS selector (default: auto main/article/body)\n  --media light|dark             Emulated color scheme\n  --session NAME                 Reuse a named browser session\n  --allow-private-network        Allow private direct and unrestricted browser egress\n  --preset NAME                  Select a content preset\n  --generic                      Force generic extraction on a claimed domain\n  --retain-artifacts             Retain sensitive HTML/screenshot diagnostics (Markdown DEST only for HTML)\n  --json | --yaml | --markdown   Select structured/Markdown output\n  --envelope                     Emit a schema-v1 extraction envelope (incompatible with retention)\n  --max-content-bytes INTEGER    Envelope content limit (integer >= 1; default: 1000000)\n  --max-relations INTEGER        Envelope relation limit (integer >= 0; default: 256)\n  --format json|yaml|human       Compatibility option (no-op)\n  -h, --help                     Show help`,
  "fetch-links": `Usage: agentscrape fetch-links URL [OPTIONS]\n\nOptions:\n  --preset NAME                  Select a links preset\n  --section-selector CSS         Section/navigation selector\n  --category-selector CSS        Category selector for two-level navigation\n  --toggle-selector CSS          Toggle/tab selector\n  --limit INTEGER                Positive X timeline item limit\n  --max-scrolls INTEGER          Positive X timeline scroll limit\n  --since-id ID                  Numeric X status cursor\n  --include-replies              Include X replies\n  --include-reposts              Include X reposts\n  --media light|dark             Emulated color scheme\n  --session NAME                 Reuse a named browser session\n  --allow-private-network        Allow unrestricted browser/private network egress\n  --json | --yaml | --markdown   Select output (default: yaml)\n  --format json|yaml|human       Compatibility option (no-op)\n  -h, --help                     Show help`,
  "discover-feed": `Usage: agentscrape discover-feed [FILE] --source-url URL [OPTIONS]\n\nWith no FILE, Agentscrape fetches the source and pagination pages directly. One FILE preserves network-free recorded-response parsing.\n\nOptions:\n  --source-url URL               Requested feed, homepage, or archive URL (required)\n  --source-kind KIND             Source interpretation: auto, feed, or archive (default: auto)\n  --page URL FILE                Recorded pagination page; requires FILE (repeatable)\n  --etag VALUE                   Conditional ETag, or recorded initial-page validator\n  --last-modified VALUE          Conditional Last-Modified, or recorded validator\n  --validator-url URL            Exact live response URL bound to validators\n  --since DATE                   Retain entries at or after DATE\n  --max-response-bytes INTEGER   1..20000000 per response (default: 2000000)\n  --max-pages INTEGER            Recorded 1..100; live 1..10 (default: 10)\n  --max-items INTEGER            1..10000 entries (default: 1000)\n  --timeout-seconds FLOAT        0.001..300 overall seconds (default: 10)\n  --archive-start-url URL        Optional configured archive start URL\n  --archive-entry-selector CSS   Required for archive discovery\n  --archive-link-selector CSS    Archive entry link selector\n  --archive-date-selector CSS    Archive publication date selector\n  --archive-date-attribute NAME  Archive date attribute\n  --archive-updated-selector CSS Archive update date selector\n  --archive-next-selector CSS    Archive pagination selector\n  --archive-id-attribute NAME    Archive stable ID attribute\n  --archive-title-selector CSS   Archive title selector\n  --archive-tombstone-selector CSS Archive tombstone selector\n  --format FORMAT                Output format: json or yaml (default: json)\n  -h, --help                     Show help`,
  "list-presets": "Usage: agentscrape list-presets [--format json|yaml|human]",
  "show-preset": "Usage: agentscrape show-preset NAME [--format json|yaml|human]",
  "validate-preset": "Usage: agentscrape validate-preset NAME_OR_PATH [--format json|yaml|human]",
  "capture-corpus": `Usage: agentscrape capture-corpus URL [OPTIONS]\n\nOptions:\n  --preset NAME                  Select a content preset\n  --expect-failure TYPE         Capture an expected typed failure\n  --allow-private-network       Allow unrestricted browser/private network egress\n  --format json|yaml|human      Compatibility option (no-op)\n  -h, --help                    Show help`,
  "test-corpus": "Usage: agentscrape test-corpus [--preset NAME] [--format json|yaml|human]",
  "check-presets": `Usage: agentscrape check-presets --live [OPTIONS]\n\nOptions:\n  --live                         Acknowledge live canary execution (required)\n  --preset NAME                  Select a preset (repeatable)\n  --allow-private-network        Allow unrestricted browser/private network egress\n  --format json|yaml             Select output (default: json)\n  -h, --help                     Show help`,
  "convert-html":
    "Usage: agentscrape convert-html [FILE] [--dir DIRECTORY] [--format json|yaml|human]",
  "open-session": "Usage: agentscrape open-session NAME [--format json|yaml|human]",
  "close-session": "Usage: agentscrape close-session NAME [--format json|yaml|human]",
  "process-queue": "Usage: agentscrape process-queue [--format json|yaml|human]",
  "reconcile-queue":
    "Usage: agentscrape reconcile-queue [--apply] [--limit INTEGER] [--format json|yaml]\n\n--limit must be an integer from 1 through 5000 (default: 500).",
};
const AGENT_HELP = `Agentscrape fetches Markdown, navigation links, live or recorded feeds, and strict preset output.\n\nUse fetch-markdown URL [DEST] for documents, fetch-links URL with a preset or selectors for navigation, and discover-feed [FILE] --source-url URL for bounded live discovery or network-free recorded parsing. Browser-backed commands accept --media and --session, and require --allow-private-network for live navigation. X timeline collection accepts --limit, --max-scrolls, --since-id, --include-replies, and --include-reposts. Envelope output is schema version 1 and emits a classified failure instead of diagnostics on stdout.`;
const SCHEMA_FIELDS: Record<string, string[]> = {
  AnthropicBilling: [
    "organization: str (default='')",
    "credit_balance: float | None (default=None)",
    "auto_reload: bool | None (default=None)",
  ],
  ChatGPTConversation: ["turns: list[ConversationTurn] (required)"],
  ClaudeBilling: [
    "plan_label: str (default='')",
    "current_plan: int (default=0)",
    "plan_details: str (default='')",
    "renews_on: str (default='')",
    "current_balance: float | None (default=None)",
    "auto_reload: bool | None (default=None)",
    "invoices: list[ClaudeInvoice] (default_factory)",
  ],
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
  OpenAIBilling: [
    "organization: str (default='')",
    "plan_type: str (default='')",
    "credit_balance: float | None (default=None)",
    "auto_recharge: bool | None (default=None)",
  ],
  PerplexityBilling: [
    "credit_balance: float | None (default=None)",
    "usage_tier: int | None (default=None)",
    "auto_reload: bool | None (default=None)",
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

function help(command?: string): string {
  if (command) {
    const value = COMMAND_HELP[command];
    if (!value) throw new AgentscrapeUsageError(`unknown command '${command}'`);
    return `${value}\n`;
  }
  return `agentscrape — ${DESCRIPTION}\n\nUsage: agentscrape [--format json|yaml|human] COMMAND [OPTIONS]\n\nCommands:\n${COMMANDS.map(([name, summary]) => `  ${name.padEnd(35)} ${summary}`).join("\n")}\n\nGlobal options:\n  --format json|yaml|human             Compatibility output preference\n  -h, --help                           Show help\n  -v, --version                        Show version\n`;
}
function helpJson(command?: string): string {
  const commandText = command ? (COMMAND_HELP[command] ?? "") : "";
  const usage = commandText.match(/^Usage: agentscrape \S+ (.+?)(?: \[OPTIONS\])?$/m)?.[1] ?? "";
  const usageTokens = usage.split(/\s+/).filter(Boolean);
  const documentedOptions = [
    ...commandText.matchAll(/^ {2}(--[a-z][a-z-]*)(?:\s+([^\s|]+))?\s+(.*)$/gm),
  ].map((match) => {
    const manualFlag = ["--allow-private-network", "--retain-artifacts"].includes(match[1]!);
    return {
      name: match[1],
      type: manualFlag || !match[2] ? "flag" : "text",
      required: usageTokens.includes(match[1] ?? ""),
      description: manualFlag
        ? `${match[2] ?? ""} ${match[3] ?? ""}`.trim()
        : (match[3]?.trim() ?? ""),
    };
  });
  const firstOption = usageTokens.findIndex((token) => token.includes("--"));
  const positionals = usageTokens
    .slice(0, firstOption < 0 ? undefined : firstOption)
    .filter((token) => token !== "[OPTIONS]")
    .map((token) => ({
      name: token.replace(/^\[|\]$/g, "").toLowerCase(),
      type: "text",
      required: !token.startsWith("["),
      positional: true,
      description: "",
    }));
  return JSON.stringify(
    command
      ? {
          name: command,
          description: COMMANDS.find(([name]) => name.split(" ")[0] === command)?.[1] ?? "",
          arguments: [...positionals, ...documentedOptions],
        }
      : {
          name: "agentscrape",
          description: DESCRIPTION,
          arguments: [],
          commands: COMMANDS.map(([name, description]) => ({
            name: name.split(" ")[0],
            description,
          })),
        },
    null,
    2,
  );
}
interface Parsed {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}
function parseArgs(
  args: string[],
  valueOptions: Set<string>,
  multiValueCounts: Record<string, number> = {},
  flagOptions: Set<string> = new Set(["--help"]),
): Parsed {
  valueOptions.add("--format");
  flagOptions.add("--help-json");
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const [rawName, attached] = token.split("=", 2);
    const name = rawName! === "-h" ? "--help" : rawName!;
    const count = multiValueCounts[name] ?? (valueOptions.has(name) ? 1 : 0);
    if (count === 0) {
      if (!flagOptions.has(name)) throw new AgentscrapeUsageError(`unknown option '${name}'`);
      if (attached !== undefined) throw new AgentscrapeUsageError(`${name} does not take a value`);
      flags.add(name);
      continue;
    }
    const items: string[] = [];
    if (attached !== undefined) items.push(attached);
    while (items.length < count) {
      const value = args[++index];
      if (value === undefined)
        throw new AgentscrapeUsageError(`${name} requires ${count} value${count === 1 ? "" : "s"}`);
      items.push(value);
    }
    values.set(name, [...(values.get(name) ?? []), ...items]);
  }
  for (const value of values.get("--format") ?? [])
    if (!["json", "yaml", "human"].includes(value.toLowerCase()))
      throw new AgentscrapeUsageError("--format must be json, yaml, or human");
  return { positionals, values, flags };
}
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
function output(value: string, destination?: string): void {
  if (destination) {
    writeFileSync(destination, value);
    console.error(`Saved to ${destination}`);
  } else process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}
function resultOutput(result: ScrapeResult, selected: "json" | "yaml" | "markdown"): string {
  if (selected === "markdown") return result.markdown;
  const value = structuredJson(result);
  return selected === "json" ? JSON.stringify(value, null, 2) : stringifyYaml(value);
}
function commandHelp(parsed: Parsed, command: string): number | null {
  if (parsed.flags.has("--help-json")) {
    console.log(helpJson(command));
    return 0;
  }
  if (parsed.flags.has("--help")) {
    process.stdout.write(help(command));
    return 0;
  }
  return null;
}
function writeHtmlArtifacts(artifacts: readonly PreparedTextArtifact[]): void {
  writePreparedTextArtifacts(artifacts);
  for (const artifact of artifacts) console.error(`Saved to ${artifact.path}`);
}
async function fetchMarkdownCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs(
    args,
    new Set([
      "--selector",
      "--media",
      "--session",
      "--preset",
      "--max-content-bytes",
      "--max-relations",
    ]),
    {},
    new Set([
      "--help",
      "--generic",
      "--retain-artifacts",
      "--allow-private-network",
      "--json",
      "--yaml",
      "--markdown",
      "--envelope",
    ]),
  );
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
  const parsed = parseArgs(
    args,
    new Set([
      "--preset",
      "--section-selector",
      "--category-selector",
      "--toggle-selector",
      "--limit",
      "--max-scrolls",
      "--since-id",
      "--media",
      "--session",
    ]),
    {},
    new Set([
      "--help",
      "--allow-private-network",
      "--include-replies",
      "--include-reposts",
      "--json",
      "--yaml",
      "--markdown",
    ]),
  );
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
  const valueNames = [
    "--source-url",
    "--source-kind",
    "--etag",
    "--last-modified",
    "--validator-url",
    "--since",
    "--max-response-bytes",
    "--max-pages",
    "--max-items",
    "--timeout-seconds",
    "--archive-start-url",
    "--archive-entry-selector",
    "--archive-link-selector",
    "--archive-date-selector",
    "--archive-date-attribute",
    "--archive-updated-selector",
    "--archive-next-selector",
    "--archive-id-attribute",
    "--archive-title-selector",
    "--archive-tombstone-selector",
    "--format",
  ];
  const parsed = parseArgs(args, new Set(valueNames), { "--page": 2 }, new Set(["--help"]));
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
  const archiveNames = valueNames.filter((name) => name.startsWith("--archive-"));
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
  if (existsSync(name) && [".yaml", ".yml"].includes(extname(name))) return name;
  const local = join(process.cwd(), "scrapers", `${name}.yaml`);
  if (existsSync(local)) return local;
  const official = join(import.meta.dir, "../config/presets", `${name}.yaml`);
  return existsSync(official) ? official : null;
}
async function presetsCommand(command: string, args: string[]): Promise<number> {
  const parsed = parseArgs(args, new Set());
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
    console.log(`OK: ${basename(path)}`);
    return 0;
  }
  const registry = loadRegistry();
  if (command === "show-preset") {
    const preset = registry.byName(parsed.positionals[0] ?? "");
    if (!preset) throw new Error(`preset '${parsed.positionals[0]}' not found`);
    console.log(
      `Name:    ${preset.name}\nSummary: ${preset.summary}\nDomain:  ${preset.domain}${preset.aliases.length ? `\nAliases: ${preset.aliases.join(", ")}` : ""}\nMode:    ${preset.mode}`,
    );
    if (preset.mode === "content") {
      console.log(`Handler: ${preset.handler}`);
      if (preset.url_patterns.length)
        console.log(
          `URL Patterns:\n${preset.url_patterns.map((item) => `  - ${item}`).join("\n")}`,
        );
      if (preset.schema) {
        console.log(`Schema: ${preset.schema}`);
        const fields = SCHEMA_FIELDS[preset.schema];
        if (fields?.length)
          console.log(`Fields:\n${fields.map((item) => `  - ${item}`).join("\n")}`);
      }
    } else if (preset.mode === "links")
      console.log(
        `Selector: ${preset.selector}${preset.toggle_selector ? `\nToggle:   ${preset.toggle_selector}` : ""}`,
      );
    else
      console.log(
        `Section Selector:  ${preset.section_selector}\nCategory Selector: ${preset.category_selector}${preset.toggle_selector ? `\nToggle Selector:   ${preset.toggle_selector}` : ""}`,
      );
    return 0;
  }
  for (const mode of ["content", "links", "nav-links"]) {
    const values = registry.presets.filter((preset) => preset.mode === mode);
    if (!values.length) continue;
    console.log(`\n${mode}:`);
    for (const preset of values)
      console.log(
        `  ${(preset.name + (preset.source === "local" ? " (local)" : "")).padEnd(38)} ${(preset.domain + (preset.aliases.length ? ` (${preset.aliases.join(", ")})` : "")).padEnd(25)} ${preset.summary}`,
      );
  }
  return 0;
}
async function convertCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, new Set(["--dir"]), {}, new Set(["--help"]));
  const helpCode = commandHelp(parsed, "convert-html");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length > 1)
    throw new AgentscrapeUsageError("convert-html accepts at most one FILE");
  const directory = one(parsed, "--dir");
  if (directory) {
    const count = convertHtmlDirectory(directory);
    if (count) console.log(`  Converted ${count} HTML files to markdown`);
    return 0;
  }
  const content = parsed.positionals[0]
    ? readRegularFileNoFollow(parsed.positionals[0])
    : await Bun.stdin.text();
  console.log(convertHtml(content));
  return 0;
}
async function corpusCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseArgs(
    args,
    new Set(["--preset", "--expect-failure"]),
    {},
    new Set(["--help", ...(command === "capture-corpus" ? ["--allow-private-network"] : [])]),
  );
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
    console.error(`Captured corpus sample: ${path}`);
    return 0;
  }
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("test-corpus takes no positional arguments");
  const result = await testCorpus(one(parsed, "--preset"));
  console.log(
    `${result.lines.join("\n")}\n\nResults: ${result.passed} passed, ${result.failed} failed`,
  );
  return result.failed ? 1 : 0;
}
async function canaryCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs(
    args,
    new Set(["--preset", "--format"]),
    {},
    new Set(["--help", "--live", "--allow-private-network"]),
  );
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
  return result.results.some((item) => item.status === "drift") ? 1 : 0;
}
async function sessionCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseArgs(args, new Set());
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
async function queueCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  if (command === "process-queue") {
    const parsed = parseArgs(args, new Set());
    const helpCode = commandHelp(parsed, command);
    if (helpCode !== null) return helpCode;
    if (parsed.positionals.length)
      throw new AgentscrapeUsageError("process-queue takes no positional arguments");
    const result = await processQueue(signal ? { signal } : {});
    console.error(
      `processed=${result.processed} failed=${result.failed} frozen=${result.frozen} retry_scheduled=${result.retry_scheduled} retry_waiting=${result.retry_waiting} retry_exhausted=${result.retry_exhausted}`,
    );
    return 0;
  }
  const parsed = parseArgs(
    args,
    new Set(["--limit", "--format"]),
    {},
    new Set(["--help", "--apply"]),
  );
  const helpCode = commandHelp(parsed, "reconcile-queue");
  if (helpCode !== null) return helpCode;
  if (parsed.positionals.length)
    throw new AgentscrapeUsageError("reconcile-queue takes no positional arguments");
  const outputFormat = (one(parsed, "--format") ?? "json").toLowerCase();
  if (!["json", "yaml"].includes(outputFormat))
    throw new AgentscrapeUsageError("--format must be json or yaml");
  const result = await reconcileQueue({
    apply: parsed.flags.has("--apply"),
    limit: numberOption(parsed, "--limit", 500, { integer: true, min: 1, max: 5000 }),
    signal,
  });
  output(outputFormat === "yaml" ? stringifyYaml(result) : JSON.stringify(result));
  return Number(result.errors ?? 0) ? 1 : 0;
}
export interface MainOptions {
  signal?: AbortSignal;
}
function globalValue(argv: string[], index: number, name: string): [string, number] {
  const token = argv[index]!;
  const attached = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : undefined;
  if (attached !== undefined) return [attached, index + 1];
  const value = argv[index + 1];
  if (value === undefined) throw new AgentscrapeUsageError(`${name} requires a value`);
  return [value, index + 2];
}

export async function main(
  argv = process.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  let index = 0;
  let globalFormat: string | undefined;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const token = argv[index]!;
    if (["--help", "-h"].includes(token)) {
      process.stdout.write(help());
      return 0;
    }
    if (["--version", "-v"].includes(token)) {
      console.log("agentscrape 0.1.0");
      return 0;
    }
    if (token === "--help-json") {
      console.log(helpJson());
      return 0;
    }
    if (token === "--agent-help") {
      console.log(AGENT_HELP);
      return 0;
    }
    if (token === "--agent-teaser") {
      console.log(
        `${DESCRIPTION}\n\n${COMMANDS.map(([name, description]) => `  ${name.padEnd(35)} ${description}`).join("\n")}\n\nRun agentscrape COMMAND --help for argument details.`,
      );
      return 0;
    }
    if (token === "--format" || token.startsWith("--format=")) {
      const [value, next] = globalValue(argv, index, "--format");
      globalFormat = value.toLowerCase();
      if (!["json", "yaml", "human"].includes(globalFormat))
        throw new AgentscrapeUsageError("--format must be json, yaml, or human");
      index = next;
      continue;
    }
    throw new AgentscrapeUsageError(`unknown option '${token.split("=", 1)[0]}'`);
  }
  const command = argv[index];
  const args = argv.slice(index + 1);
  if (!command) throw new AgentscrapeUsageError("missing command; run agentscrape --help");
  if (command === "help") {
    if (args.length > 1) throw new AgentscrapeUsageError("help accepts at most one command");
    process.stdout.write(help(args[0]));
    return 0;
  }
  if (!COMMAND_HELP[command]) throw new AgentscrapeUsageError(`unknown command '${command}'`);
  const signal = options.signal;
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
  return queueCommand(command, args, signal);
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

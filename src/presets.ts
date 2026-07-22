import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { withBrowserSignal } from "./browser";
import { PresetConfigError, PresetOutputError, PresetSelectionError } from "./errors";
import {
  scrapeAnthropicBilling,
  scrapeClaudeBilling,
  scrapeOpenAiBilling,
  scrapePerplexityBilling,
} from "./handlers/billing";
import { scrapeConversation } from "./handlers/chatgpt";
import { scrapeSearchConversation, scrapeWikiPage } from "./handlers/deepwiki";
import type { ContentHandler, HandlerOptions, ScrapeResult } from "./handlers/types";
import { scrapeArticle, scrapeProfile, scrapeTimeline, scrapeTweet } from "./handlers/x";
import {
  AnthropicBilling,
  ChatGPTConversation,
  ClaudeBilling,
  DeepWikiSearchConversation,
  DeepWikiWikiPage,
  LinkList,
  OpenAIBilling,
  PerplexityBilling,
  ScrapeSchema,
  TweetThread,
  XArticle,
  XProfile,
  XTimeline,
} from "./schemas";

export type PresetMode = "content" | "links" | "nav-links";
export interface PresetConfig {
  name: string;
  summary: string;
  domain: string;
  mode: PresetMode;
  aliases: string[];
  browser_profile?: string | undefined;
  url_patterns: string[];
  handler?: string | undefined;
  schema?: string | undefined;
  selector?: string | undefined;
  section_selector?: string | undefined;
  category_selector?: string | undefined;
  toggle_selector?: string | undefined;
  source: "official" | "local";
}

export type ScrapeSchemaConstructor = abstract new (...args: any[]) => ScrapeSchema;
export interface ContentHandlerRegistration {
  handlerName: string;
  schemaName: string;
  handler: ContentHandler;
  schema: ScrapeSchemaConstructor;
}

const HANDLERS: Record<string, ContentHandler> = {};
const SCHEMAS: Record<string, ScrapeSchemaConstructor> = {};
const HANDLER_SCHEMAS: Record<string, string> = {};
function addContentHandler(registration: ContentHandlerRegistration): void {
  HANDLERS[registration.handlerName] = registration.handler;
  SCHEMAS[registration.schemaName] = registration.schema;
  HANDLER_SCHEMAS[registration.handlerName] = registration.schemaName;
}
for (const registration of [
  {
    handlerName: "anthropic_billing.scrape_anthropic_billing",
    schemaName: "AnthropicBilling",
    handler: scrapeAnthropicBilling,
    schema: AnthropicBilling,
  },
  {
    handlerName: "chatgpt.scrape_conversation",
    schemaName: "ChatGPTConversation",
    handler: scrapeConversation,
    schema: ChatGPTConversation,
  },
  {
    handlerName: "claude_billing.scrape_claude_billing",
    schemaName: "ClaudeBilling",
    handler: scrapeClaudeBilling,
    schema: ClaudeBilling,
  },
  {
    handlerName: "deepwiki.scrape_search_conversation",
    schemaName: "DeepWikiSearchConversation",
    handler: scrapeSearchConversation,
    schema: DeepWikiSearchConversation,
  },
  {
    handlerName: "deepwiki.scrape_wiki_page",
    schemaName: "DeepWikiWikiPage",
    handler: scrapeWikiPage,
    schema: DeepWikiWikiPage,
  },
  {
    handlerName: "openai_billing.scrape_openai_billing",
    schemaName: "OpenAIBilling",
    handler: scrapeOpenAiBilling,
    schema: OpenAIBilling,
  },
  {
    handlerName: "perplexity_billing.scrape_perplexity_billing",
    schemaName: "PerplexityBilling",
    handler: scrapePerplexityBilling,
    schema: PerplexityBilling,
  },
  {
    handlerName: "x.scrape_article",
    schemaName: "XArticle",
    handler: scrapeArticle,
    schema: XArticle,
  },
  {
    handlerName: "x.scrape_profile",
    schemaName: "XProfile",
    handler: scrapeProfile,
    schema: XProfile,
  },
  {
    handlerName: "x.scrape_timeline",
    schemaName: "XTimeline",
    handler: scrapeTimeline,
    schema: XTimeline,
  },
  {
    handlerName: "x.scrape_tweet",
    schemaName: "TweetThread",
    handler: scrapeTweet,
    schema: TweetThread,
  },
] satisfies ContentHandlerRegistration[]) {
  addContentHandler(registration);
}

/**
 * Register one trusted in-process TypeScript content handler and its structured schema.
 *
 * Registration is explicit and process-local: configuration and environment variables never load
 * executable modules. The returned function unregisters only this exact registration.
 */
export function registerContentHandler(registration: ContentHandlerRegistration): () => void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(registration.handlerName))
    throw new PresetConfigError("content handler name is invalid");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(registration.schemaName))
    throw new PresetConfigError("content schema name is invalid");
  if (typeof registration.handler !== "function")
    throw new PresetConfigError("content handler must be a function");
  if (
    typeof registration.schema !== "function" ||
    !(registration.schema.prototype instanceof ScrapeSchema)
  )
    throw new PresetConfigError("content schema must extend ScrapeSchema");
  if (HANDLERS[registration.handlerName])
    throw new PresetConfigError(
      `content handler '${registration.handlerName}' is already registered`,
    );
  if (SCHEMAS[registration.schemaName])
    throw new PresetConfigError(
      `content schema '${registration.schemaName}' is already registered`,
    );
  addContentHandler(registration);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (HANDLERS[registration.handlerName] === registration.handler)
      delete HANDLERS[registration.handlerName];
    if (SCHEMAS[registration.schemaName] === registration.schema)
      delete SCHEMAS[registration.schemaName];
    if (HANDLER_SCHEMAS[registration.handlerName] === registration.schemaName)
      delete HANDLER_SCHEMAS[registration.handlerName];
  };
}
const COMMON = new Set(["name", "summary", "domain", "mode", "aliases", "browser_profile"]);
const MODE_FIELDS: Record<PresetMode, Set<string>> = {
  content: new Set(["url_patterns", "handler", "schema"]),
  links: new Set(["selector", "toggle_selector"]),
  "nav-links": new Set(["section_selector", "category_selector", "toggle_selector"]),
};
const ALL_FIELDS = new Set([...COMMON, ...Object.values(MODE_FIELDS).flatMap((set) => [...set])]);
const STRING_FIELDS = new Set([
  "name",
  "summary",
  "domain",
  "mode",
  "browser_profile",
  "handler",
  "schema",
  "selector",
  "toggle_selector",
  "section_selector",
  "category_selector",
]);

interface RawEntry {
  data: Record<string, unknown>;
  label: string;
  source: "official" | "local";
}

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

export function canonicalMatchUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function problems(data: Record<string, unknown>, label: string): string[] {
  const result: string[] = [];
  const unknown = Object.keys(data)
    .filter((key) => !ALL_FIELDS.has(key))
    .sort();
  if (unknown.length) result.push(`${label}: unknown keys: ${unknown.join(", ")}`);
  for (const field of ["name", "summary", "domain", "mode"]) {
    if (!(field in data)) result.push(`${label}: missing required field: ${field}`);
  }
  for (const [name, value] of Object.entries(data)) {
    if (STRING_FIELDS.has(name) && value !== null && typeof value !== "string") {
      result.push(`${label}: field '${name}' must be a string`);
    }
  }
  for (const name of ["aliases", "url_patterns"]) {
    const value = data[name];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    ) {
      result.push(`${label}: field '${name}' must be a list of strings`);
    }
  }
  const mode = data.mode;
  if (typeof mode === "string" && !(["content", "links", "nav-links"] as string[]).includes(mode)) {
    result.push(`${label}: invalid mode: '${mode}' (must be one of content, links, nav-links)`);
  }
  if ((["content", "links", "nav-links"] as unknown[]).includes(mode)) {
    const applicable = new Set([...COMMON, ...MODE_FIELDS[mode as PresetMode]]);
    const invalid = Object.keys(data)
      .filter((key) => ALL_FIELDS.has(key) && !applicable.has(key))
      .sort();
    if (invalid.length)
      result.push(`${label}: fields not valid for mode '${mode}': ${invalid.join(", ")}`);
  }
  for (const pattern of Array.isArray(data.url_patterns) ? data.url_patterns : []) {
    if (typeof pattern !== "string") continue;
    try {
      new RegExp(pattern);
    } catch (error) {
      result.push(`${label}: invalid url_pattern '${pattern}': ${String(error)}`);
    }
  }
  if (mode === "content") {
    if (typeof data.handler !== "string" || !data.handler)
      result.push(`${label}: content mode requires 'handler'`);
    else if (!HANDLERS[data.handler])
      result.push(
        `${label}: cannot resolve handler '${data.handler}'; the CLI does not load local executable code (register trusted TypeScript handlers through the package API)`,
      );
    if (typeof data.schema !== "string" || !data.schema)
      result.push(`${label}: content mode requires 'schema'`);
    else if (!SCHEMAS[data.schema])
      result.push(`${label}: schema '${data.schema}' is not a ScrapeSchema class`);
    else if (typeof data.handler === "string" && HANDLER_SCHEMAS[data.handler] !== data.schema)
      result.push(
        `${label}: handler '${data.handler}' is not registered with schema '${data.schema}'`,
      );
  } else if (mode === "links" && (typeof data.selector !== "string" || !data.selector)) {
    result.push(`${label}: links mode requires 'selector'`);
  } else if (mode === "nav-links") {
    if (typeof data.section_selector !== "string" || !data.section_selector)
      result.push(`${label}: nav-links mode requires 'section_selector'`);
    if (typeof data.category_selector !== "string" || !data.category_selector)
      result.push(`${label}: nav-links mode requires 'category_selector'`);
  }
  return result;
}

export function validatePresetFile(path: string): string[] {
  let value: unknown;
  try {
    value = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return [`Failed to parse YAML: ${String(error)}`];
  }
  if (value === null || value === undefined) return ["Preset file is empty"];
  if (typeof value !== "object" || Array.isArray(value)) return ["Preset must be a YAML mapping"];
  return problems(value as Record<string, unknown>, basename(path)).map((problem) =>
    problem.startsWith(`${basename(path)}: `) ? problem.slice(basename(path).length + 2) : problem,
  );
}

function readEntries(
  directory: string,
  source: "official" | "local",
): { entries: RawEntry[]; errors: string[] } {
  if (!existsSync(directory)) return { entries: [], errors: [] };
  const entries: RawEntry[] = [];
  const errors: string[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .sort()) {
    const label = `${file} (${source})`;
    try {
      const data = parseYaml(readFileSync(join(directory, file), "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        errors.push(`${label}: preset must be a YAML mapping`);
      else entries.push({ data: data as Record<string, unknown>, label, source });
    } catch (error) {
      errors.push(`${label}: failed to parse YAML: ${String(error)}`);
    }
  }
  return { entries, errors };
}

function toConfig(entry: RawEntry): PresetConfig {
  const data = entry.data;
  const optional = (name: string): string | undefined =>
    typeof data[name] === "string" ? (data[name] as string) : undefined;
  return {
    name: data.name as string,
    summary: data.summary as string,
    domain: data.domain as string,
    mode: data.mode as PresetMode,
    aliases: (data.aliases as string[] | undefined) ?? [],
    url_patterns: (data.url_patterns as string[] | undefined) ?? [],
    ...(optional("browser_profile") ? { browser_profile: optional("browser_profile") } : {}),
    ...(optional("handler") ? { handler: optional("handler") } : {}),
    ...(optional("schema") ? { schema: optional("schema") } : {}),
    ...(optional("selector") ? { selector: optional("selector") } : {}),
    ...(optional("section_selector") ? { section_selector: optional("section_selector") } : {}),
    ...(optional("category_selector") ? { category_selector: optional("category_selector") } : {}),
    ...(optional("toggle_selector") ? { toggle_selector: optional("toggle_selector") } : {}),
    source: entry.source,
  };
}

export class PresetRegistry {
  readonly claimedHosts: Set<string>;
  readonly matchers: Map<string, RegExp[]>;
  constructor(public readonly presets: PresetConfig[]) {
    this.claimedHosts = new Set(
      presets
        .flatMap((preset) => [preset.domain, ...preset.aliases])
        .filter((host) => host !== "*")
        .map(normalizeHost),
    );
    this.matchers = new Map(
      presets.map((preset) => [preset.name, preset.url_patterns.map((value) => new RegExp(value))]),
    );
  }
  byName(name: string): PresetConfig | null {
    return this.presets.find((preset) => preset.name === name) ?? null;
  }
  pageKindMatches(value: string): PresetConfig[] {
    const url = canonicalMatchUrl(value);
    if (!url) return [];
    return this.presets.filter((preset) =>
      (this.matchers.get(preset.name) ?? []).some((pattern) => pattern.test(url)),
    );
  }
  isClaimed(value: string): boolean {
    const canonical = canonicalMatchUrl(value);
    if (!canonical) return false;
    return this.claimedHosts.has(normalizeHost(new URL(canonical).hostname));
  }
}

export function buildRegistry(
  official: RawEntry[],
  local: RawEntry[],
  extra: string[] = [],
): PresetRegistry {
  const allProblems = [...extra];
  for (const entry of [...official, ...local])
    allProblems.push(...problems(entry.data, entry.label));
  const configs = (entries: RawEntry[]) =>
    entries.filter((entry) => problems(entry.data, entry.label).length === 0).map(toConfig);
  const officialConfigs = configs(official);
  const localConfigs = configs(local);
  for (const [source, values] of [
    ["official", officialConfigs],
    ["local", localConfigs],
  ] as const) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value.name))
        allProblems.push(`duplicate preset name '${value.name}' within ${source} presets`);
      seen.add(value.name);
    }
  }
  const localNames = new Set(localConfigs.map((value) => value.name));
  const merged = [
    ...officialConfigs.filter((value) => !localNames.has(value.name)),
    ...localConfigs,
  ];
  const owners = new Map<string, string[]>();
  for (const preset of merged)
    for (const pattern of preset.url_patterns)
      owners.set(pattern, [...(owners.get(pattern) ?? []), preset.name]);
  for (const [pattern, names] of owners) {
    if (names.length > 1)
      allProblems.push(
        `url_pattern '${pattern}' is declared by multiple presets: ${[...new Set(names)].sort().join(", ")}`,
      );
  }
  if (allProblems.length) {
    const unique = [...new Set(allProblems)].sort();
    throw new PresetConfigError(
      `preset registry has ${unique.length} configuration problem(s)`,
      unique,
    );
  }
  return new PresetRegistry(merged);
}

export function loadRegistry(
  options: { officialDir?: string; localDir?: string } = {},
): PresetRegistry {
  const officialDir = options.officialDir ?? join(import.meta.dir, "../config/presets");
  const localDir = options.localDir ?? join(process.cwd(), "scrapers");
  const official = readEntries(officialDir, "official");
  const local = readEntries(localDir, "local");
  return buildRegistry(official.entries, local.entries, [...official.errors, ...local.errors]);
}

export function matchPreset(url: string, presets: PresetConfig[]): PresetConfig | null {
  const registry = new PresetRegistry(presets);
  const matches = registry.pageKindMatches(url);
  return matches.length === 1 ? matches[0]! : null;
}

export function selectPreset(
  url: string,
  registry: PresetRegistry,
  options: {
    preset?: string | null | undefined;
    generic?: boolean | undefined;
  } = {},
): PresetConfig | null {
  if (options.generic && options.preset)
    throw new PresetSelectionError(`--generic conflicts with explicit preset '${options.preset}'`);
  if (options.preset) {
    const preset = registry.byName(options.preset);
    if (!preset) throw new PresetSelectionError(`preset '${options.preset}' not found`);
    return preset;
  }
  if (options.generic) return null;
  const matches = registry.pageKindMatches(url);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new PresetSelectionError(
      `URL matches multiple presets (${matches
        .map((item) => item.name)
        .sort()
        .join(", ")}); pass --preset to disambiguate`,
    );
  if (registry.isClaimed(url))
    throw new PresetSelectionError(
      "no preset matches this URL on a preset-owned domain; pass --generic to force generic extraction",
    );
  return null;
}

export function validateContentResult(
  result: unknown,
  preset: PresetConfig,
): asserts result is ScrapeResult {
  const label = `preset '${preset.name}'`;
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new PresetOutputError(`${label} handler did not return a result object`);
  const value = result as Record<string, unknown>;
  const missing = ["full_html", "selected_html", "markdown", "structured"].filter(
    (key) => !(key in value),
  );
  if (missing.length)
    throw new PresetOutputError(`${label} result is missing required keys: ${missing.join(", ")}`);
  for (const key of ["full_html", "selected_html", "markdown"])
    if (typeof value[key] !== "string")
      throw new PresetOutputError(`${label} result field '${key}' is not a string`);
  const expected = preset.schema ? SCHEMAS[preset.schema] : undefined;
  if (expected && !(value.structured instanceof expected)) {
    const observed =
      value.structured === null
        ? "null"
        : ((value.structured as object)?.constructor?.name ?? typeof value.structured);
    throw new PresetOutputError(
      `${label} produced structured type ${observed}, expected ${preset.schema}`,
    );
  }
  if (!(value.markdown as string).trim())
    throw new PresetOutputError(`${label} produced empty markdown output`);
  if ((value.structured as ScrapeSchema).toMarkdown() !== value.markdown)
    throw new PresetOutputError(
      `${label} markdown diverges from ${(value.structured as object).constructor.name}.toMarkdown()`,
    );
}

export async function scrapeWithPreset(
  url: string,
  preset: PresetConfig,
  options: HandlerOptions = {},
): Promise<ScrapeResult> {
  return withBrowserSignal(options.signal, async () => {
    const resolved = {
      ...options,
      browserProfile: options.browserProfile ?? preset.browser_profile,
    };
    if (preset.mode === "content") {
      const handler = preset.handler ? HANDLERS[preset.handler] : undefined;
      if (!handler)
        throw new PresetConfigError(`Preset '${preset.name}' has no resolvable handler`);
      return handler(url, resolved);
    }
    const { scrapeLinks, scrapeNavLinks } = await import("./links");
    const links =
      preset.mode === "links"
        ? await scrapeLinks(url, preset.selector!, preset.toggle_selector, resolved)
        : await scrapeNavLinks(
            url,
            preset.section_selector!,
            preset.category_selector!,
            preset.toggle_selector,
            resolved,
          );
    const structured = new LinkList(links);
    return {
      full_html: "",
      selected_html: "",
      links,
      structured,
      markdown: structured.toMarkdown(),
    };
  });
}

export function schemaNames(): string[] {
  return Object.keys(SCHEMAS).sort();
}

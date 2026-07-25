import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  closeSession,
  resetBrowserUnavailableCache,
  runAgentBrowser,
  withBrowserProfile,
  withBrowserSignal,
} from "./browser";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  EnvelopeBuildError,
  failureExitCode,
  implementationHint,
  validateEnvelopeRequest,
  validateProviderFinalUrl,
} from "./envelope";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeHttpError,
  AgentscrapeProviderError,
  AgentscrapeRuntimeError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  AgentscrapeValueError,
  cancellationError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  throwIfAborted,
} from "./errors";
import { scrapePage } from "./generic";
import { fetchGithubIfApplicable, isGithubUrl, parseGithubUrl } from "./github";
import type { HandlerOptions, ScrapeResult } from "./handlers/types";
import { captureXStatusPage, scrapeCapturedXStatus } from "./handlers/x";
import { convertHtml as convertHtmlImpl } from "./html";
import { scrapeLinks, scrapeNavLinks } from "./links";
import {
  loadRegistry,
  matchPreset,
  scrapeWithPreset,
  selectPreset,
  validateContentResult,
} from "./presets";

export {
  type ContentHandlerRegistration,
  registerContentHandler,
  type ScrapeSchemaConstructor,
} from "./presets";

import {
  type ExtractionEnvelope,
  GenericPage,
  type LinkItem,
  LinkList,
  ScrapeSchema,
} from "./schemas";

export {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeHttpError,
  AgentscrapeProviderError,
  AgentscrapeRuntimeError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  AgentscrapeValueError,
  isGithubUrl,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  parseGithubUrl,
  resetBrowserUnavailableCache,
};

export interface FetchMarkdownOptions extends HandlerOptions {
  preset?: string | null | undefined;
  selector?: string | undefined;
  destination?: string | null | undefined;
  generic?: boolean | undefined;
  envelope?: boolean | undefined;
  maxContentBytes?: number | undefined;
  maxRelations?: number | undefined;
  signal?: AbortSignal | undefined;
}

async function directMarkdown(
  url: string,
  options: FetchMarkdownOptions,
): Promise<ScrapeResult<GenericPage>> {
  const limit = options.maxContentBytes ?? 1_000_000;
  const requested = validateEnvelopeRequest(url, limit, 0);
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () =>
      timeoutController.abort(new DOMException("direct Markdown fetch timed out", "TimeoutError")),
    30_000,
  );
  timer.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let cancelActiveReader: (() => Promise<void>) | null = null;
  const onAbort = () => {
    void cancelActiveReader?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let current = requested;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 10; redirects += 1) {
      throwIfAborted(options.signal);
      response = await fetch(current, {
        headers: { "user-agent": "agentscrape/1.0" },
        redirect: "manual",
        signal,
      });
      throwIfAborted(options.signal);
      if (timeoutController.signal.aborted)
        throw new AgentscrapeTimeoutError("direct Markdown fetch timed out");
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location)
        throw new AgentscrapeHttpError(
          `direct Markdown redirect has no Location header (HTTP ${response.status})`,
          response.status,
        );
      if (redirects === 10)
        throw new AgentscrapeProviderError("direct Markdown redirect limit exceeded", false);
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new EnvelopeBuildError(
          "malformed_provider_output",
          "direct Markdown redirect URL is invalid",
        );
      }
      current = validateProviderFinalUrl(next) ?? next;
    }
    if (!response) throw new AgentscrapeProviderError("direct Markdown fetch returned no response");
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if ([401, 403].includes(response.status))
        throw new AgentscrapeAuthError(
          `direct Markdown source requires authentication (HTTP ${response.status})`,
        );
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new AgentscrapeHttpError(
        `direct Markdown fetch failed (HTTP ${response.status})`,
        response.status,
        retryable,
      );
    }
    const finalUrl = validateProviderFinalUrl(response.url || current) ?? current;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new EnvelopeBuildError(
        "output_limit_exceeded",
        `content exceeds the ${limit}-byte limit`,
      );
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      const activeReader = response.body.getReader();
      cancelActiveReader = async () => {
        await activeReader.cancel(signal.reason).catch(() => undefined);
      };
      while (true) {
        const { done, value } = await activeReader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (value.byteLength > limit - length) {
          await activeReader.cancel("content limit exceeded").catch(() => undefined);
          throw new EnvelopeBuildError(
            "output_limit_exceeded",
            `content exceeds the ${limit}-byte limit`,
          );
        }
        chunks.push(value.slice());
        length += value.byteLength;
      }
      activeReader.releaseLock();
      cancelActiveReader = null;
    }
    throwIfAborted(options.signal);
    if (timeoutController.signal.aborted)
      throw new AgentscrapeTimeoutError("direct Markdown fetch timed out");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EnvelopeBuildError(
        "malformed_provider_output",
        "direct Markdown response is not valid UTF-8",
      );
    }
    const structured = new GenericPage(finalUrl, markdown);
    return {
      full_html: "",
      selected_html: "",
      markdown,
      structured,
      final_url: finalUrl,
    };
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (timeoutController.signal.aborted)
      throw new AgentscrapeTimeoutError("direct Markdown fetch timed out");
    if (error instanceof AgentscrapeError || error instanceof EnvelopeBuildError) throw error;
    throw new AgentscrapeProviderError(
      `direct Markdown fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await cancelActiveReader?.();
  }
}

async function browserFinalUrl(session?: string | null, signal?: AbortSignal): Promise<string> {
  const result = await runAgentBrowser(
    ["eval", "window.location.href"],
    session,
    undefined,
    undefined,
    signal,
  );
  if (result.exitCode !== 0)
    throw new AgentscrapeBrowserError(`failed to capture final URL: ${result.stderr}`);
  let value: unknown = result.stdout.trim();
  try {
    value = JSON.parse(value as string);
  } catch {
    /* browser wrappers may return bare text */
  }
  const finalUrl = validateProviderFinalUrl(value);
  if (!finalUrl) throw new AgentscrapeBrowserError("browser returned no final URL");
  return finalUrl;
}

function writeArtifacts(
  destination: string,
  result: ScrapeResult,
  content = result.markdown,
  includeHtml = true,
): void {
  writeFileSync(destination, content);
  if (!includeHtml || result.links) return;
  const directory = dirname(destination);
  const stem = basename(destination, extname(destination));
  if (result.full_html) writeFileSync(join(directory, `${stem}.raw.html`), result.full_html);
  if (result.selected_html)
    writeFileSync(join(directory, `${stem}.selected.html`), result.selected_html);
}

type MarkdownRoute =
  | { kind: "preset"; preset: NonNullable<ReturnType<typeof selectPreset>> }
  | { kind: "generic" }
  | { kind: "github" }
  | { kind: "markdown" };

function markdownRoute(
  url: string,
  preset: ReturnType<typeof selectPreset>,
  generic: boolean,
): MarkdownRoute {
  if (preset) return { kind: "preset", preset };
  if (generic) return { kind: "generic" };
  if (parseGithubUrl(url)) return { kind: "github" };
  if (new URL(url).pathname.endsWith(".md")) return { kind: "markdown" };
  return { kind: "generic" };
}

export async function fetchMarkdown(
  url: string,
  options: FetchMarkdownOptions = {},
): Promise<ScrapeResult | ExtractionEnvelope> {
  const envelopeMode = options.envelope ?? false;
  const maxContentBytes = options.maxContentBytes ?? 1_000_000;
  const maxRelations = options.maxRelations ?? 256;
  let hint = implementationHint(url, options.preset);
  let finalUrl: string | null = null;
  let browserUsed = false;

  try {
    try {
      let requested: string;
      try {
        requested = validateEnvelopeRequest(url, maxContentBytes, maxRelations);
      } catch (error) {
        if (
          !envelopeMode &&
          error instanceof EnvelopeBuildError &&
          error.failureClass === "invalid_request"
        )
          throw new AgentscrapeUsageError(error.message);
        throw error;
      }
      const registry = loadRegistry();
      const selected = selectPreset(requested, registry, {
        preset: options.preset,
        generic: options.generic,
      });
      const route = markdownRoute(requested, selected, options.generic ?? false);

      throwIfAborted(options.signal);

      let result: ScrapeResult | null;
      if (route.kind === "preset") {
        const preset = route.preset;
        hint = preset.name;
        browserUsed = options.html === undefined || options.html === null;
        result = await withBrowserSignal(options.signal, () =>
          withBrowserProfile(options.browserProfile ?? preset.browser_profile, async () => {
            const autoRouteXStatus =
              !options.preset &&
              preset.source === "official" &&
              preset.name === "x-tweet" &&
              preset.mode === "content" &&
              preset.handler === "x.scrape_tweet" &&
              preset.schema === "TweetThread";

            if (autoRouteXStatus) {
              const captured = await captureXStatusPage(requested, options);
              let effectivePreset = preset;
              if (captured.kind === "article") {
                const articlePreset = registry.byName("x-article");
                if (
                  articlePreset?.source !== "official" ||
                  articlePreset.mode !== "content" ||
                  articlePreset.handler !== "x.scrape_article" ||
                  articlePreset.schema !== "XArticle"
                )
                  throw new PresetConfigError(
                    "automatic X status article routing requires the official x-article preset",
                  );
                effectivePreset = articlePreset;
              }
              hint = effectivePreset.name;
              const value = await scrapeCapturedXStatus(requested, captured, options);
              validateContentResult(value, effectivePreset);
              return value;
            }

            const value = await scrapeWithPreset(requested, preset, options);
            if (preset.mode === "content") validateContentResult(value, preset);
            return value;
          }),
        );
      } else if (route.kind === "generic") {
        hint = "generic-page";
        browserUsed = true;
        result = await withBrowserSignal(options.signal, () =>
          withBrowserProfile(options.browserProfile, async () =>
            scrapePage(requested, options.selector ?? "body", options),
          ),
        );
      } else if (route.kind === "github") {
        hint = "github";
        result = await fetchGithubIfApplicable(requested, options.signal);
      } else {
        hint = "direct-markdown";
        result = await directMarkdown(requested, options);
      }

      if (!result) throw new AgentscrapeRuntimeError("selected route returned no result");
      throwIfAborted(options.signal);
      finalUrl =
        validateProviderFinalUrl(result.final_url) ??
        (browserUsed && envelopeMode
          ? await browserFinalUrl(options.session, options.signal)
          : requested);

      if (envelopeMode) {
        const envelope = buildSuccessEnvelope(result, {
          requestedUrl: requested,
          finalUrl,
          implementationHint: hint,
          maxContentBytes,
          maxRelations,
        });
        if (options.destination)
          writeFileSync(options.destination, `${JSON.stringify(envelope, null, 2)}\n`);
        return envelope;
      }
      if (options.destination) writeArtifacts(options.destination, result);
      return result;
    } finally {
      if (!options.session && browserUsed) await closeSession();
    }
  } catch (error) {
    if (envelopeMode) {
      const envelope = buildFailureEnvelope(error, {
        requestedUrl: url,
        finalUrl,
        implementation: hint,
      });
      if (options.destination)
        writeFileSync(options.destination, `${JSON.stringify(envelope, null, 2)}\n`);
      return envelope;
    }
    if (error instanceof AgentscrapeError) throw error;
    const value = error instanceof Error ? error : new Error(String(error));
    if (/authentication required/i.test(value.message))
      throw new AgentscrapeAuthError(value.message);
    throw new AgentscrapeError(value.message);
  }
}

export interface FetchLinksOptions extends HandlerOptions {
  preset?: string | null | undefined;
  sectionSelector?: string | null | undefined;
  categorySelector?: string | null | undefined;
  toggleSelector?: string | null | undefined;
}
export async function fetchLinks(
  url: string,
  options: FetchLinksOptions = {},
): Promise<ScrapeResult<LinkList>> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
    throw new AgentscrapeError("--limit must be a positive integer", "usage");
  if (
    options.maxScrolls !== undefined &&
    (!Number.isInteger(options.maxScrolls) || options.maxScrolls < 1)
  )
    throw new AgentscrapeError("--max-scrolls must be a positive integer", "usage");
  if (options.sinceId !== undefined && options.sinceId !== null && !/^\d+$/.test(options.sinceId))
    throw new AgentscrapeError("--since-id must contain only digits", "usage");
  const timelineKeys: Array<[keyof HandlerOptions, string]> = [
    ["limit", "--limit"],
    ["maxScrolls", "--max-scrolls"],
    ["sinceId", "--since-id"],
    ["includeReplies", "--include-replies"],
    ["includeReposts", "--include-reposts"],
  ];
  const supplied = timelineKeys.find(
    ([key]) => options[key] !== undefined && options[key] !== false && options[key] !== null,
  );
  let result: ScrapeResult<LinkList> | ScrapeResult | null = null;
  let resolvedPreset: string | null = null;
  try {
    const registry = loadRegistry();
    const preset = options.preset
      ? registry.byName(options.preset)
      : !options.sectionSelector && !options.categorySelector
        ? matchPreset(url, registry.presets)
        : null;
    if (options.preset && !preset)
      throw new AgentscrapeError(`preset '${options.preset}' not found`, "usage");
    resolvedPreset = preset?.name ?? null;
    if (supplied && resolvedPreset !== "x-timeline")
      throw new AgentscrapeError(
        `${supplied[1]} is only valid with the x-timeline preset`,
        "usage",
      );
    result = await withBrowserSignal(options.signal, () =>
      withBrowserProfile(options.browserProfile ?? preset?.browser_profile, async () => {
        if (preset) return scrapeWithPreset(url, preset, options);
        let links: LinkItem[];
        if (options.sectionSelector && options.categorySelector)
          links = await scrapeNavLinks(
            url,
            options.sectionSelector,
            options.categorySelector,
            options.toggleSelector ?? undefined,
            options,
          );
        else if (options.sectionSelector || options.categorySelector)
          links = await scrapeLinks(
            url,
            options.sectionSelector ?? options.categorySelector!,
            options.toggleSelector ?? undefined,
            options,
          );
        else
          throw new AgentscrapeError(
            "provide --preset or at least one selector (--section-selector / --category-selector)",
            "usage",
          );
        const structured = new LinkList(links);
        return {
          full_html: "",
          selected_html: "",
          links,
          markdown: structured.toMarkdown(),
          structured,
        };
      }),
    );
  } finally {
    if (!options.session) await closeSession();
  }
  throwIfAborted(options.signal);
  if (!result.links)
    throw new AgentscrapeError(
      `preset '${resolvedPreset ?? "this"}' is a content-mode preset and emits no links; use fetch-markdown instead`,
      "usage",
    );
  return result as ScrapeResult<LinkList>;
}

export function convertHtml(html: string): string {
  return convertHtmlImpl(html);
}
export function extractStatusId(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}
export async function closeBrowserSession(name: string, signal?: AbortSignal): Promise<void> {
  await closeSession(name, signal);
}
export function submitScrapeJob(
  url: string,
  destination: string,
  options: {
    summarize?: boolean;
    frontmatter?: Record<string, unknown>;
    indexer?: string;
    source?: string;
  } = {},
): string {
  if (options.indexer !== undefined || options.source !== undefined)
    throw new Error(
      "indexed scrape queue submissions are frozen; use the dedicated ingestion command",
    );
  const queue = join(homedir(), ".local/share/agentscrape/queue");
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}.yaml`;
  const destinationPath = join(queue, name);
  const temporary = join(dirname(queue), `.${name}.tmp`);
  const job = {
    url,
    destination,
    ...(options.summarize ? { summarize: true } : {}),
    ...(options.frontmatter ? { frontmatter: options.frontmatter } : {}),
  };
  writeFileSync(temporary, stringifyYaml(job), { flag: "wx", mode: 0o600 });
  const fileDescriptor = openSync(temporary, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporary, destinationPath);
  const directoryDescriptor = openSync(queue, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return destinationPath;
}

export function envelopeExitCode(envelope: ExtractionEnvelope): number {
  return envelope.status === "failure" ? failureExitCode(envelope.failure!.failure_class) : 0;
}
export function structuredJson(result: ScrapeResult): unknown {
  return JSON.parse(JSON.stringify(result.structured)) as unknown;
}
export function structuredYaml(result: ScrapeResult): string {
  return stringifyYaml(structuredJson(result));
}
export type { ExtractionEnvelope, ScrapeResult };
export { ScrapeSchema };

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { prepareHtmlSidecars, writePreparedTextArtifacts } from "./artifacts";
import {
  closeSession,
  currentBrowserArtifactRetention,
  currentBrowserNetworkPolicy,
  requireAgentBrowserSuccess,
  resetBrowserUnavailableCache,
  runAgentBrowser,
  withBrowserArtifactRetention,
  withBrowserNetworkPolicy,
  withBrowserProfile,
  withBrowserSession,
  withBrowserSignal,
} from "./browser";
import { cssSelectorProblem } from "./css-selector";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  EnvelopeBuildError,
  failureExitCode,
  implementationHint,
  validateEnvelopeRequest,
  validateProviderFinalUrl,
  validateRequestUrl,
} from "./envelope";
import {
  AgentscrapeArtifactError,
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeHttpError,
  AgentscrapeNetworkPolicyError,
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
import { articlePresetNameFor, type ExtractorDefinition } from "./extractors";
import { scrapePage } from "./generic";
import { fetchGithubIfApplicable, isGithubUrl, parseGithubUrl } from "./github";
import type { HandlerOptions, ScrapeResult } from "./handlers/types";
import { captureXStatusPage, scrapeCapturedXStatus } from "./handlers/x";
import { convertHtml as convertHtmlImpl } from "./html";
import { scrapeLinks, scrapeNavLinks } from "./links";
import {
  NetworkPolicyFault,
  NetworkResolutionFault,
  type ResolvedAddress,
  resolveNetworkAddress,
} from "./network-policy";
import {
  PinnedHttpFault,
  type PinnedHttpResponse,
  pinnedHeader,
  pinnedHeaderValues,
  requestPinnedHttp,
} from "./pinned-http";
import {
  loadRegistry,
  matchPreset,
  resolveContentDefinition,
  scrapeWithPreset,
  selectPreset,
  validateContentResult,
} from "./presets";
import { resolveQueuePaths } from "./queue-paths";
import { sanitizeErrorInPlace } from "./redaction";
import { findExecutable, runProcess } from "./subprocess";

export {
  type ContentHandlerCapabilities,
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
  AgentscrapeArtifactError,
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeHttpError,
  AgentscrapeNetworkPolicyError,
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

const networkPolicyFailureEnvelopes = new WeakSet<ExtractionEnvelope>();

export interface FetchMarkdownOptions extends HandlerOptions {
  preset?: string | null | undefined;
  selector?: string | undefined;
  destination?: string | null | undefined;
  generic?: boolean | undefined;
  envelope?: boolean | undefined;
  maxContentBytes?: number | undefined;
  maxRelations?: number | undefined;
  signal?: AbortSignal | undefined;
  retainArtifacts?: boolean | undefined;
}

function isHttpTokenCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(character)
  );
}

function directMarkdownMimeAdmitted(fieldValues: readonly string[] | undefined): boolean {
  if (fieldValues?.length !== 1) return false;
  const input = fieldValues[0]!;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code > 0x7e || code === 0x7f || (code < 0x20 && code !== 0x09)) return false;
  }

  let offset = 0;
  const skipOws = () => {
    while (input[offset] === " " || input[offset] === "\t") offset += 1;
  };
  const token = (): string | null => {
    const start = offset;
    while (offset < input.length && isHttpTokenCharacter(input[offset]!)) offset += 1;
    return offset === start ? null : input.slice(start, offset);
  };
  const parameterValue = (): string | null => {
    if (input[offset] !== '"') return token();
    offset += 1;
    let decoded = "";
    while (offset < input.length) {
      const character = input[offset]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        offset += 1;
        return decoded;
      }
      if (character === "\\") {
        offset += 1;
        if (offset >= input.length) return null;
        const escaped = input[offset]!;
        const escapedCode = escaped.charCodeAt(0);
        if ((escapedCode < 0x20 && escapedCode !== 0x09) || escapedCode > 0x7e) return null;
        decoded += escaped;
        offset += 1;
        continue;
      }
      if ((code < 0x20 && code !== 0x09) || code > 0x7e) return null;
      decoded += character;
      offset += 1;
    }
    return null;
  };

  skipOws();
  const type = token();
  if (type?.toLowerCase() !== "text" || input[offset] !== "/") return false;
  offset += 1;
  const subtype = token();
  if (subtype?.toLowerCase() !== "markdown") return false;
  skipOws();

  const parameterNames = new Set<string>();
  while (offset < input.length) {
    if (input[offset] !== ";") return false;
    offset += 1;
    skipOws();
    const rawName = token();
    if (rawName === null) return false;
    const name = rawName.toLowerCase();
    if (parameterNames.has(name)) return false;
    parameterNames.add(name);
    skipOws();
    if (input[offset] !== "=") return false;
    offset += 1;
    skipOws();
    const value = parameterValue();
    if (value === null) return false;
    if (name === "charset" && value.toLowerCase() !== "utf-8") return false;
    skipOws();
  }
  return true;
}

function directMarkdownEncodingAdmitted(fieldValues: readonly string[] | undefined): boolean {
  if (fieldValues === undefined) return true;
  if (fieldValues.length !== 1) return false;
  const value = fieldValues[0]!;
  let start = 0;
  let end = value.length;
  while (value[start] === " " || value[start] === "\t") start += 1;
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end -= 1;
  return value.slice(start, end).toLowerCase() === "identity";
}

/** Exactly one `application/pdf` content-type, parameters ignored. */
function pdfMimeAdmitted(fieldValues: readonly string[] | undefined): boolean {
  if (fieldValues?.length !== 1) return false;
  const essence = fieldValues[0]!.split(";", 1)[0]!.trim().toLowerCase();
  return essence === "application/pdf";
}

/**
 * Convert PDF bytes to Markdown with pdftotext.
 *
 * A browser renders a PDF into a viewer with no extractable DOM, so the generic
 * route returns empty content for every PDF ever submitted. pdftotext reads the
 * document itself. `-layout` preserves column and table structure, which is
 * what makes the output readable rather than interleaved.
 *
 * The bytes go through a private temporary file, removed before returning:
 * stdin carries a string, and a PDF does not survive being decoded as text. A
 * PDF with no text layer — a scan — legitimately yields nothing, and that stays
 * empty_content rather than being dressed up as a failure of the extractor.
 */
async function pdfToMarkdown(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (!findExecutable("pdftotext"))
    throw new AgentscrapeUpstreamDownError(
      "pdftotext not found on PATH — install poppler to extract PDFs",
    );
  const root = await mkdtemp(join(tmpdir(), "agentscrape-pdf-"));
  try {
    await chmod(root, 0o700);
    const source = join(root, "document.pdf");
    await writeFile(source, bytes, { mode: 0o600 });
    const result = await runProcess(["pdftotext", "-layout", "-nopgbrk", source, "-"], {
      timeoutMs: 60_000,
      maxOutputBytes: 8_000_000,
      ...(signal ? { signal } : {}),
    });
    if (result.timedOut) throw new AgentscrapeTimeoutError("PDF text extraction timed out");
    if (result.truncated)
      throw new EnvelopeBuildError(
        "output_limit_exceeded",
        "PDF text exceeds the extraction limit",
      );
    if (result.exitCode !== 0)
      throw new AgentscrapeProviderError("pdftotext could not read the PDF", false);
    return result.stdout
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function directFetch(
  url: string,
  options: FetchMarkdownOptions,
  mode: "markdown" | "pdf" = "markdown",
): Promise<ScrapeResult<GenericPage>> {
  const label = mode === "pdf" ? "direct PDF" : "direct Markdown";
  const limit = options.maxContentBytes ?? 1_000_000;
  const requested = validateEnvelopeRequest(url, limit, 0);
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new DOMException(`${label} fetch timed out`, "TimeoutError")),
    30_000,
  );
  timer.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    let current = requested;
    for (let redirects = 0; ; redirects += 1) {
      throwIfAborted(options.signal);
      const currentUrl = new URL(current);
      let address: ResolvedAddress;
      try {
        address = await resolveNetworkAddress(currentUrl, {
          allowPrivateNetwork: currentBrowserNetworkPolicy(),
          signal,
        });
      } catch (error) {
        if (error instanceof NetworkPolicyFault)
          throw new AgentscrapeNetworkPolicyError("private_destination");
        if (error instanceof NetworkResolutionFault)
          throw new AgentscrapeProviderError(`${label} destination could not be resolved`, true);
        throw error;
      }
      let response: PinnedHttpResponse;
      let invalidContentEncoding = false;
      let invalidMarkdownMime = false;
      try {
        response = await requestPinnedHttp({
          url: currentUrl,
          address,
          method: "GET",
          headers: {
            "accept-encoding": "identity",
            connection: "close",
            "user-agent": "agentscrape/1.0",
          },
          maxResponseBytes: limit,
          signal,
          bodyPolicy: (metadata) => {
            invalidContentEncoding = !directMarkdownEncodingAdmitted(
              pinnedHeaderValues(metadata.pinnedHeaderValues, "content-encoding"),
            );
            const contentType = pinnedHeaderValues(metadata.pinnedHeaderValues, "content-type");
            invalidMarkdownMime =
              mode === "pdf"
                ? !pdfMimeAdmitted(contentType)
                : !directMarkdownMimeAdmitted(contentType);
            return invalidContentEncoding || invalidMarkdownMime ? "discard" : "read";
          },
        });
      } catch (error) {
        if (error instanceof PinnedHttpFault) {
          if (error.reason === "response_limit_exceeded")
            throw new EnvelopeBuildError(
              "output_limit_exceeded",
              `content exceeds the ${limit}-byte limit`,
            );
          throw new AgentscrapeProviderError(`${label} request failed`, true);
        }
        throw error;
      }
      throwIfAborted(options.signal);
      if (timeoutController.signal.aborted)
        throw new AgentscrapeTimeoutError(`${label} fetch timed out`);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = pinnedHeader(response.headers, "location");
        if (!location)
          throw new AgentscrapeHttpError(
            `${label} redirect has no Location header (HTTP ${response.status})`,
            response.status,
          );
        if (redirects >= 10)
          throw new AgentscrapeProviderError(`${label} redirect limit exceeded`, false);
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new EnvelopeBuildError(
            "malformed_provider_output",
            `${label} redirect URL is invalid`,
          );
        }
        const validated = validateProviderFinalUrl(next) ?? next;
        if (currentUrl.protocol === "https:" && new URL(validated).protocol !== "https:")
          throw new AgentscrapeProviderError(`${label} redirect to HTTP is not allowed`, false);
        current = validated;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        if ([401, 403].includes(response.status))
          throw new AgentscrapeAuthError(
            `${label} source requires authentication (HTTP ${response.status})`,
          );
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AgentscrapeHttpError(
          `${label} fetch failed (HTTP ${response.status})`,
          response.status,
          retryable,
        );
      }
      if (invalidContentEncoding)
        throw new AgentscrapeProviderError(
          `${label} response used an unsupported content encoding`,
          false,
        );
      if (invalidMarkdownMime)
        throw new AgentscrapeProviderError(
          `${label} response did not provide an admissible Markdown Content-Type`,
          false,
        );
      const finalUrl = validateProviderFinalUrl(current) ?? current;
      let markdown: string;
      if (mode === "pdf") {
        markdown = await pdfToMarkdown(response.body, options.signal);
      } else {
        try {
          markdown = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
        } catch {
          throw new EnvelopeBuildError(
            "malformed_provider_output",
            `${label} response is not valid UTF-8`,
          );
        }
      }
      const structured = new GenericPage(finalUrl, markdown);
      return {
        full_html: "",
        selected_html: "",
        markdown,
        structured,
        final_url: finalUrl,
      };
    }
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (timeoutController.signal.aborted)
      throw new AgentscrapeTimeoutError(`${label} fetch timed out`);
    if (error instanceof AgentscrapeError || error instanceof EnvelopeBuildError) throw error;
    throw new AgentscrapeProviderError(`${label} fetch failed at the network boundary`, true);
  } finally {
    clearTimeout(timer);
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
  requireAgentBrowserSuccess(result, "Failed to capture final URL");
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

type MarkdownRoute =
  | { kind: "preset"; preset: NonNullable<ReturnType<typeof selectPreset>> }
  | { kind: "generic" }
  | { kind: "github" }
  | { kind: "pdf" }
  | { kind: "markdown" };

function markdownRoute(
  url: string,
  preset: ReturnType<typeof selectPreset>,
  generic: boolean,
): MarkdownRoute {
  if (preset) return { kind: "preset", preset };
  if (generic) return { kind: "generic" };
  if (parseGithubUrl(url)) return { kind: "github" };
  if (new URL(url).pathname.endsWith(".pdf")) return { kind: "pdf" };
  if (new URL(url).pathname.endsWith(".md")) return { kind: "markdown" };
  return { kind: "generic" };
}

export async function fetchMarkdown(
  url: string,
  options: FetchMarkdownOptions = {},
): Promise<ScrapeResult | ExtractionEnvelope> {
  const rawRetainArtifacts = options.retainArtifacts;
  if (rawRetainArtifacts !== undefined && typeof rawRetainArtifacts !== "boolean")
    throw sanitizeErrorInPlace(
      new AgentscrapeUsageError("retainArtifacts must be a boolean when provided"),
    );
  const effectiveRetainArtifacts =
    rawRetainArtifacts === undefined ? currentBrowserArtifactRetention() : rawRetainArtifacts;
  const envelopeMode = options.envelope ?? false;
  if (effectiveRetainArtifacts && envelopeMode)
    throw sanitizeErrorInPlace(
      new AgentscrapeUsageError("retainArtifacts cannot be combined with envelope output"),
    );

  return withBrowserArtifactRetention(rawRetainArtifacts, async () => {
    const maxContentBytes = options.maxContentBytes ?? 1_000_000;
    const maxRelations = options.maxRelations ?? 256;
    let hint = implementationHint(url, options.preset);
    let finalUrl: string | null = null;
    let browserUsed = false;
    let envelopeDefinition: ExtractorDefinition | undefined;

    try {
      return await withBrowserNetworkPolicy(options.allowPrivateNetwork, () =>
        withBrowserSession(options.session, async () => {
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
            if (preset.mode !== "content")
              throw new AgentscrapeUsageError(
                `preset '${preset.name}' is not a content-mode preset; use fetchLinks instead`,
              );
            const definition = resolveContentDefinition(preset);
            if (!definition)
              throw new PresetConfigError(`Preset '${preset.name}' has no resolvable handler`);
            if (!definition.capabilities.markdown)
              throw new AgentscrapeUsageError(
                `preset '${preset.name}' does not support Markdown extraction`,
              );
            envelopeDefinition = definition;
            browserUsed =
              definition.capabilities.browser &&
              (options.html === undefined || options.html === null);
            result = await withBrowserSignal(options.signal, () =>
              withBrowserProfile(options.browserProfile ?? preset.browser_profile, async () => {
                const autoRouteXStatus =
                  !options.preset && definition.capabilities.xRole === "status";

                if (autoRouteXStatus) {
                  const captured = await captureXStatusPage(requested, options);
                  let effectivePreset = preset;
                  let effectiveDefinition = definition;
                  if (captured.kind === "article") {
                    const articlePresetName = articlePresetNameFor(definition);
                    const articlePreset = articlePresetName
                      ? registry.byName(articlePresetName)
                      : null;
                    const articleDefinition = articlePreset
                      ? resolveContentDefinition(articlePreset)
                      : null;
                    if (articleDefinition?.capabilities.xRole !== "article")
                      throw new PresetConfigError(
                        "automatic X status article routing requires the official x-article preset",
                      );
                    effectivePreset = articlePreset!;
                    effectiveDefinition = articleDefinition;
                  }
                  hint = effectivePreset.name;
                  envelopeDefinition = effectiveDefinition;
                  const value = await scrapeCapturedXStatus(requested, captured, options);
                  validateContentResult(value, effectivePreset);
                  return value;
                }

                const value = await scrapeWithPreset(requested, preset, options);
                validateContentResult(value, preset);
                return value;
              }),
            );
          } else if (route.kind === "generic") {
            hint = "generic-page";
            browserUsed = true;
            result = await withBrowserSignal(options.signal, () =>
              withBrowserProfile(options.browserProfile, async () =>
                scrapePage(requested, options.selector, options),
              ),
            );
            // A browser renders a PDF into a viewer with no extractable DOM, so
            // a PDF served without a .pdf path — arxiv.org/pdf/ID is the common
            // one — arrives here empty. Ask the network what it actually is
            // rather than reporting nothing for a document that has text. Only
            // an empty result triggers this, and only an application/pdf
            // content-type answers it, so a genuinely empty page stays empty.
            if (!result.markdown.trim()) {
              try {
                const asPdf = await directFetch(requested, options, "pdf");
                if (asPdf.markdown.trim()) {
                  hint = "pdf";
                  browserUsed = false;
                  result = asPdf;
                }
              } catch {
                // Not a PDF, or unreadable as one: keep the empty page result,
                // which reports empty_content exactly as before.
              }
            }
          } else if (route.kind === "github") {
            hint = "github";
            result = await fetchGithubIfApplicable(requested, options.signal);
          } else if (route.kind === "pdf") {
            hint = "pdf";
            result = await directFetch(requested, options, "pdf");
          } else {
            hint = "direct-markdown";
            result = await directFetch(requested, options);
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
              definition: envelopeDefinition,
            });
            if (options.destination)
              writeFileSync(options.destination, `${JSON.stringify(envelope, null, 2)}\n`);
            return envelope;
          }
          if (options.destination) {
            const sidecars = effectiveRetainArtifacts
              ? prepareHtmlSidecars(options.destination, result)
              : [];
            writeFileSync(options.destination, result.markdown);
            writePreparedTextArtifacts(sidecars);
          }
          return result;
        }),
      );
    } catch (error) {
      if (envelopeMode) {
        const envelope = buildFailureEnvelope(error, {
          requestedUrl: url,
          finalUrl,
          implementation: hint,
        });
        if (error instanceof AgentscrapeNetworkPolicyError)
          networkPolicyFailureEnvelopes.add(envelope);
        if (options.destination)
          writeFileSync(options.destination, `${JSON.stringify(envelope, null, 2)}\n`);
        return envelope;
      }
      if (error instanceof AgentscrapeError) throw sanitizeErrorInPlace(error);
      const value = sanitizeErrorInPlace(error);
      if (/authentication required/i.test(value.message))
        throw sanitizeErrorInPlace(new AgentscrapeAuthError(value.message));
      throw sanitizeErrorInPlace(new AgentscrapeError(value.message));
    }
  });
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
  let requested: string;
  try {
    requested = validateRequestUrl(url);
  } catch (error) {
    if (error instanceof EnvelopeBuildError && error.failureClass === "invalid_request")
      throw sanitizeErrorInPlace(new AgentscrapeUsageError(error.message));
    throw sanitizeErrorInPlace(error);
  }
  try {
    return await withBrowserArtifactRetention(false, () =>
      withBrowserNetworkPolicy(options.allowPrivateNetwork, () =>
        withBrowserSession(options.session, async () => {
          if (
            options.limit !== undefined &&
            (!Number.isInteger(options.limit) || options.limit < 1)
          )
            throw new AgentscrapeUsageError("--limit must be a positive integer");
          if (
            options.maxScrolls !== undefined &&
            (!Number.isInteger(options.maxScrolls) || options.maxScrolls < 1)
          )
            throw new AgentscrapeUsageError("--max-scrolls must be a positive integer");
          if (
            options.sinceId !== undefined &&
            options.sinceId !== null &&
            !/^\d+$/.test(options.sinceId)
          )
            throw new AgentscrapeUsageError("--since-id must contain only digits");
          const timelineKeys: Array<[keyof HandlerOptions, string]> = [
            ["limit", "--limit"],
            ["maxScrolls", "--max-scrolls"],
            ["sinceId", "--since-id"],
            ["includeReplies", "--include-replies"],
            ["includeReposts", "--include-reposts"],
          ];
          const supplied = timelineKeys.find(
            ([key]) =>
              options[key] !== undefined && options[key] !== false && options[key] !== null,
          );
          const hasCallerSelector = [
            options.sectionSelector,
            options.categorySelector,
            options.toggleSelector,
          ].some((selector) => selector !== undefined && selector !== null);
          if (options.preset !== undefined && options.preset !== null && hasCallerSelector)
            throw new AgentscrapeUsageError(
              "an explicit preset cannot be combined with caller selectors",
            );
          let result: ScrapeResult<LinkList> | ScrapeResult | null = null;
          let resolvedPreset: string | null = null;
          const registry = loadRegistry();
          const preset = options.preset
            ? registry.byName(options.preset)
            : !hasCallerSelector
              ? matchPreset(requested, registry.presets)
              : null;
          if (options.preset && !preset)
            throw new AgentscrapeUsageError(`preset '${options.preset}' not found`);
          resolvedPreset = preset?.name ?? null;
          const definition = preset?.mode === "content" ? resolveContentDefinition(preset) : null;
          if (preset?.mode === "content" && !definition)
            throw new PresetConfigError(`Preset '${preset.name}' has no resolvable handler`);
          if (preset?.mode === "content" && !definition?.capabilities.links)
            throw new AgentscrapeUsageError(
              `preset '${resolvedPreset}' is a content-mode preset and emits no links; use fetch-markdown instead`,
            );
          if (supplied && !definition?.capabilities.timelineOptions)
            throw new AgentscrapeUsageError(
              `${supplied[1]} is only valid with the x-timeline preset`,
            );
          for (const [label, selector] of [
            ["section selector", options.sectionSelector],
            ["category selector", options.categorySelector],
            ["toggle selector", options.toggleSelector],
          ] as const) {
            if (selector === undefined || selector === null) continue;
            const problem = cssSelectorProblem(selector);
            if (problem)
              throw new AgentscrapeUsageError(`Invalid ${label} '${selector}': ${problem}`);
          }
          result = await withBrowserSignal(options.signal, () =>
            withBrowserProfile(options.browserProfile ?? preset?.browser_profile, async () => {
              if (preset) return scrapeWithPreset(requested, preset, options);
              let links: LinkItem[];
              try {
                if (options.sectionSelector && options.categorySelector)
                  links = await scrapeNavLinks(
                    requested,
                    options.sectionSelector,
                    options.categorySelector,
                    options.toggleSelector ?? undefined,
                    options,
                  );
                else if (options.sectionSelector || options.categorySelector)
                  links = await scrapeLinks(
                    requested,
                    options.sectionSelector ?? options.categorySelector!,
                    options.toggleSelector ?? undefined,
                    options,
                  );
                else
                  throw new AgentscrapeUsageError(
                    "provide --preset or at least one selector (--section-selector / --category-selector)",
                  );
              } catch (error) {
                if (error instanceof PresetDriftError)
                  throw new AgentscrapeUsageError(error.message);
                throw error;
              }
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
          throwIfAborted(options.signal);
          if (!result.links)
            throw new AgentscrapeUsageError(
              `preset '${resolvedPreset ?? "this"}' is a content-mode preset and emits no links; use fetch-markdown instead`,
            );
          return result as ScrapeResult<LinkList>;
        }),
      ),
    );
  } catch (error) {
    throw sanitizeErrorInPlace(error);
  }
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
    allowPrivateNetwork?: boolean;
  } = {},
): string {
  if (options.indexer !== undefined || options.source !== undefined)
    throw new Error(
      "indexed scrape queue submissions are frozen; use the dedicated ingestion command",
    );
  if (options.allowPrivateNetwork !== undefined && typeof options.allowPrivateNetwork !== "boolean")
    throw new AgentscrapeUsageError("allowPrivateNetwork must be a boolean when provided");
  const queue = resolveQueuePaths().queue;
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}.yaml`;
  const destinationPath = join(queue, name);
  const temporary = join(dirname(queue), `.${name}.tmp`);
  const job = {
    url,
    destination,
    ...(options.summarize ? { summarize: true } : {}),
    ...(options.frontmatter ? { frontmatter: options.frontmatter } : {}),
    ...(options.allowPrivateNetwork !== undefined
      ? { allow_private_network: options.allowPrivateNetwork }
      : {}),
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
  if (networkPolicyFailureEnvelopes.has(envelope)) return 2;
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

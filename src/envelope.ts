import { createHash } from "node:crypto";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  type ErrorClass,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
} from "./errors";
import { EnvelopeBuildError, type ExtractorDefinition, projectScrapeResult } from "./extractors";
import type { ScrapeResult } from "./handlers/types";
import { isSecureHttpUrl, isSensitiveName, redactDiagnostic, redactUrl } from "./redaction";
import type { ExtractionEnvelope, FailureClass } from "./schemas";
import { AGENTSCRAPE_VERSION } from "./version";

export { EnvelopeBuildError } from "./extractors";

const MESSAGES: Record<FailureClass, string> = {
  invalid_request: "The extraction request is invalid.",
  authentication_required: "The source requires authentication.",
  upstream_unavailable: "An extraction dependency is unavailable.",
  timeout: "The extraction timed out.",
  browser_error: "The browser extraction failed.",
  provider_error: "The source provider failed.",
  malformed_provider_output: "The extractor returned an invalid result.",
  empty_content: "The extractor returned no usable content.",
  output_limit_exceeded: "The extraction exceeds its configured output limit.",
  cancelled: "The extraction was cancelled.",
  internal_error: "The extraction failed unexpectedly.",
};
const BASE_ERROR_MAPPING = {
  usage: ["invalid_request", false],
  auth: ["authentication_required", false],
  upstream: ["upstream_unavailable", true],
  selection: ["invalid_request", false],
  config: ["internal_error", false],
  output: ["malformed_provider_output", false],
  drift: ["malformed_provider_output", false],
  browser: ["browser_error", true],
  provider: ["provider_error", false],
  timeout: ["timeout", true],
  cancelled: ["cancelled", false],
  runtime: ["internal_error", false],
} as const satisfies Record<ErrorClass, readonly [FailureClass, boolean]>;

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    new URL(value);
    return redactUrl(value, 4096);
  } catch {
    return redactDiagnostic(value, 4096);
  }
}

export function validateRequestUrl(url: unknown): string {
  if (typeof url !== "string" || !url)
    throw new EnvelopeBuildError("invalid_request", "URL must be a non-empty string");
  if (new TextEncoder().encode(url).byteLength > 4096)
    throw new EnvelopeBuildError("invalid_request", "URL exceeds 4096 UTF-8 bytes");
  if (!isSecureHttpUrl(url))
    throw new EnvelopeBuildError(
      "invalid_request",
      "URL must be an absolute HTTP or HTTPS URL without credentials or embedded secrets",
    );
  return url;
}

export function validateEnvelopeRequest(
  url: unknown,
  maxContentBytes: unknown,
  maxRelations: unknown,
): string {
  const requested = validateRequestUrl(url);
  if (!Number.isInteger(maxContentBytes) || (maxContentBytes as number) < 1)
    throw new EnvelopeBuildError("invalid_request", "max content bytes must be a positive integer");
  if (!Number.isInteger(maxRelations) || (maxRelations as number) < 0)
    throw new EnvelopeBuildError("invalid_request", "max relations must be a non-negative integer");
  return requested;
}

export function validateProviderFinalUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096)
    throw new EnvelopeBuildError("malformed_provider_output", "extractor final URL is invalid");
  if (!isSecureHttpUrl(value)) {
    // Landing on a sign-in page is not malformed output: the redirect target
    // carries the OAuth state the secret check exists to keep out of the
    // envelope. Reporting that as malformed sends the caller looking for an
    // extractor defect instead of for the credentials the page wants.
    //
    // Only secret-looking *query* names qualify. Embedded userinfo or a secret
    // in the path is a credentialed URL, which is unsafe provider output
    // whatever produced it. The URL is never echoed in either case.
    if (isSignInRedirect(value))
      throw new EnvelopeBuildError(
        "authentication_required",
        "extraction landed on a sign-in redirect",
      );
    throw new EnvelopeBuildError("malformed_provider_output", "extractor final URL is invalid");
  }
  return value;
}

/**
 * True when the query or fragment is the only reason the URL was refused.
 *
 * A sign-in redirect carries its secret there — sometimes as a sensitive
 * parameter name, sometimes nested inside an innocuous one like `next`, which
 * is how v0.app arrives. Rather than restate the secret rules, this strips the
 * query and fragment and asks whether what remains would have been accepted.
 * Embedded userinfo or a secret in the path survives that strip and stays
 * malformed, because a credentialed URL is unsafe output whatever produced it.
 */
function isSignInRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (!url.search && !url.hash) return false;
  const stripped = new URL(url.toString());
  stripped.search = "";
  stripped.hash = "";
  return isSecureHttpUrl(stripped.toString());
}

export function buildSuccessEnvelope(
  result: ScrapeResult,
  options: {
    requestedUrl: string;
    finalUrl: string;
    implementationHint: string;
    maxContentBytes: number;
    maxRelations: number;
    definition?: ExtractorDefinition | undefined;
  },
): ExtractionEnvelope {
  validateEnvelopeRequest(options.requestedUrl, options.maxContentBytes, options.maxRelations);
  validateProviderFinalUrl(options.finalUrl);
  const projected = projectScrapeResult(result, {
    requestedUrl: options.requestedUrl,
    finalUrl: options.finalUrl,
    implementationHint: options.implementationHint,
    maxRelations: options.maxRelations,
    definition: options.definition,
  });
  if (!projected.content.trim())
    throw new EnvelopeBuildError("empty_content", "extracted content is empty");
  const bytes = new TextEncoder().encode(projected.content);
  if (bytes.byteLength > options.maxContentBytes)
    throw new EnvelopeBuildError(
      "output_limit_exceeded",
      `content is ${bytes.byteLength} bytes; limit is ${options.maxContentBytes} bytes`,
    );
  if (projected.relations.length > options.maxRelations)
    throw new EnvelopeBuildError(
      "output_limit_exceeded",
      `relation count is ${projected.relations.length}; limit is ${options.maxRelations}`,
    );
  return {
    schema_version: "1",
    status: "success",
    requested_url: safeUrl(options.requestedUrl),
    final_url: safeUrl(options.finalUrl),
    extractor: {
      name: "agentscrape",
      version: AGENTSCRAPE_VERSION,
      implementation: bounded(projected.implementation, 100),
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content: projected.content,
        size_bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
    metadata: projected.metadata,
    relations: projected.relations.map((target_url) => ({
      relation_type: "references" as const,
      target_url,
    })),
    failure: null,
  };
}

export function classifyFailure(error: unknown): [FailureClass, boolean, string] {
  const value = error instanceof Error ? error : new Error(String(error));
  if (value instanceof EnvelopeBuildError)
    return [value.failureClass, value.retryable, value.message];
  if (value instanceof AgentscrapeAuthError)
    return ["authentication_required", false, value.message];
  if (value instanceof AgentscrapeCancelledError) return ["cancelled", false, value.message];
  if (value instanceof AgentscrapeTimeoutError) return ["timeout", true, value.message];
  if (value instanceof AgentscrapeBrowserError)
    return ["browser_error", value.retryable, value.message];
  if (value instanceof AgentscrapeProviderError)
    return ["provider_error", value.retryable, value.message];
  if (value instanceof AgentscrapeUpstreamDownError)
    return ["upstream_unavailable", true, value.message];
  if (value instanceof PresetSelectionError) return ["invalid_request", false, value.message];
  if (value instanceof PresetConfigError) return ["internal_error", false, value.message];
  if (value instanceof PresetOutputError || value instanceof PresetDriftError)
    return ["malformed_provider_output", false, value.message];
  if (value instanceof AgentscrapeError) {
    const [failureClass, retryable] = BASE_ERROR_MAPPING[value.errorClass];
    return [failureClass, retryable, value.message];
  }
  if (value.name === "AbortError") return ["cancelled", false, value.message];
  if (value.name === "TimeoutError") return ["timeout", true, value.message];
  if (value instanceof SyntaxError || value instanceof URIError)
    return ["malformed_provider_output", false, value.message];
  if (/authentication required/i.test(value.message))
    return ["authentication_required", false, value.message];
  if (/cancelled|canceled|interrupted/i.test(value.message))
    return ["cancelled", false, value.message];
  if (/timed out|timeout/i.test(value.message)) return ["timeout", true, value.message];
  if (/upstream down|ECONN|network|fetch failed|rate limit/i.test(value.message))
    return ["upstream_unavailable", true, value.message];
  if (/browser|navigation|content not found|failed to open/i.test(value.message))
    return ["browser_error", true, value.message];
  return ["internal_error", false, value.message];
}

export function buildFailureEnvelope(
  error: unknown,
  options: { requestedUrl: unknown; finalUrl?: string | null; implementation: string },
): ExtractionEnvelope {
  const [failureClass, retryable, evidence] = classifyFailure(error);
  return {
    schema_version: "1",
    status: "failure",
    requested_url: safeUrl(options.requestedUrl),
    final_url: options.finalUrl ? safeUrl(options.finalUrl) : null,
    extractor: {
      name: "agentscrape",
      version: AGENTSCRAPE_VERSION,
      implementation: bounded(options.implementation || "unknown", 100),
      implementation_version: "1",
    },
    artifacts: [],
    metadata: null,
    relations: [],
    failure: {
      failure_class: failureClass,
      retryable,
      message: MESSAGES[failureClass],
      evidence: redactDiagnostic(evidence),
    },
  };
}

export function failureExitCode(failureClass: FailureClass): number {
  return failureClass === "authentication_required" ? 2 : failureClass === "cancelled" ? 130 : 1;
}

export function implementationHint(url: string, preset?: string | null): string {
  if (preset && /^[A-Za-z0-9_.-]{1,100}$/.test(preset)) return preset;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (["x.com", "twitter.com"].includes(host) && /\/(?:i\/)?articles?\/\d+/.test(parsed.pathname))
      return "x-article";
    if (["x.com", "twitter.com"].includes(host) && /\/status\/\d+/.test(parsed.pathname))
      return "x-tweet";
    if (["github.com", "gist.github.com"].includes(host)) return "github";
    if (parsed.pathname.endsWith(".md")) return "direct-markdown";
  } catch {
    return "unknown";
  }
  return "generic-page";
}

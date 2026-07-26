import { safeTransportUrl } from "./feed-url";
import {
  NetworkPolicyFault,
  NetworkResolutionFault,
  type NetworkResolver,
  type ResolvedAddress,
  resolveNetworkAddress,
} from "./network-policy";
import {
  PinnedHttpFault,
  type PinnedHttpRequestFactory,
  type PinnedHttpResponse,
  pinnedHeader,
  requestPinnedHttp,
} from "./pinned-http";
import type { FeedPageValidators } from "./schemas";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export interface FeedTransportRequest {
  url: string;
  maxResponseBytes: number;
  timeoutMilliseconds: number;
  acceptHtml?: boolean | undefined;
  conditional?:
    | {
        url: string;
        etag: string | null;
        lastModified: string | null;
      }
    | undefined;
  signal?: AbortSignal | undefined;
}

export interface FeedTransportResponse {
  url: string;
  status: number;
  content: string;
  contentType: string | null;
  contentEncoding: string | null;
  validators: FeedPageValidators;
  conditionalApplied: boolean;
}

export type FeedTransport = (request: FeedTransportRequest) => Promise<FeedTransportResponse>;
export interface FeedResolvedAddress extends ResolvedAddress {}
export type FeedResolver = NetworkResolver;
export type FeedRequestFactory = PinnedHttpRequestFactory;
export interface DirectFeedTransportDependencies {
  resolver?: FeedResolver | undefined;
  requestFactory?: FeedRequestFactory | undefined;
}

export class FeedTransportFault extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public stopReason = "transport_failure",
  ) {
    super(message);
    this.name = "FeedTransportFault";
  }
}

function safeHeader(value: string | null | undefined): string | null {
  return value &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code > 255;
    })
    ? value
    : null;
}

function abortFault(external: AbortSignal | undefined, timedOut: boolean): FeedTransportFault {
  return external?.aborted
    ? new FeedTransportFault("cancelled", "Feed discovery was cancelled.", false, "cancelled")
    : new FeedTransportFault(
        "timeout",
        timedOut ? "Feed discovery exceeded its overall timeout." : "Feed transport was aborted.",
        true,
        "timeout",
      );
}

async function resolvedAddress(
  url: URL,
  resolver: FeedResolver | undefined,
  signal: AbortSignal,
  fault: () => FeedTransportFault,
): Promise<FeedResolvedAddress> {
  try {
    return await resolveNetworkAddress(url, {
      ...(resolver ? { resolver } : {}),
      signal,
      allowPrivateNetwork: false,
    });
  } catch (error) {
    if (signal.aborted) throw fault();
    if (error instanceof NetworkPolicyFault)
      throw new FeedTransportFault(
        "unsafe_destination",
        "The feed destination resolved to a private or reserved address.",
        false,
        "policy",
      );
    if (error instanceof NetworkResolutionFault) {
      if (error.resolutionCause instanceof FeedTransportFault) throw error.resolutionCause;
      throw new FeedTransportFault(
        "network_error",
        error.reason === "no_addresses"
          ? "The feed host resolved to no addresses."
          : "The feed host could not be resolved.",
        true,
        "network_error",
      );
    }
    throw error;
  }
}

interface SingleResponse extends FeedTransportResponse {
  location: string | null;
}

async function requestOnce(
  url: URL,
  address: FeedResolvedAddress,
  input: FeedTransportRequest,
  conditional: FeedTransportRequest["conditional"],
  signal: AbortSignal,
  fault: () => FeedTransportFault,
  requestFactory: FeedRequestFactory | undefined,
): Promise<SingleResponse> {
  const headers: Record<string, string> = {
    accept: input.acceptHtml
      ? "application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, text/html;q=0.8, application/xhtml+xml;q=0.8, text/plain;q=0.5, application/octet-stream;q=0.2"
      : "application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, text/plain;q=0.5, application/octet-stream;q=0.2",
    "accept-encoding": "identity",
    connection: "close",
    "user-agent": "agentscrape/1.0",
  };
  if (conditional?.etag) headers["if-none-match"] = conditional.etag;
  if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
  let response: PinnedHttpResponse;
  try {
    response = await requestPinnedHttp(
      {
        url,
        address,
        method: "GET",
        headers,
        maxResponseBytes: input.maxResponseBytes,
        signal,
        bodyPolicy: ({ headers: responseHeaders }) => {
          const encoding = pinnedHeader(responseHeaders, "content-encoding");
          return encoding && encoding.trim().toLowerCase() !== "identity" ? "discard" : "read";
        },
      },
      requestFactory ? { requestFactory } : {},
    );
  } catch (error) {
    if (signal.aborted) throw fault();
    if (error instanceof PinnedHttpFault) {
      if (error.reason === "malformed_content_length")
        throw new FeedTransportFault(
          "malformed_response",
          "The feed response has an invalid Content-Length header.",
          false,
          "malformed_response",
        );
      if (error.reason === "response_limit_exceeded")
        throw new FeedTransportFault(
          "response_limit_exceeded",
          "A feed response exceeds the configured byte limit.",
          false,
          "response_limit",
        );
      if (error.reason === "response_aborted")
        throw new FeedTransportFault(
          "network_error",
          "The feed response ended unexpectedly.",
          true,
          "network_error",
        );
    }
    throw error;
  }
  const contentType = pinnedHeader(response.headers, "content-type");
  const contentEncoding = pinnedHeader(response.headers, "content-encoding");
  const responseValidators: FeedPageValidators = {
    etag: safeHeader(pinnedHeader(response.headers, "etag")),
    last_modified: safeHeader(pinnedHeader(response.headers, "last-modified")),
  };
  const readsBody =
    !REDIRECT_STATUSES.has(response.status) &&
    response.status !== 304 &&
    response.status >= 200 &&
    response.status < 300;
  if (readsBody && contentEncoding && contentEncoding.trim().toLowerCase() !== "identity")
    throw new FeedTransportFault(
      "unsupported_encoding",
      "Encoded feed responses are not accepted.",
      false,
      "unsupported_encoding",
    );
  let content = "";
  if (readsBody) {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      throw new FeedTransportFault(
        "invalid_utf8",
        "The feed response is not valid UTF-8.",
        false,
        "malformed_response",
      );
    }
  }
  return {
    url: url.href,
    status: response.status,
    content,
    contentType,
    contentEncoding,
    validators: responseValidators,
    conditionalApplied: Boolean(conditional && (conditional.etag || conditional.lastModified)),
    location: pinnedHeader(response.headers, "location"),
  };
}

export function createDirectFeedTransport(
  dependencies: DirectFeedTransportDependencies = {},
): FeedTransport {
  const resolver = dependencies.resolver;
  const requestFactory = dependencies.requestFactory;
  return async (input) => {
    const requested = safeTransportUrl(input.url);
    if (
      !requested ||
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 1 ||
      input.maxResponseBytes > 20_000_000 ||
      !Number.isFinite(input.timeoutMilliseconds) ||
      input.timeoutMilliseconds <= 0 ||
      input.timeoutMilliseconds > 300_000 ||
      (input.conditional !== undefined &&
        safeTransportUrl(input.conditional.url) !== input.conditional.url) ||
      (input.conditional?.etag !== null &&
        input.conditional?.etag !== undefined &&
        safeHeader(input.conditional.etag) === null) ||
      (input.conditional?.lastModified !== null &&
        input.conditional?.lastModified !== undefined &&
        safeHeader(input.conditional.lastModified) === null)
    )
      throw new FeedTransportFault(
        "transport_policy_violation",
        "The feed transport request violates its safety policy.",
        false,
        "policy",
      );
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, input.timeoutMilliseconds);
    timer.unref();
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutController.signal])
      : timeoutController.signal;
    const currentFault = () => abortFault(input.signal, timedOut);
    let current = requested;
    try {
      for (let redirects = 0; ; redirects += 1) {
        if (signal.aborted) throw currentFault();
        const currentUrl = new URL(current);
        const address = await resolvedAddress(currentUrl, resolver, signal, currentFault);
        const requestConditional =
          input.conditional?.url === current ? input.conditional : undefined;
        const response = await requestOnce(
          currentUrl,
          address,
          input,
          requestConditional,
          signal,
          currentFault,
          requestFactory,
        );
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        if (!response.location)
          throw new FeedTransportFault(
            "redirect_error",
            "The feed redirect has no valid Location header.",
            false,
            "redirect_error",
          );
        if (redirects >= MAX_REDIRECTS)
          throw new FeedTransportFault(
            "redirect_limit_exceeded",
            "The feed redirect limit was exceeded.",
            false,
            "redirect_limit",
          );
        const next = safeTransportUrl(response.location, current);
        if (!next || (currentUrl.protocol === "https:" && new URL(next).protocol !== "https:"))
          throw new FeedTransportFault(
            "unsafe_destination",
            "A feed redirect targets an unsafe destination or HTTPS downgrade.",
            false,
            "policy",
          );
        current = next;
      }
    } catch (error) {
      if (input.signal?.aborted) throw currentFault();
      if (timedOut) throw currentFault();
      if (error instanceof FeedTransportFault) throw error;
      throw new FeedTransportFault(
        "network_error",
        "The feed request failed at the network boundary.",
        true,
        "network_error",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

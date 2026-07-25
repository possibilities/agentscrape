import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { safeTransportUrl } from "./feed-url";
import type { FeedPageValidators } from "./schemas";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_HEADER_BYTES = 16_384;

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
export interface FeedResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type FeedResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly FeedResolvedAddress[]>;
export type FeedRequestFactory = (
  protocol: "http:" | "https:",
  options: https.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;
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

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
}

function ipv6Bytes(address: string): Uint8Array | null {
  if (address.includes("%") || address.split("::").length > 2) return null;
  let value = address.toLowerCase();
  const ipv4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4) {
    const number = ipv4Number(ipv4);
    if (number === null) return null;
    value = `${value.slice(0, -ipv4.length)}${((number >>> 16) & 0xffff).toString(16)}:${(
      number & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index]!, 16);
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function publicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const mapped =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return publicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
    return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0) return false;
  return true;
}

function publicAddress(address: string, family: number): boolean {
  return family === 4
    ? isIP(address) === 4 && publicIpv4(address)
    : family === 6 && isIP(address) === 6 && publicIpv6(address);
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

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0]! : null;
  return value ?? null;
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

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fault: () => FeedTransportFault,
): Promise<T> {
  if (signal.aborted) return Promise.reject(fault());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(fault());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function resolvedAddress(
  url: URL,
  resolver: FeedResolver,
  signal: AbortSignal,
  fault: () => FeedTransportFault,
): Promise<FeedResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  let addresses: readonly FeedResolvedAddress[];
  if (literalFamily) addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  else {
    try {
      addresses = await abortable(Promise.resolve(resolver(hostname, signal)), signal, fault);
    } catch (error) {
      if (error instanceof FeedTransportFault) throw error;
      throw new FeedTransportFault(
        "network_error",
        "The feed host could not be resolved.",
        true,
        "network_error",
      );
    }
  }
  if (!addresses.length)
    throw new FeedTransportFault(
      "network_error",
      "The feed host resolved to no addresses.",
      true,
      "network_error",
    );
  if (
    addresses.some(
      (entry) =>
        !entry ||
        ![4, 6].includes(entry.family) ||
        typeof entry.address !== "string" ||
        !publicAddress(entry.address, entry.family),
    )
  )
    throw new FeedTransportFault(
      "unsafe_destination",
      "The feed destination resolved to a private or reserved address.",
      false,
      "policy",
    );
  return addresses[0]!;
}

interface SingleResponse extends FeedTransportResponse {
  location: string | null;
}

function requestOnce(
  url: URL,
  address: FeedResolvedAddress,
  input: FeedTransportRequest,
  conditional: FeedTransportRequest["conditional"],
  signal: AbortSignal,
  fault: () => FeedTransportFault,
  requestFactory: FeedRequestFactory,
): Promise<SingleResponse> {
  return new Promise<SingleResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const fail = (error: unknown) => finish(() => reject(error));
    const headers: Record<string, string> = {
      accept: input.acceptHtml
        ? "application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, text/html;q=0.8, application/xhtml+xml;q=0.8, text/plain;q=0.5, application/octet-stream;q=0.2"
        : "application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, text/plain;q=0.5, application/octet-stream;q=0.2",
      "accept-encoding": "identity",
      connection: "close",
      host: url.host,
      "user-agent": "agentscrape/1.0",
    };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      ...(url.protocol === "https:" && isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
        ? { servername: url.hostname }
        : {}),
    };
    const request = requestFactory(url.protocol as "http:" | "https:", options, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = firstHeader(response.headers["content-type"]);
      const contentEncoding = firstHeader(response.headers["content-encoding"]);
      const location = firstHeader(response.headers.location);
      const responseValidators: FeedPageValidators = {
        etag: safeHeader(firstHeader(response.headers.etag)),
        last_modified: safeHeader(firstHeader(response.headers["last-modified"])),
      };
      const complete = (content: string) =>
        finish(() =>
          resolve({
            url: url.href,
            status,
            content,
            contentType,
            contentEncoding,
            validators: responseValidators,
            conditionalApplied: Boolean(
              conditional && (conditional.etag || conditional.lastModified),
            ),
            location,
          }),
        );
      if (REDIRECT_STATUSES.has(status) || status === 304 || status < 200 || status >= 300) {
        response.destroy();
        complete("");
        return;
      }
      if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
        response.destroy();
        fail(
          new FeedTransportFault(
            "unsupported_encoding",
            "Encoded feed responses are not accepted.",
            false,
            "unsupported_encoding",
          ),
        );
        return;
      }
      const rawLength = firstHeader(response.headers["content-length"]);
      if (rawLength !== null && !/^\d+$/.test(rawLength.trim())) {
        response.destroy();
        fail(
          new FeedTransportFault(
            "malformed_response",
            "The feed response has an invalid Content-Length header.",
            false,
            "malformed_response",
          ),
        );
        return;
      }
      const declaredLength = rawLength === null ? null : Number(rawLength);
      if (
        declaredLength !== null &&
        (!Number.isSafeInteger(declaredLength) || declaredLength > input.maxResponseBytes)
      ) {
        response.destroy();
        fail(
          new FeedTransportFault(
            "response_limit_exceeded",
            "A feed response exceeds the configured byte limit.",
            false,
            "response_limit",
          ),
        );
        return;
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (settled) return;
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (bytes.byteLength > input.maxResponseBytes - length) {
          response.destroy();
          fail(
            new FeedTransportFault(
              "response_limit_exceeded",
              "A feed response exceeds the configured byte limit.",
              false,
              "response_limit",
            ),
          );
          return;
        }
        chunks.push(bytes.slice());
        length += bytes.byteLength;
      });
      response.once("end", () => {
        if (settled) return;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          complete(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          fail(
            new FeedTransportFault(
              "invalid_utf8",
              "The feed response is not valid UTF-8.",
              false,
              "malformed_response",
            ),
          );
        }
      });
      response.once("error", fail);
      response.once("aborted", () =>
        fail(
          new FeedTransportFault(
            "network_error",
            "The feed response ended unexpectedly.",
            true,
            "network_error",
          ),
        ),
      );
    });
    const abort = () => request.destroy(fault());
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => fail(signal.aborted ? fault() : error));
    if (signal.aborted) abort();
    else request.end();
  });
}

const defaultRequestFactory: FeedRequestFactory = (protocol, options, callback) =>
  (protocol === "https:" ? https.request : http.request)(options, callback);

const defaultResolver: FeedResolver = async (hostname) => {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family as 4 | 6 }]
      : [],
  );
};

export function createDirectFeedTransport(
  dependencies: DirectFeedTransportDependencies = {},
): FeedTransport {
  const resolver = dependencies.resolver ?? defaultResolver;
  const requestFactory = dependencies.requestFactory ?? defaultRequestFactory;
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

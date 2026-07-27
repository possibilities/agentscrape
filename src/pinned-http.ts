import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import type { ResolvedAddress } from "./network-policy";
import { networkHostname } from "./network-policy";

export const DEFAULT_MAX_HEADER_BYTES = 16_384;

export type PinnedHttpMethod = "GET" | "HEAD";
export type PinnedHttpHeaders = ReadonlyMap<string, string>;
export type PinnedHttpHeaderValues = ReadonlyMap<string, readonly string[]>;
export type PinnedHttpRequestFactory = (
  protocol: "http:" | "https:",
  options: https.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export type PinnedHttpFaultReason =
  | "request_failed"
  | "response_aborted"
  | "malformed_content_length"
  | "response_limit_exceeded";

export class PinnedHttpFault extends Error {
  constructor(public readonly reason: PinnedHttpFaultReason) {
    super(
      reason === "response_aborted"
        ? "The HTTP response ended unexpectedly."
        : reason === "malformed_content_length"
          ? "The HTTP response has an invalid Content-Length header."
          : reason === "response_limit_exceeded"
            ? "The HTTP response exceeds its configured byte limit."
            : "The HTTP request failed at the network boundary.",
    );
    this.name = "PinnedHttpFault";
  }
}

export interface PinnedHttpResponseMetadata {
  status: number;
  headers: PinnedHttpHeaders;
  readonly pinnedHeaderValues: PinnedHttpHeaderValues;
}

export interface PinnedHttpRequestOptions {
  url: URL;
  address: ResolvedAddress;
  method: PinnedHttpMethod;
  headers?: Readonly<Record<string, string>> | undefined;
  maxResponseBytes: number;
  maxHeaderBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  bodyPolicy?: ((metadata: PinnedHttpResponseMetadata) => "read" | "discard") | undefined;
}

export interface PinnedHttpResponse extends PinnedHttpResponseMetadata {
  url: string;
  body: Uint8Array;
}

export interface PinnedHttpDependencies {
  requestFactory?: PinnedHttpRequestFactory | undefined;
}

function stableHeaders(input: http.IncomingHttpHeaders): PinnedHttpHeaders {
  const entries: Array<[string, string]> = [];
  for (const name of Object.keys(input).sort()) {
    const value = input[name];
    if (typeof value === "string") entries.push([name.toLowerCase(), value]);
    else if (Array.isArray(value) && value.length === 1)
      entries.push([name.toLowerCase(), value[0]!]);
  }
  return new Map(entries);
}

function stableHeaderValues(
  response: http.IncomingMessage,
  headers: PinnedHttpHeaders,
): PinnedHttpHeaderValues {
  const values = new Map<string, string[]>();
  if (Array.isArray(response.rawHeaders)) {
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index]!.toLowerCase();
      const existing = values.get(name);
      if (existing) existing.push(response.rawHeaders[index + 1]!);
      else values.set(name, [response.rawHeaders[index + 1]!]);
    }
  } else {
    for (const [name, value] of headers) values.set(name, [value]);
  }
  return new Map(
    [...values].map(([name, fieldValues]) => [name, Object.freeze(fieldValues.slice())] as const),
  );
}

export function pinnedHeader(headers: PinnedHttpHeaders, name: string): string | null {
  return headers.get(name.toLowerCase()) ?? null;
}

export function pinnedHeaderValues(
  headers: PinnedHttpHeaderValues,
  name: string,
): readonly string[] | undefined {
  return headers.get(name.toLowerCase());
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The HTTP operation was aborted.", "AbortError");
}

export const defaultPinnedHttpRequestFactory: PinnedHttpRequestFactory = (
  protocol,
  options,
  callback,
) => (protocol === "https:" ? https.request : http.request)(options, callback);

export function requestPinnedHttp(
  input: PinnedHttpRequestOptions,
  dependencies: PinnedHttpDependencies = {},
): Promise<PinnedHttpResponse> {
  const maxHeaderBytes = input.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  if (
    !["http:", "https:"].includes(input.url.protocol) ||
    !Number.isSafeInteger(input.maxResponseBytes) ||
    input.maxResponseBytes < 0 ||
    !Number.isSafeInteger(maxHeaderBytes) ||
    maxHeaderBytes < 1024 ||
    maxHeaderBytes > 1_000_000
  )
    return Promise.reject(new PinnedHttpFault("request_failed"));
  if (input.signal?.aborted) return Promise.reject(abortReason(input.signal));

  return new Promise<PinnedHttpResponse>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      callback();
    };
    const fail = (error: unknown) => finish(() => reject(error));
    const complete = (
      status: number,
      headers: PinnedHttpHeaders,
      pinnedHeaderValues: PinnedHttpHeaderValues,
      body: Uint8Array,
    ) => finish(() => resolve({ url: input.url.href, status, headers, pinnedHeaderValues, body }));
    const abort = () => {
      const error = input.signal
        ? abortReason(input.signal)
        : new PinnedHttpFault("request_failed");
      request?.destroy(error);
      fail(error);
    };

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {}))
      headers[name.toLowerCase()] = value;
    headers.host = input.url.host;

    const hostname = networkHostname(input.url);
    const options: https.RequestOptions = {
      protocol: input.url.protocol,
      hostname: input.address.address,
      family: input.address.family,
      port: input.url.port || undefined,
      method: input.method,
      path: `${input.url.pathname}${input.url.search}`,
      headers,
      agent: false,
      maxHeaderSize: maxHeaderBytes,
      ...(input.url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };

    try {
      const factory = dependencies.requestFactory ?? defaultPinnedHttpRequestFactory;
      request = factory(input.url.protocol as "http:" | "https:", options, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        const status = response.statusCode ?? 0;
        const responseHeaders = stableHeaders(response.headers);
        const responseHeaderValues = stableHeaderValues(response, responseHeaders);
        const mode =
          input.method === "HEAD" || status < 200 || status >= 300
            ? "discard"
            : (input.bodyPolicy?.({
                status,
                headers: responseHeaders,
                pinnedHeaderValues: responseHeaderValues,
              }) ?? "read");
        if (mode === "discard") {
          complete(status, responseHeaders, responseHeaderValues, new Uint8Array());
          response.destroy();
          return;
        }
        const rawLength = pinnedHeader(responseHeaders, "content-length");
        if (rawLength !== null && !/^\d+$/.test(rawLength.trim())) {
          fail(new PinnedHttpFault("malformed_content_length"));
          response.destroy();
          return;
        }
        const declaredLength = rawLength === null ? null : Number(rawLength);
        if (
          declaredLength !== null &&
          (!Number.isSafeInteger(declaredLength) || declaredLength > input.maxResponseBytes)
        ) {
          fail(new PinnedHttpFault("response_limit_exceeded"));
          response.destroy();
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
            fail(new PinnedHttpFault("response_limit_exceeded"));
            response.destroy();
            return;
          }
          chunks.push(bytes.slice());
          length += bytes.byteLength;
        });
        response.once("end", () => {
          if (settled) return;
          const body = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          complete(status, responseHeaders, responseHeaderValues, body);
        });
        response.once("error", () => fail(new PinnedHttpFault("request_failed")));
        response.once("aborted", () => fail(new PinnedHttpFault("response_aborted")));
      });
    } catch {
      fail(new PinnedHttpFault("request_failed"));
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", () =>
      fail(
        input.signal?.aborted ? abortReason(input.signal) : new PinnedHttpFault("request_failed"),
      ),
    );
    if (input.signal?.aborted) abort();
    else request.end();
  });
}

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { fetchMarkdown } from "../src/api";
import {
  isPublicNetworkAddress,
  NetworkPolicyFault,
  NetworkResolutionFault,
  type NetworkResolver,
  resolveNetworkAddress,
} from "../src/network-policy";
import {
  PinnedHttpFault,
  type PinnedHttpRequestFactory,
  pinnedHeader,
  pinnedHeaderValues,
  requestPinnedHttp,
} from "../src/pinned-http";
import type { ExtractionEnvelope } from "../src/schemas";

interface Script {
  status: number;
  headers?: Record<string, string>;
  rawHeaders?: string[];
  chunks?: Array<string | Uint8Array>;
  aborted?: boolean;
  afterCallback?: () => void;
}

function scriptedFactory(
  scripts: Script[],
  captures: RequestOptions[] = [],
): PinnedHttpRequestFactory {
  return (_protocol, options, callback) => {
    captures.push(options);
    const request = new EventEmitter() as ClientRequest;
    request.destroy = ((error?: Error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
      return request;
    }) as ClientRequest["destroy"];
    request.end = (() => {
      const script = scripts.shift();
      if (!script) {
        queueMicrotask(() => request.emit("error", new Error("unexpected request")));
        return request;
      }
      const stream = new PassThrough();
      const response = stream as unknown as IncomingMessage;
      response.statusCode = script.status;
      response.headers = script.headers ?? {};
      if (script.rawHeaders !== undefined) response.rawHeaders = script.rawHeaders;
      queueMicrotask(() => {
        callback(response);
        script.afterCallback?.();
        if (script.aborted) {
          response.emit("aborted");
          return;
        }
        for (const chunk of script.chunks ?? []) stream.write(chunk);
        stream.end();
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };
}

function addressUrl(address: string): URL {
  return new URL(`https://${address.includes(":") ? `[${address}]` : address}/resource`);
}

describe("network address policy", () => {
  test("rejects special IPv4, IPv6, and mapped ranges while accepting public addresses", async () => {
    const privateAddresses = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:0a00:1",
      "64:ff9b::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "fc00::1",
      "fe80::1",
      "ff00::1",
    ];
    for (const address of privateAddresses) {
      const family = address.includes(":") ? 6 : 4;
      expect(isPublicNetworkAddress(address, family), address).toBeFalse();
      await expect(resolveNetworkAddress(addressUrl(address))).rejects.toMatchObject({
        reason: "private_destination",
      });
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      const family = address.includes(":") ? 6 : 4;
      expect(isPublicNetworkAddress(address, family), address).toBeTrue();
      await expect(resolveNetworkAddress(addressUrl(address))).resolves.toMatchObject({
        address,
        family,
      });
    }
  });

  test("requires every DNS answer to be valid and public unless explicitly unrestricted", async () => {
    const url = new URL("https://policy.test/path");
    await expect(
      resolveNetworkAddress(url, {
        resolver: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyFault);
    await expect(resolveNetworkAddress(url, { resolver: async () => [] })).rejects.toMatchObject({
      reason: "no_addresses",
    });
    await expect(
      resolveNetworkAddress(url, {
        resolver: async () => [{ address: "not-an-address", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyFault);

    await expect(
      resolveNetworkAddress(url, {
        allowPrivateNetwork: true,
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).resolves.toEqual({ address: "127.0.0.1", family: 4 });
    await expect(
      resolveNetworkAddress(url, {
        allowPrivateNetwork: true,
        resolver: async () => [{ address: "not-an-address", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(NetworkResolutionFault);
    await expect(
      resolveNetworkAddress(url, {
        allowPrivateNetwork: "true" as unknown as boolean,
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyFault);
  });

  test("passes cancellation to an injectable resolver and gives cancellation precedence", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const resolver: NetworkResolver = (_hostname, signal) => {
      observed = signal;
      return new Promise(() => undefined);
    };
    const pending = resolveNetworkAddress(new URL("https://held.test"), {
      resolver,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toBe(controller.signal);
  });
});

describe("pinned one-hop HTTP", () => {
  test("dials the selected address while retaining Host, HTTPS SNI, and bounded options", async () => {
    const captures: RequestOptions[] = [];
    const response = await requestPinnedHttp(
      {
        url: new URL("https://origin.test:8443/a?b=1"),
        address: { address: "8.8.8.8", family: 4 },
        method: "GET",
        headers: { "user-agent": "test", host: "attacker.invalid" },
        maxResponseBytes: 10,
      },
      {
        requestFactory: scriptedFactory(
          [{ status: 200, headers: { "content-type": "text/plain" }, chunks: ["hello"] }],
          captures,
        ),
      },
    );
    expect(new TextDecoder().decode(response.body)).toBe("hello");
    expect(pinnedHeader(response.headers, "Content-Type")).toBe("text/plain");
    expect(captures[0]).toMatchObject({
      hostname: "8.8.8.8",
      family: 4,
      port: "8443",
      path: "/a?b=1",
      servername: "origin.test",
      agent: false,
      maxHeaderSize: 16384,
    });
    expect((captures[0]!.headers as Record<string, string>).host).toBe("origin.test:8443");
  });

  test("preserves raw duplicate field lines and derives fake-message fallback values", async () => {
    const duplicate = await requestPinnedHttp(
      {
        url: new URL("https://origin.test/resource"),
        address: { address: "8.8.8.8", family: 4 },
        method: "GET",
        maxResponseBytes: 10,
      },
      {
        requestFactory: scriptedFactory([
          {
            status: 200,
            headers: {
              "content-type": "text/markdown, text/plain",
              "content-encoding": "identity, gzip",
            },
            rawHeaders: [
              "Content-Type",
              "text/markdown",
              "CONTENT-TYPE",
              "text/plain",
              "Content-Encoding",
              "identity",
              "content-encoding",
              "gzip",
            ],
          },
        ]),
      },
    );
    expect(pinnedHeaderValues(duplicate.pinnedHeaderValues, "Content-Type")).toEqual([
      "text/markdown",
      "text/plain",
    ]);
    expect(pinnedHeaderValues(duplicate.pinnedHeaderValues, "Content-Encoding")).toEqual([
      "identity",
      "gzip",
    ]);

    const fallback = await requestPinnedHttp(
      {
        url: new URL("https://origin.test/resource"),
        address: { address: "8.8.8.8", family: 4 },
        method: "GET",
        maxResponseBytes: 10,
      },
      {
        requestFactory: scriptedFactory([
          { status: 200, headers: { "X-Test": "stable" }, chunks: ["ok"] },
        ]),
      },
    );
    expect(fallback.pinnedHeaderValues.get("x-test")).toEqual(["stable"]);
  });

  test("body policy sees per-line values and discards before length or body limits", async () => {
    let observedValues: readonly string[] | undefined;
    const response = await requestPinnedHttp(
      {
        url: new URL("https://origin.test/resource"),
        address: { address: "8.8.8.8", family: 4 },
        method: "GET",
        maxResponseBytes: 1,
        bodyPolicy: (value) => {
          observedValues = value.pinnedHeaderValues.get("content-type");
          return "discard";
        },
      },
      {
        requestFactory: scriptedFactory([
          {
            status: 200,
            headers: { "content-length": "invalid" },
            rawHeaders: ["Content-Type", "text/plain", "Content-Type", "text/markdown"],
            chunks: ["far too large"],
          },
        ]),
      },
    );
    expect(observedValues).toEqual(["text/plain", "text/markdown"]);
    expect(response.body.byteLength).toBe(0);
  });

  test("rejects malformed Content-Length and aborted responses with focused faults", async () => {
    const request = (script: Script) =>
      requestPinnedHttp(
        {
          url: new URL("https://origin.test/resource"),
          address: { address: "8.8.8.8", family: 4 },
          method: "GET",
          maxResponseBytes: 10,
        },
        { requestFactory: scriptedFactory([script]) },
      );
    await expect(request({ status: 200, headers: { "content-length": "1x" } })).rejects.toEqual(
      new PinnedHttpFault("malformed_content_length"),
    );
    await expect(request({ status: 200, aborted: true })).rejects.toEqual(
      new PinnedHttpFault("response_aborted"),
    );
  });

  test("explicit abort takes precedence over a simultaneous response abort", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const pending = requestPinnedHttp(
      {
        url: new URL("https://origin.test/resource"),
        address: { address: "8.8.8.8", family: 4 },
        method: "GET",
        maxResponseBytes: 10,
        signal: controller.signal,
      },
      {
        requestFactory: scriptedFactory([
          {
            status: 200,
            aborted: true,
            afterCallback: () => controller.abort(reason),
          },
        ]),
      },
    );
    await expect(pending).rejects.toBe(reason);
  });

  test("HEAD returns zero bytes and never follows a redirect", async () => {
    const scripts = [
      {
        status: 302,
        headers: { location: "https://elsewhere.test/final" },
        chunks: ["ignored"],
      },
    ];
    const response = await requestPinnedHttp(
      {
        url: new URL("https://short.test/link"),
        address: { address: "8.8.8.8", family: 4 },
        method: "HEAD",
        maxResponseBytes: 0,
      },
      { requestFactory: scriptedFactory(scripts) },
    );
    expect(response.status).toBe(302);
    expect(response.body.byteLength).toBe(0);
    expect(pinnedHeader(response.headers, "location")).toBe("https://elsewhere.test/final");
    expect(scripts).toHaveLength(0);
  });

  test("re-resolves each hop and denies private rebinding before a second socket", async () => {
    const scripts = [
      { status: 302, headers: { location: "https://rebind.test/final" } },
      { status: 200, chunks: ["must not run"] },
    ];
    const captures: RequestOptions[] = [];
    let resolutions = 0;
    const resolver: NetworkResolver = async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };
    let current = new URL("https://rebind.test/start");
    const firstAddress = await resolveNetworkAddress(current, { resolver });
    const first = await requestPinnedHttp(
      {
        url: current,
        address: firstAddress,
        method: "GET",
        maxResponseBytes: 100,
      },
      { requestFactory: scriptedFactory(scripts, captures) },
    );
    current = new URL(pinnedHeader(first.headers, "location")!, current);
    await expect(resolveNetworkAddress(current, { resolver })).rejects.toBeInstanceOf(
      NetworkPolicyFault,
    );
    expect(resolutions).toBe(2);
    expect(captures).toHaveLength(1);
    expect(scripts).toHaveLength(1);
  });
});

describe("direct Markdown network policy", () => {
  test("rejects private initial destinations before a socket and allows explicit pinned loopback", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response("# Loopback", {
          headers: { "content-type": "text/markdown" },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/page.md`;
      const denied = (await fetchMarkdown(url, { envelope: true })) as ExtractionEnvelope;
      expect(denied.failure).toMatchObject({ failure_class: "invalid_request", retryable: false });
      expect(requests).toBe(0);
      const allowed = await fetchMarkdown(url, { allowPrivateNetwork: true });
      expect(allowed).toMatchObject({ markdown: "# Loopback", final_url: url });
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("revalidates a private redirect under explicit consent and retains the final URL", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests += 1;
        return new URL(request.url).pathname === "/start.md"
          ? new Response(null, { status: 302, headers: { location: "/final.md" } })
          : new Response("# Final", { headers: { "content-type": "text/markdown" } });
      },
    });
    try {
      const finalUrl = `http://127.0.0.1:${server.port}/final.md`;
      const result = await fetchMarkdown(`http://127.0.0.1:${server.port}/start.md`, {
        allowPrivateNetwork: true,
      });
      expect(result).toMatchObject({ markdown: "# Final", final_url: finalUrl });
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

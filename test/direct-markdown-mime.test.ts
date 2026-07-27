import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import {
  AgentscrapeHttpError,
  AgentscrapeProviderError,
  fetchMarkdown,
  type ScrapeResult,
} from "../src/api";
import type { ExtractionEnvelope } from "../src/schemas";

type RawReply = {
  status?: number;
  headers?: string[];
  body?: string | Uint8Array;
};

async function rawServer(handler: (path: string) => RawReply): Promise<{
  url: (path: string) => string;
  requests: string[];
  stop: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const boundary = request.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const firstLine = request.subarray(0, boundary).toString("ascii").split("\r\n")[0]!;
      const path = firstLine.split(" ")[1] ?? "/";
      requests.push(request.subarray(0, boundary).toString("latin1"));
      const reply = handler(path);
      const status = reply.status ?? 200;
      let body: Buffer;
      if (typeof reply.body === "string") body = Buffer.from(reply.body);
      else body = Buffer.from(reply.body ?? new Uint8Array());
      const headers = [...(reply.headers ?? [])];
      if (!headers.some((line) => /^content-length:/i.test(line)))
        headers.push(`Content-Length: ${body.byteLength}`);
      headers.push("Connection: close");
      const reason =
        status === 200
          ? "OK"
          : status === 302
            ? "Found"
            : status === 304
              ? "Not Modified"
              : "Error";
      socket.write(`HTTP/1.1 ${status} ${reason}\r\n${headers.join("\r\n")}\r\n\r\n`);
      socket.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function expectFixedProviderFailure(
  request: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await request;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AgentscrapeProviderError);
  expect(failure).not.toBeInstanceOf(AgentscrapeHttpError);
  expect(failure).toMatchObject({ message, retryable: false });
}

const markdownMimeFailure =
  "direct Markdown response did not provide an admissible Markdown Content-Type";
const encodingFailure = "direct Markdown response used an unsupported content encoding";

describe("direct Markdown MIME admission", () => {
  test("accepts exact Markdown media types, strict parameters, and empty bodies", async () => {
    const cases: Array<[string, string, string]> = [
      ["case.md", "TeXt/MaRkDoWn", "case"],
      ["ows.md", "\ttext/markdown \t;\tcharset\t=\tutf-8\t", "ows"],
      ["quoted.md", 'text/markdown; CHARSET="UtF\\-8"', "quoted"],
      [
        "extras.md",
        'text/markdown; note="comma, and escaped \\" quote"; version=v1; charset=UTF-8',
        "extras",
      ],
      ["quoted-tabs.md", 'text/markdown; note="raw\tand\\\tescaped"', "tabs"],
      ["absent.md", "text/markdown", "absent"],
      ["empty.md", 'text/markdown; empty=""', ""],
    ];
    const server = await rawServer((path) => {
      const entry = cases.find(([name]) => path === `/${name}`)!;
      return { headers: [`Content-Type: ${entry[1]}`], body: entry[2] };
    });
    try {
      for (const [name, , body] of cases) {
        const result = (await fetchMarkdown(server.url(`/${name}`), {
          allowPrivateNetwork: true,
        })) as ScrapeResult;
        expect(result.markdown, name).toBe(body);
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects missing, duplicate, aliased, malformed, and non-UTF-8 media types", async () => {
    const cases: Array<[string, string[]]> = [
      ["missing", []],
      ["duplicate-same", ["Content-Type: text/markdown", "Content-Type: text/markdown"]],
      ["duplicate-conflict", ["Content-Type: text/markdown", "Content-Type: text/plain"]],
      ["comma-list", ["Content-Type: text/markdown, text/markdown"]],
      ["plain", ["Content-Type: text/plain"]],
      ["x-markdown", ["Content-Type: text/x-markdown"]],
      ["application", ["Content-Type: application/markdown"]],
      ["html", ["Content-Type: text/html"]],
      ["json", ["Content-Type: application/json"]],
      ["xml", ["Content-Type: application/xml"]],
      ["binary", ["Content-Type: application/octet-stream"]],
      ["utf8", ["Content-Type: text/markdown; charset=utf8"]],
      ["ascii", ["Content-Type: text/markdown; charset=us-ascii"]],
      ["iso", ["Content-Type: text/markdown; charset=ISO-8859-1"]],
      ["empty-charset", ['Content-Type: text/markdown; charset=""']],
      ["duplicate-param", ["Content-Type: text/markdown; a=1; A=2"]],
      ["duplicate-charset", ["Content-Type: text/markdown; charset=utf-8; CHARSET=UTF-8"]],
      ["unterminated", ['Content-Type: text/markdown; note="open']],
      ["separator", ["Content-Type: text/markdown; note=a/b"]],
      ["unquoted-comma", ["Content-Type: text/markdown; note=a,b"]],
      ["empty-param", ["Content-Type: text/markdown; =value"]],
      ["trailing-param", ["Content-Type: text/markdown;"]],
      ["trailing-junk", ["Content-Type: text/markdown junk"]],
      ["non-ascii", ["Content-Type: text/markdown; note=é"]],
    ];
    const server = await rawServer((path) => ({
      headers: cases.find(([name]) => path === `/${name}.md`)![1],
      body: "hostile",
    }));
    try {
      for (const [name] of cases)
        await expectFixedProviderFailure(
          fetchMarkdown(server.url(`/${name}.md`), { allowPrivateNetwork: true }),
          markdownMimeFailure,
        );
    } finally {
      await server.stop();
    }
  });

  test("uses raw Content-Encoding field lines and admits only zero or one identity", async () => {
    const cases: Array<[string, string[]]> = [
      ["duplicate", ["Content-Encoding: identity", "Content-Encoding: identity"]],
      ["comma", ["Content-Encoding: identity, identity"]],
      ["gzip", ["Content-Encoding: gzip"]],
    ];
    const server = await rawServer((path) => {
      if (path === "/identity.md")
        return {
          headers: ["Content-Type: text/markdown", "Content-Encoding: \tIDentity "],
          body: "identity",
        };
      return {
        headers: [
          "Content-Type: text/markdown",
          ...cases.find(([name]) => path === `/${name}.md`)![1],
        ],
        body: "ignored",
      };
    });
    try {
      for (const [name] of cases)
        await expectFixedProviderFailure(
          fetchMarkdown(server.url(`/${name}.md`), { allowPrivateNetwork: true }),
          encodingFailure,
        );
      const identity = (await fetchMarkdown(server.url("/identity.md"), {
        allowPrivateNetwork: true,
      })) as ScrapeResult;
      expect(identity.markdown).toBe("identity");
    } finally {
      await server.stop();
    }
  });

  test("ignores redirect MIME and enforces only the extension-independent final response", async () => {
    const server = await rawServer((path) => {
      if (path === "/bad-redirect.md")
        return {
          status: 302,
          headers: ["Location: /good-final", "Content-Type: text/plain"],
        };
      if (path === "/missing-redirect.md")
        return { status: 302, headers: ["Location: /good-final"] };
      if (path === "/good-redirect.md")
        return {
          status: 302,
          headers: ["Location: /bad-final", "Content-Type: text/markdown"],
        };
      if (path === "/good-final")
        return { headers: ["Content-Type: text/markdown"], body: "final" };
      return { headers: ["Content-Type: text/plain"], body: "not markdown" };
    });
    try {
      for (const path of ["/bad-redirect.md", "/missing-redirect.md"]) {
        const result = (await fetchMarkdown(server.url(path), {
          allowPrivateNetwork: true,
        })) as ScrapeResult;
        expect(result).toMatchObject({ markdown: "final", final_url: server.url("/good-final") });
      }
      await expectFixedProviderFailure(
        fetchMarkdown(server.url("/good-redirect.md"), { allowPrivateNetwork: true }),
        markdownMimeFailure,
      );
    } finally {
      await server.stop();
    }
  });

  test("keeps status precedence for 304 and sends no validator or probe request", async () => {
    const server = await rawServer(() => ({ status: 304, headers: ["Content-Type: text/plain"] }));
    try {
      let failure: unknown;
      try {
        await fetchMarkdown(server.url("/cached.md"), { allowPrivateNetwork: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AgentscrapeHttpError);
      expect(failure).toMatchObject({ status: 304 });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.toLowerCase()).not.toContain("if-none-match");
      expect(server.requests[0]!.toLowerCase()).not.toContain("if-modified-since");
    } finally {
      await server.stop();
    }
  });

  test("does not let nosniff rescue a missing or wrong media type", async () => {
    const server = await rawServer((path) => ({
      headers: [
        ...(path === "/wrong.md" ? ["Content-Type: text/plain"] : []),
        "X-Content-Type-Options: nosniff",
      ],
      body: "# Looks like Markdown",
    }));
    try {
      for (const path of ["/missing.md", "/wrong.md"])
        await expectFixedProviderFailure(
          fetchMarkdown(server.url(path), { allowPrivateNetwork: true }),
          markdownMimeFailure,
        );
    } finally {
      await server.stop();
    }
  });

  test("preserves UTF-8 and size failures after valid MIME admission", async () => {
    const server = await rawServer((path) => ({
      headers: ["Content-Type: text/markdown"],
      body: path === "/utf8.md" ? new Uint8Array([0xff]) : "12345",
    }));
    try {
      const malformed = (await fetchMarkdown(server.url("/utf8.md"), {
        envelope: true,
        allowPrivateNetwork: true,
      })) as ExtractionEnvelope;
      expect(malformed.failure?.failure_class).toBe("malformed_provider_output");

      const oversized = (await fetchMarkdown(server.url("/large.md"), {
        envelope: true,
        maxContentBytes: 4,
        allowPrivateNetwork: true,
      })) as ExtractionEnvelope;
      expect(oversized.failure?.failure_class).toBe("output_limit_exceeded");
    } finally {
      await server.stop();
    }
  });

  test("discards MIME-invalid huge and malformed bodies before body validation", async () => {
    const server = await rawServer((path) => ({
      headers: ["Content-Type: text/plain"],
      body: path === "/invalid-utf8.md" ? new Uint8Array([0xff]) : "x".repeat(10_000),
    }));
    try {
      for (const path of ["/invalid-utf8.md", "/huge.md"]) {
        const envelope = (await fetchMarkdown(server.url(path), {
          envelope: true,
          maxContentBytes: 1,
          allowPrivateNetwork: true,
        })) as ExtractionEnvelope;
        expect(envelope.failure).toMatchObject({
          failure_class: "provider_error",
          retryable: false,
        });
      }
    } finally {
      await server.stop();
    }
  });

  test("accepts empty plain output while envelope mode classifies it as empty content", async () => {
    const server = await rawServer(() => ({ headers: ["Content-Type: text/markdown"] }));
    try {
      const plain = (await fetchMarkdown(server.url("/plain.md"), {
        allowPrivateNetwork: true,
      })) as ScrapeResult;
      expect(plain.markdown).toBe("");
      const envelope = (await fetchMarkdown(server.url("/envelope.md"), {
        envelope: true,
        allowPrivateNetwork: true,
      })) as ExtractionEnvelope;
      expect(envelope.failure?.failure_class).toBe("empty_content");
    } finally {
      await server.stop();
    }
  });
});

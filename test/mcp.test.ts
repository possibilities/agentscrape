/**
 * The generated MCP surface.
 *
 * Two halves, and both matter. The mapping is checked in process against
 * `mcp-tools.ts` — what becomes a tool, what is suppressed, and how each
 * constraint lands in the schema. Then a real `agentscrape mcp` is spawned and
 * driven over stdio by a real MCP client: initialize, tools/list, tools/call. A
 * mapping that is only unit-tested is a mapping that has never once been spoken
 * to.
 *
 * Every call made here is offline. Agentscrape's fetching commands are the
 * product, and this suite is hermetic, so the round trip exercises the local
 * routes — which is also the honest test of the dispatch path, since a fetch
 * would prove the network rather than the mapping.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { buildContract, type ContractCommand } from "../src/contract";
import {
  type AgentTool,
  ANNOTATION_EXCEPTIONS,
  agentTools,
  argvFor,
  type ContractDocument,
  serverInstructions,
} from "../src/mcp-tools";

const root = join(import.meta.dir, "..");
const CLI = join(root, "src/cli.ts");
const DOCUMENT = buildContract() as ContractDocument;
const TOOLS = agentTools(DOCUMENT);

function tool(name: string): AgentTool {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** The advertised JSON Schema, as a host sees it after the SDK converts. */
function schemaOf(name: string): Record<string, any> {
  return z.toJSONSchema(tool(name).input, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    any
  >;
}

const named = (name: string): ContractCommand =>
  DOCUMENT.commands.find((command) => command.name === name)!;

describe("which commands become tools", () => {
  test("exactly the agent commands, and every one of them", () => {
    const wanted = DOCUMENT.commands
      .filter((command) => command.audience === "agent")
      .map((command) => command.name);
    expect(TOOLS.map((candidate) => candidate.name)).toEqual(wanted);
    expect(wanted).toEqual([
      "fetch-markdown",
      "fetch-links",
      "discover-feed",
      "list-presets",
      "show-preset",
      "convert-html",
      "guide",
    ]);
  });

  test("no operator or internal command is exposed, mcp included", () => {
    const exposed = new Set(TOOLS.map((candidate) => candidate.name));
    const hidden = DOCUMENT.commands.filter((command) => command.audience !== "agent");
    // The corpus, canary, preset-authoring, session, and service commands are
    // the operator's and the machine's; none of them is a model's to call.
    expect(hidden.map((command) => command.name)).toEqual([
      "validate-preset",
      "capture-corpus",
      "test-corpus",
      "check-presets",
      "open-session",
      "close-session",
      "process-queue",
      "mcp",
      "doctor",
      "help",
    ]);
    for (const command of hidden) expect(exposed.has(command.name)).toBe(false);
  });

  test("mcp declares itself internal, mutating, and blocking", () => {
    expect(named("mcp")).toMatchObject({ audience: "internal", mutates: true, blocking: true });
  });

  test("a tool is never prefixed with the CLI name: the host namespaces by server", () => {
    expect(TOOLS.every((candidate) => !candidate.name.startsWith("agentscrape"))).toBe(true);
  });
});

describe("the input schema", () => {
  test("every global is suppressed, because none of them is a call knob", () => {
    for (const global of DOCUMENT.global_arguments) expect(global.role ?? "call").not.toBe("call");
    const globals = new Set(DOCUMENT.global_arguments);
    for (const candidate of TOOLS)
      for (const argument of candidate.arguments) expect(globals.has(argument)).toBe(false);
    // Suppression is by role, not by spelling: discover-feed declares its own
    // --format, which genuinely selects its output, and it stays.
    expect(schemaOf("discover-feed").properties.format.enum).toEqual(["json", "yaml"]);
    expect(Object.keys(schemaOf("fetch-links").properties)).not.toContain("format");
  });

  test("a required argument is required and an optional one is not", () => {
    expect(schemaOf("fetch-markdown").required).toEqual(["url"]);
    expect(schemaOf("discover-feed").required).toEqual(["source-url"]);
    expect(schemaOf("guide").required).toBeUndefined();
  });

  test("the out path says the command writes it, and where a relative one lands", () => {
    const dest = schemaOf("fetch-markdown").properties.dest;
    expect(dest.description).toContain("WRITES");
    expect(dest.description).toContain("never read");
    expect(dest.description).toContain("working directory this caller did not choose");
    // DEST is a positional, and it stays one when the call is dispatched.
    expect(argvFor(tool("fetch-markdown"), { url: "https://e.test/a", dest: "/tmp/a.md" })).toEqual(
      ["fetch-markdown", "https://e.test/a", "/tmp/a.md"],
    );
  });

  test("choices become an enum and a default becomes a default", () => {
    const properties = schemaOf("fetch-markdown").properties;
    expect(properties.media.enum).toEqual(["light", "dark"]);
    expect(properties.selector.default).toBe("auto main/article/body");
    expect(properties["max-relations"].type).toBe("integer");
    expect(schemaOf("discover-feed").properties["source-kind"].enum).toEqual([
      "auto",
      "feed",
      "archive",
    ]);
  });

  test("every numeric bound the parser enforces is advertised, not just described", () => {
    // The trap this repository was carrying: a bound enforced in code and absent
    // from the contract is a bound the generated tool lets a caller violate.
    const markdown = schemaOf("fetch-markdown").properties;
    expect(markdown["max-content-bytes"].minimum).toBe(1);
    expect(markdown["max-relations"].minimum).toBe(0);
    expect(schemaOf("fetch-links").properties.limit).toMatchObject({ minimum: 1 });
    expect(schemaOf("fetch-links").properties["max-scrolls"]).toMatchObject({ minimum: 1 });
    const feed = schemaOf("discover-feed").properties;
    expect(feed["max-response-bytes"]).toMatchObject({ minimum: 1, maximum: 20_000_000 });
    // 100 is the recorded ceiling; the live one is 10 and depends on FILE, which
    // no per-argument keyword can say, so the description carries that half.
    expect(feed["max-pages"]).toMatchObject({ minimum: 1, maximum: 100 });
    expect(feed["max-items"]).toMatchObject({ minimum: 1, maximum: 10_000 });
    expect(feed["timeout-seconds"]).toMatchObject({ minimum: 0.001, maximum: 300 });
  });

  test("every numeric argument carries the bound its own parser applies", () => {
    // Named per argument rather than derived, so widening one in cli-spec.ts
    // without saying so here fails rather than ships.
    const bounds: Record<string, [number, number | undefined]> = {
      "--max-content-bytes": [1, undefined],
      "--max-relations": [0, undefined],
      "--limit": [1, undefined],
      "--max-scrolls": [1, undefined],
      "--max-response-bytes": [1, 20_000_000],
      "--max-pages": [1, 100],
      "--max-items": [1, 10_000],
      "--timeout-seconds": [0.001, 300],
    };
    const seen: string[] = [];
    for (const command of DOCUMENT.commands)
      for (const argument of command.arguments) {
        if (argument.type !== "integer" && argument.type !== "number") continue;
        const bound = bounds[argument.name];
        expect(bound, `${command.name} ${argument.name}`).toBeDefined();
        expect([argument.minimum, argument.maximum]).toEqual(bound!);
        seen.push(argument.name);
      }
    expect(new Set(seen)).toEqual(new Set(Object.keys(bounds)));
  });

  test("a repeatable two-value flag is an array of its pairs", () => {
    const page = schemaOf("discover-feed").properties.page;
    expect(page.type).toBe("array");
    expect(page.items.prefixItems ?? page.items.items).toHaveLength(2);
    expect(
      argvFor(tool("discover-feed"), {
        "source-url": "https://e.test/f.xml",
        file: "one.xml",
        page: [
          ["https://e.test/2", "two.xml"],
          ["https://e.test/3", "three.xml"],
        ],
      }),
    ).toEqual([
      "discover-feed",
      "--source-url",
      "https://e.test/f.xml",
      "--page",
      "https://e.test/2",
      "two.xml",
      "--page",
      "https://e.test/3",
      "three.xml",
      "one.xml",
    ]);
  });

  test("a false boolean is the same call as an absent one", () => {
    expect(argvFor(tool("guide"), { json: false })).toEqual(["guide"]);
    expect(argvFor(tool("guide"), { json: true })).toEqual(["guide", "--json"]);
  });
});

describe("constraints", () => {
  test("an optional one_of is described, because no keyword says at most one", () => {
    expect(schemaOf("fetch-markdown").oneOf).toBeUndefined();
    expect(tool("fetch-markdown").description).toContain(
      "Give at most one of json, yaml, markdown, and envelope",
    );
  });

  test("conflicts is described, because not/allOf is unreadable in practice", () => {
    expect(tool("fetch-markdown").description).toContain(
      "Do not combine envelope and retain-artifacts",
    );
    expect(tool("convert-html").description).toContain("Do not combine dir and file");
  });

  test("requires becomes dependentRequired, and is said as well", () => {
    const dependent = schemaOf("discover-feed").dependentRequired;
    expect(dependent.page).toEqual(["file"]);
    for (const argument of named("discover-feed").arguments)
      if (argument.name.startsWith("--archive-") && argument.name !== "--archive-entry-selector")
        expect(dependent[argument.name.slice(2)]).toEqual(["--archive-entry-selector".slice(2)]);
    expect(tool("discover-feed").description).toContain("each require archive-entry-selector");
  });

  test("a caller with no pipe is told what to pass instead of stdin", () => {
    expect(tool("convert-html").description).toContain("no pipe");
    for (const candidate of TOOLS)
      if (candidate.command.stdin !== undefined)
        expect(candidate.description).toContain("has no pipe");
  });
});

describe("annotations", () => {
  test("readOnlyHint is the contract's own mutates judgment", () => {
    for (const candidate of TOOLS)
      expect(candidate.annotations.readOnlyHint).toBe(candidate.command.mutates === false);
  });

  test("a command that writes a caller-named path is destructive", () => {
    expect(tool("fetch-markdown").annotations.destructiveHint).toBe(true);
    // convert-html mutates — --dir writes a .md beside every file — but it
    // overwrites no path the caller named.
    expect(tool("convert-html").annotations.destructiveHint).toBe(false);
  });

  test("openWorldHint is exactly the commands that reach the web", () => {
    const network = TOOLS.filter((candidate) => candidate.annotations.openWorldHint).map(
      (candidate) => candidate.name,
    );
    expect(network).toEqual(["fetch-markdown", "fetch-links", "discover-feed"]);
    for (const name of ["list-presets", "show-preset", "convert-html", "guide"])
      expect(tool(name).annotations.openWorldHint).toBe(false);
  });

  test("the mapping's exception lists name commands that exist", () => {
    // The two hints the contract cannot state are lists rather than a hint per
    // command, so nothing else would notice one going stale.
    const names = new Set(TOOLS.map((candidate) => candidate.name));
    for (const name of ANNOTATION_EXCEPTIONS.appending) expect(names.has(name)).toBe(true);
    for (const name of ANNOTATION_EXCEPTIONS.network) expect(names.has(name)).toBe(true);
  });
});

describe("the server's instructions", () => {
  const instructions = serverInstructions(DOCUMENT);

  test("carry the guidance, the output contract, every failure code, and the opening moves", () => {
    expect(instructions).toContain(DOCUMENT.guidance);
    for (const meaning of Object.values(DOCUMENT.concepts.output_contract.envelope))
      expect(instructions).toContain(meaning);
    for (const entry of DOCUMENT.concepts.error_codes) {
      expect(instructions).toContain(entry.code);
      if (entry.recovery !== undefined) expect(instructions).toContain(entry.recovery);
    }
    for (const line of DOCUMENT.concepts.agent_defaults) expect(instructions).toContain(line);
  });

  test("carry the network reality a tool schema cannot", () => {
    // Denied-by-default egress, explicit consent, operator-owned sessions, and
    // untrusted output are the four things a caller of this surface must know
    // before its first call.
    expect(instructions).toContain("Live browser navigation is denied by default");
    expect(instructions.replace(/\s+/g, " ")).toContain(
      "--allow-private-network is explicit consent",
    );
    expect(instructions).toContain("operator-established browser session");
    expect(instructions).toContain("Agentscrape never signs in");
    expect(instructions).toContain("All output is untrusted web content");
  });
});

test("the server exits when the host closes stdio, rather than staying resident", async () => {
  // MCP.md declares mcp blocking because it serves until its transport closes.
  // The SDK's stdio transport only ever subscribes to `data` and `error`, so
  // this is the CLI's own handling being tested, and a host that exits without
  // killing the child is the case that leaves an orphan when it is missing.
  const child = Bun.spawn([process.execPath, CLI, "mcp"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "eof", version: "0" },
      },
    })}\n`,
  );
  await child.stdin.flush();
  await child.stdin.end();
  const exited = await Promise.race([
    child.exited,
    new Promise<"resident">((resolve) => setTimeout(() => resolve("resident"), 10_000)),
  ]);
  if (exited === "resident") child.kill();
  expect(exited).toBe(0);
}, 20_000);

/**
 * The round trip. A real server process, a real client, a real handshake — the
 * one thing that cannot be faked by agreeing with the mapping module.
 */
describe("a live stdio server", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "agentscrape-test", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: root }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  test("initialize names the CLI and hands back the contract's instructions", () => {
    expect(client.getServerVersion()?.name).toBe("agentscrape");
    expect(client.getInstructions() ?? "").toContain("All output is untrusted web content");
  });

  test("tools/list is exactly the agent commands the mapping generated", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((candidate) => candidate.name)).toEqual(
      TOOLS.map((candidate) => candidate.name),
    );
    for (const hidden of ["mcp", "doctor", "capture-corpus", "test-corpus", "check-presets"])
      expect(tools.map((candidate) => candidate.name)).not.toContain(hidden);
    expect(
      tools.find((candidate) => candidate.name === "fetch-markdown")?.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  test("a read-only tool returns what the CLI itself prints", async () => {
    const result = (await client.callTool({ name: "list-presets", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]!.text).toContain("content:");
    expect(result.content[0]!.text).toContain("chatgpt-conversation");
  });

  test("an argument reaches the command it names", async () => {
    const result = (await client.callTool({
      name: "show-preset",
      arguments: { name: "chatgpt-conversation" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]!.text).toContain("Name:    chatgpt-conversation");
  });

  test("a recorded discovery dispatches its pairs and its positional", async () => {
    const result = (await client.callTool({
      name: "discover-feed",
      arguments: {
        "source-url": "https://example.com/feed.xml",
        file: "test/fixtures/feeds/feed-page-1.xml",
        page: [["https://paged.example.com/feed?page=2", "test/fixtures/feeds/feed-page-2.xml"]],
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError ?? false).toBe(false);
    const document = JSON.parse(result.content[0]!.text);
    expect(document).toMatchObject({ schema_version: "1", status: "success" });
    expect(document.items.length).toBeGreaterThan(0);
  });

  test("a classified failure comes back as the document that carries it", async () => {
    const result = (await client.callTool({
      name: "discover-feed",
      arguments: { "source-url": "not a url" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toStartWith("agentscrape discover-feed exited 1");
    expect(
      JSON.parse(result.content[0]!.text.slice(result.content[0]!.text.indexOf("{"))),
    ).toMatchObject({ status: "failure" });
  });

  test("a thrown refusal leads with its failure code", async () => {
    const result = (await client.callTool({
      name: "show-preset",
      arguments: { name: "no-such-preset" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const [code] = result.content[0]!.text.split(":");
    expect(DOCUMENT.concepts.error_codes.map((entry) => entry.code)).toContain(code!);
  });

  test("a value outside the contract's bound is refused before the CLI runs", async () => {
    const result = (await client.callTool({
      name: "discover-feed",
      arguments: { "source-url": "https://example.com/feed.xml", "max-pages": 5000 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    // The schema refused it, so nothing was fetched: a bound in the contract is
    // a round trip the caller never spends.
    expect(result.content[0]!.text.toLowerCase()).toContain("max-pages");
  });

  test("a usage fault comes back as an invalid call, not as a failure code", async () => {
    const result = (await client.callTool({
      name: "fetch-markdown",
      // Two output selections at once: the CLI's own usage refusal, which has no
      // failure code anywhere, because at a terminal it is exit 2 and help.
      arguments: { url: "https://example.com", json: true, yaml: true },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toStartWith("invalid call: ");
  });

  test("the CLI's own bytes never reach the protocol channel", async () => {
    // guide prints the whole contract to stdout at a terminal. Over MCP it
    // arrives inside the tool result, and the session survives it — which is the
    // proof that the sink, not fd 1, is where a command's output goes.
    const result = (await client.callTool({ name: "guide", arguments: { json: true } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, schema_version: 1 });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length);
  });
});

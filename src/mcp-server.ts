/**
 * The MCP server `agentscrape mcp` serves, constructed but not connected.
 *
 * Two things make this a generated surface rather than a second one. The tools
 * come from `guide --json` through `mcp-tools.ts`, so adding a command to
 * `cli-spec.ts` adds a tool with no edit here. And every call is dispatched
 * through `cli.ts`'s own `main` in this process — the same function
 * `agentscrape fetch-markdown` runs, reached with an argument vector built
 * structurally from the tool's arguments, with nothing spawned and no string
 * parsed back apart.
 *
 * `mcp.ts` is the entrypoint that connects a transport to what this returns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { main, type OutputSink } from "./cli";
import { CLI_SPEC } from "./cli-spec";
import { buildContract } from "./contract";
import { classifyFailure } from "./envelope";
import { AgentscrapeUsageError } from "./errors";
import {
  type AgentTool,
  agentTools,
  argvFor,
  type ContractDocument,
  serverInstructions,
} from "./mcp-tools";
import { redactDiagnostic } from "./redaction";

export function createAgentscrapeMcpServer(): McpServer {
  const document = buildContract() as ContractDocument;
  const server = new McpServer(
    { name: document.meta.name, version: document.meta.version },
    { instructions: serverInstructions(document) },
  );
  // Recoveries are the contract's, read once: a refusal that repeats the
  // contract's own words is the one a caller can act on.
  const recoveries = new Map(
    document.concepts.error_codes.map((entry) => [entry.code, entry.recovery]),
  );
  let queue: Promise<CallToolResult> = Promise.resolve({ content: [] });
  for (const tool of agentTools(document)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      // The SDK infers the callback's argument type from the input schema, which
      // is built at runtime and so infers to nothing useful. The shape is
      // whatever the schema just validated: a plain object of argument values.
      (args: unknown, extra: { signal?: AbortSignal }) => {
        // Calls run one at a time. `main` prints through one process-wide sink,
        // which is what keeps a command's bytes off the protocol channel, and a
        // sink cannot serve two runs at once.
        const next = queue.then(() =>
          callTool(tool, (args ?? {}) as Record<string, unknown>, recoveries, extra.signal),
        );
        queue = next.catch(() => ({ content: [] }));
        return next;
      },
    );
  }
  return server;
}

/** What one dispatched run wrote, kept apart the way the two file descriptors
 * keep it apart: the payload, and the asides about where it went. */
interface Captured {
  code: number;
  text: string;
}

async function run(argv: string[], signal?: AbortSignal): Promise<Captured> {
  const out: string[] = [];
  const notes: string[] = [];
  const sink: OutputSink = {
    write: (chunk) => {
      out.push(chunk);
    },
    note: (line) => {
      notes.push(line);
    },
  };
  const code = await main(argv, { output: sink, ...(signal ? { signal } : {}) });
  // A command whose whole result is a side effect — `fetch-markdown URL DEST`
  // writes the file and says so on stderr — would otherwise come back empty.
  const text = [...notes, ...(out.length ? [out.join("")] : [])].join("\n");
  return { code, text };
}

/**
 * One tool call, dispatched in process.
 *
 * Nothing is held open between calls: agentscrape's commands each own their
 * fetch, their browser handoff, and their file writes, exactly as a terminal
 * invocation would.
 */
async function callTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  recoveries: Map<string, string | undefined>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  let captured: Captured;
  try {
    captured = await run(argvFor(tool, args), signal);
  } catch (error) {
    return toolError(error, recoveries);
  }
  if (captured.code === 0) return { content: [{ type: "text", text: captured.text }] };
  // A nonzero exit with no thrown error is a command that classified its own
  // failure and printed it — `--envelope`'s failure field, a feed discovery
  // result. The document IS the answer, so it is returned rather than summarized.
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${CLI_SPEC.name} ${tool.name} exited ${captured.code}. The result below carries the failure.\n${captured.text}`,
      },
    ],
  };
}

/**
 * A refusal, as MCP.md rules: the message leads with the failure code, then the
 * message, then `recovery` when the contract gives one — the recovery line is
 * the difference between a caller that retries correctly and one that retries
 * identically.
 *
 * The code comes from `classifyFailure`, the same mapping `--envelope` uses, so
 * a refusal here names a code the contract lists rather than inventing one. A
 * usage fault is not classified anywhere in that vocabulary at a terminal — it
 * is exit 2 with help on stderr — so it comes back as a plain invalid call.
 */
function toolError(error: unknown, recoveries: Map<string, string | undefined>): CallToolResult {
  if (error instanceof AgentscrapeUsageError) {
    return {
      isError: true,
      content: [{ type: "text", text: `invalid call: ${redactDiagnostic(error.message)}` }],
    };
  }
  const [code, retryable, message] = classifyFailure(error);
  const lines = [`${code}: ${message}`];
  const recovery = recoveries.get(code);
  if (recovery !== undefined) lines.push(`recovery: ${recovery}`);
  if (retryable) lines.push("This failure is retryable.");
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}

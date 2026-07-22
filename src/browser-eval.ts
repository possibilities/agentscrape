import { runAgentBrowser, UPSTREAM_DOWN_PREFIX } from "./browser";
import { AgentscrapeUpstreamDownError } from "./errors";

function fail(context: string, detail: string): Error {
  return new Error(`${context}: ${detail}`);
}

export function decodeBrowserEval(stdout: string, context = "browser eval"): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw fail(context, "agent-browser eval returned invalid JSON");
  }
}

export function decodeBrowserEvalString(stdout: string, context = "browser eval"): string {
  const value = decodeBrowserEval(stdout, context);
  if (typeof value !== "string")
    throw fail(context, "agent-browser eval returned a non-string result");
  return value;
}

export async function browserEval(
  expression: string,
  session?: string | null,
  context = "browser eval failed",
): Promise<unknown> {
  const result = await runAgentBrowser(["eval", expression], session);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `agent-browser exited with status ${result.exitCode}`;
    if (detail.startsWith(UPSTREAM_DOWN_PREFIX)) throw new AgentscrapeUpstreamDownError(detail);
    throw fail(context, detail);
  }
  return decodeBrowserEval(result.stdout, context);
}

export async function browserEvalString(
  expression: string,
  session?: string | null,
  context = "browser eval failed",
): Promise<string> {
  const value = await browserEval(expression, session, context);
  if (typeof value !== "string")
    throw fail(context, "agent-browser eval returned a non-string result");
  return value;
}

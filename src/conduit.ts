/**
 * The optional Agentweb conduit seam.
 *
 * Agentweb owns which origins need a signed-in browser and holds the sessions
 * an operator signed in by hand. Agentscrape asks it, before navigating, whether
 * this URL has a stored session, and if so attaches that session's storage state
 * to the browser. Agentscrape never signs anything in and never stores
 * credentials; it replays state a human already established.
 *
 * The seam is entirely optional. With no socket configured, or with the daemon
 * down, extraction proceeds exactly as before — an unreachable conduit must
 * degrade to unauthenticated fetching, never fail the fetch.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONDUIT_SOCKET_ENV = "AGENTSCRAPE_CONDUIT_SOCKET";
export const CONDUIT_TOKEN_FILE_ENV = "AGENTSCRAPE_CONDUIT_TOKEN_FILE";
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;

export interface ResolvedSession {
  sessionName: string;
  origin: string;
  state: string;
}

function configuredSocket(): string | null {
  const value = (process.env[CONDUIT_SOCKET_ENV] ?? "").trim();
  return value.length > 0 ? value : null;
}

function configuredToken(): string | null {
  const file = (process.env[CONDUIT_TOKEN_FILE_ENV] ?? "").trim();
  if (file.length === 0) return null;
  try {
    if (statSync(file).size > 8192) return null;
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** True when an operator has configured a conduit for this process. */
export function conduitConfigured(): boolean {
  return configuredSocket() !== null && configuredToken() !== null;
}

/**
 * The stored session for a URL, or null when there is no conduit, no origin
 * rule, no stored session, or the daemon cannot be reached. Every failure is
 * silent by design: a missing conduit means unauthenticated extraction, which
 * is the behavior that existed before the conduit.
 */
export async function resolveSession(url: string): Promise<ResolvedSession | null> {
  const socket = configuredSocket();
  const token = configuredToken();
  if (socket === null || token === null) return null;
  try {
    const response = await fetch("http://localhost/v1/sessions/resolve", {
      unix: socket,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { session?: { sessionName?: unknown; origin?: unknown } | null; state?: unknown };
    };
    const session = payload.data?.session;
    const state = payload.data?.state;
    if (!session || typeof state !== "string" || state.length === 0) return null;
    if (typeof session.sessionName !== "string" || typeof session.origin !== "string") return null;
    if (Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES) return null;
    return { sessionName: session.sessionName, origin: session.origin, state };
  } catch {
    return null;
  }
}

/** Runs one agent-browser command; supplied by the browser module to avoid a cycle. */
export type StateLoader = (args: string[]) => Promise<{ exitCode: number }>;

/**
 * Attach a resolved session's storage state to a browser session. The state is
 * written to a mode-0600 temporary file and removed immediately after the
 * driver reads it, so cookies never appear in argv and never outlive the call.
 */
export async function attachSession(
  resolved: ResolvedSession,
  load: StateLoader,
): Promise<boolean> {
  const path = join(tmpdir(), `agentscrape-state-${randomBytes(12).toString("hex")}.json`);
  writeFileSync(path, resolved.state, { mode: 0o600 });
  try {
    return (await load(["state", "load", path])).exitCode === 0;
  } catch {
    return false;
  } finally {
    rmSync(path, { force: true });
  }
}

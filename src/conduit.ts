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

export type SignedInKind = "url_contains" | "text" | "selector" | "none";

/** The conduit's rule for deciding whether a page is signed in. */
export interface OriginRule {
  origin: string;
  signedInKind: SignedInKind;
  signedInValue: string | null;
  escalation: "none" | "human_signin";
  /** Set when a session exists for this origin but the site stopped accepting it. */
  staleSession: { sessionName: string; reason: string | null } | null;
}

/** Page facts an origin rule is evaluated against. */
export interface PageProbe {
  url: string;
  text: string;
  selectorHits: number;
}

/**
 * Whether the probe shows a signed-in page. An origin with no rule cannot
 * answer and reports signed in, so a site nobody has taught Agentweb about is
 * never treated as blocked.
 */
export function evaluateSignedIn(rule: OriginRule, probe: PageProbe): boolean {
  if (rule.signedInKind === "none" || rule.signedInValue === null) return true;
  if (rule.signedInKind === "url_contains") return probe.url.includes(rule.signedInValue);
  if (rule.signedInKind === "text") return probe.text.includes(rule.signedInValue);
  return probe.selectorHits > 0;
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
interface ResolvePayload {
  data?: {
    origin?: {
      origin?: unknown;
      signedInKind?: unknown;
      signedInValue?: unknown;
      escalation?: unknown;
    } | null;
    session?: { sessionName?: unknown; origin?: unknown } | null;
    state?: unknown;
    staleSession?: { sessionName?: unknown; reason?: unknown } | null;
  };
}

/** One resolve call, or null on any failure. Never throws. */
async function postResolve(url: string): Promise<ResolvePayload | null> {
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
    return (await response.json()) as ResolvePayload;
  } catch {
    return null;
  }
}

/**
 * The stored session for a URL, or null when there is no conduit, no origin
 * rule, no stored session, or the daemon cannot be reached. Every failure is
 * silent by design: a missing conduit means unauthenticated extraction, which
 * is the behavior that existed before the conduit.
 */
export async function resolveSession(url: string): Promise<ResolvedSession | null> {
  const payload = await postResolve(url);
  const session = payload?.data?.session;
  const state = payload?.data?.state;
  if (!session || typeof state !== "string" || state.length === 0) return null;
  if (typeof session.sessionName !== "string" || typeof session.origin !== "string") return null;
  if (Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES) return null;
  return { sessionName: session.sessionName, origin: session.origin, state };
}

/**
 * The origin rule for a URL, independent of whether a session is stored. This
 * is what lets a fetch notice it is looking at a login wall even when no
 * session exists to attach.
 */
export async function resolveOrigin(url: string): Promise<OriginRule | null> {
  const payload = await postResolve(url);
  const origin = payload?.data?.origin;
  if (!origin || typeof origin.origin !== "string") return null;
  const stale = payload?.data?.staleSession;
  const kind = origin.signedInKind;
  if (kind !== "url_contains" && kind !== "text" && kind !== "selector" && kind !== "none")
    return null;
  return {
    origin: origin.origin,
    signedInKind: kind,
    signedInValue: typeof origin.signedInValue === "string" ? origin.signedInValue : null,
    escalation: origin.escalation === "human_signin" ? "human_signin" : "none",
    staleSession:
      stale && typeof stale.sessionName === "string"
        ? {
            sessionName: stale.sessionName,
            reason: typeof stale.reason === "string" ? stale.reason : null,
          }
        : null,
  };
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

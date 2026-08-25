import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { attachSession, conduitConfigured, resolveOrigin, resolveSession } from "./conduit";
import {
  AgentscrapeArtifactError,
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeNetworkPolicyError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  asError,
  throwIfAborted,
} from "./errors";
import { boundUtf8, redactDiagnostic, redactUrl } from "./redaction";
import { findExecutable, type ProcessResult, runProcess } from "./subprocess";

export const AGENT_BROWSER_BIN_ENV = "AGENTSCRAPE_AGENT_BROWSER_BIN";
export const AGENT_BROWSER_TIMEOUT_ENV = "AGENTSCRAPE_AGENT_BROWSER_TIMEOUT";
/**
 * Pins every otherwise-ephemeral operation to one operator-managed browser
 * session. Sites that require authentication (X, and any other logged-in
 * provider) need a session an operator has already signed in; a per-process
 * throwaway session can never satisfy them. Agentscrape never creates, closes,
 * or authenticates the pinned session — it only reuses it.
 */
export const AGENT_BROWSER_SESSION_ENV = "AGENTSCRAPE_BROWSER_SESSION";
export const AGENT_BROWSER_TIMEOUT_PREFIX = "agent-browser timed out after ";
export const AGENT_BROWSER_OUTPUT_MAX_BYTES = 8_000_000;
export const UPSTREAM_DOWN_PREFIX = "upstream down: ";
export const CLAUDE_APP_READY_SELECTOR = "[data-testid='account-settings'], main";
const OUTAGE_CACHE_TTL_MS = 30_000;
const OUTAGE_CACHE_MAX_ENTRIES = 64;
const HEALTH_FRESHNESS_MS = 15 * 60_000;
const HEALTH_FUTURE_SKEW_MS = 60_000;
const HEALTH_MAX_BYTES = 16 * 1024;
const UPSTREAM_REASON_MAX_BYTES = 1024;
const SCREENSHOT_MAX_BYTES = 10_000_000n;
const SCREENSHOT_DIRECTORY_PREFIX = "agentscrape-artifacts-";
const outageCache = new Map<string, { reason: string; expiresAtMs: number }>();
export interface BrowserSessionScope {
  name: string;
  owned: boolean;
  used: boolean;
}
interface BrowserContext {
  profile: string | null;
  signal: AbortSignal | null;
  session: BrowserSessionScope | null;
  allowPrivateNetwork: boolean;
  retainArtifacts: boolean;
}
const browserContext = new AsyncLocalStorage<BrowserContext>();
function context(): BrowserContext {
  return (
    browserContext.getStore() ?? {
      profile: null,
      signal: null,
      session: null,
      allowPrivateNetwork: false,
      retainArtifacts: false,
    }
  );
}

/** A non-empty, bounded, shell-safe pinned session name, or null when unset. */
export function pinnedSession(): string | null {
  const value = (process.env[AGENT_BROWSER_SESSION_ENV] ?? "").trim();
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? value
    : null;
}
function defaultSession(): string {
  return pinnedSession() ?? `agentscrape-${process.pid}`;
}
function freshSession(): string {
  return pinnedSession() ?? `agentscrape-${process.pid}-${randomUUID().replaceAll("-", "")}`;
}
function resolveBrowserSession(
  requested: string | null | undefined,
  active: BrowserContext,
): string {
  const selected = requested || active.session?.name || defaultSession();
  if (active.session?.owned && selected === active.session.name) active.session.used = true;
  return selected;
}
function timeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(process.env[AGENT_BROWSER_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 30_000;
}
function runtimeHome(): string {
  return process.env.HOME || homedir();
}
function healthStatePath(home: string): string {
  return join(home, ".local/state/browserctl/check-health-state.yaml");
}
interface Rfc3339Timestamp {
  floorMs: number;
  subMsNonzero: boolean;
}
function parseRfc3339(value: string): Rfc3339Timestamp | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return null;

  // Convert the civil date using integer arithmetic so fractional precision is retained
  // independently from Date's millisecond-only representation.
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146_097 + dayOfEra - 719_468;
  const fraction = match[7] ?? "";
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  const localMs = ((epochDays * 24 + hour) * 60 * 60 + minute * 60 + second) * 1000 + milliseconds;
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
  const floorMs = localMs + (match[9] === "-" ? offsetMs : -offsetMs);
  return {
    floorMs,
    subMsNonzero: /[1-9]/.test(fraction.slice(3)),
  };
}
type HealthStat = BigIntStats;
function sameHealthStat(left: HealthStat, right: HealthStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}
function secureHealthStat(value: HealthStat): boolean {
  const getuid = process.getuid;
  return (
    value.isFile() &&
    value.nlink === 1n &&
    (value.mode & 0o022n) === 0n &&
    value.size >= 1n &&
    value.size <= BigInt(HEALTH_MAX_BYTES) &&
    (!getuid || value.uid === BigInt(getuid.call(process)))
  );
}
function readHealthState(path: string): Record<string, unknown> | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    if (
      !secureHealthStat(before) ||
      !secureHealthStat(namedBefore) ||
      namedBefore.isSymbolicLink() ||
      !sameHealthStat(before, namedBefore)
    )
      return null;
    const raw = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < raw.byteLength) {
      const count = readSync(descriptor, raw, offset, raw.byteLength - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !secureHealthStat(after) ||
      !secureHealthStat(namedAfter) ||
      namedAfter.isSymbolicLink() ||
      !sameHealthStat(before, after) ||
      !sameHealthStat(namedBefore, namedAfter) ||
      !sameHealthStat(after, namedAfter)
    )
      return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0 || !isMap(document.contents)) return null;
    const state = document.toJS({ maxAliasCount: 0 }) as unknown;
    return state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // This advisory reader is fail-open, including when descriptor cleanup itself fails.
    }
  }
}
function upstreamReason(value: string): string {
  return boundUtf8(
    `${UPSTREAM_DOWN_PREFIX}${redactDiagnostic(value, UPSTREAM_REASON_MAX_BYTES)}`,
    UPSTREAM_REASON_MAX_BYTES,
  );
}
function knownUpstreamDown(
  path: string,
  now: number,
): { reason: string; expiresAtMs: number } | null {
  const state = readHealthState(path);
  if (state?.is_down !== true || typeof state.last_run_at !== "string") return null;
  const observedAt = parseRfc3339(state.last_run_at);
  if (observedAt === null) return null;
  const staleBoundaryMs = now - HEALTH_FRESHNESS_MS;
  const futureBoundaryMs = now + HEALTH_FUTURE_SKEW_MS;
  if (
    observedAt.floorMs < staleBoundaryMs ||
    observedAt.floorMs > futureBoundaryMs ||
    (observedAt.floorMs === futureBoundaryMs && observedAt.subMsNonzero)
  )
    return null;
  const rawDetail =
    typeof state.reason === "string" && state.reason.trim() ? state.reason : "browserctl is down";
  const redactedDetail = redactDiagnostic(rawDetail, UPSTREAM_REASON_MAX_BYTES);
  const detail =
    redactedDetail === "no additional diagnostic" ? "browserctl is down" : redactedDetail;
  return {
    reason: upstreamReason(`browserctl: ${detail}`),
    expiresAtMs: Math.min(
      now + OUTAGE_CACHE_TTL_MS,
      observedAt.floorMs + HEALTH_FRESHNESS_MS + (observedAt.subMsNonzero ? 1 : 0),
    ),
  };
}
function outageKey(session: string, profile: string | null, browser: string, path: string): string {
  return createHash("sha256")
    .update(JSON.stringify([session, profile, browser, path]))
    .digest("hex");
}
function pruneOutageCache(now: number): void {
  for (const [key, value] of outageCache) {
    if (now >= value.expiresAtMs) outageCache.delete(key);
  }
}
function setOutage(key: string, value: { reason: string; expiresAtMs: number }, now: number): void {
  pruneOutageCache(now);
  outageCache.delete(key);
  outageCache.set(key, value);
  while (outageCache.size > OUTAGE_CACHE_MAX_ENTRIES) {
    const oldest = outageCache.keys().next().value;
    if (oldest === undefined) break;
    outageCache.delete(oldest);
  }
}
export function resetBrowserUnavailableCache(): void {
  outageCache.clear();
}
export function currentBrowserProfile(): string | null {
  return context().profile;
}
export async function withBrowserProfile<T>(
  profile: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return browserContext.run({ ...context(), profile: profile ?? null }, fn);
}
export async function withBrowserSignal<T>(
  signal: AbortSignal | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const selected = signal ?? null;
  throwIfAborted(selected);
  return browserContext.run({ ...context(), signal: selected }, fn);
}
export function currentBrowserArtifactRetention(): boolean {
  return context().retainArtifacts;
}
export async function withBrowserArtifactRetention<T>(
  retainArtifacts: boolean | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (retainArtifacts !== undefined && typeof retainArtifacts !== "boolean")
    throw new AgentscrapeUsageError("retainArtifacts must be a boolean when provided");
  const active = context();
  return browserContext.run(
    {
      ...active,
      retainArtifacts:
        retainArtifacts === undefined ? active.retainArtifacts : retainArtifacts === true,
    },
    fn,
  );
}
export function currentBrowserNetworkPolicy(): boolean {
  return context().allowPrivateNetwork;
}
export async function withBrowserNetworkPolicy<T>(
  allowPrivateNetwork: boolean | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (allowPrivateNetwork !== undefined && typeof allowPrivateNetwork !== "boolean")
    throw new AgentscrapeUsageError("allowPrivateNetwork must be a boolean when provided");
  const active = context();
  return browserContext.run(
    {
      ...active,
      allowPrivateNetwork:
        allowPrivateNetwork === undefined ? active.allowPrivateNetwork : allowPrivateNetwork,
    },
    fn,
  );
}
export async function withBrowserSession<T>(
  requested: string | null | undefined,
  fn: (scope: BrowserSessionScope, owner: boolean) => Promise<T>,
): Promise<T> {
  const active = context();
  if (!requested && active.session)
    return browserContext.run({ ...active, session: active.session }, () =>
      fn(active.session!, false),
    );

  // A pinned session is operator-owned: reuse it, but never close it.
  const pinned = pinnedSession();
  const scope: BrowserSessionScope = requested
    ? { name: requested, owned: false, used: false }
    : pinned !== null
      ? { name: pinned, owned: false, used: false }
      : { name: freshSession(), owned: true, used: false };
  const owner = scope.owned;
  const capturedName = scope.name;
  try {
    return await browserContext.run({ ...active, session: scope }, () => fn(scope, owner));
  } finally {
    if (owner && scope.used) await closeSessionBestEffort(capturedName);
  }
}
export function findAgentBrowserExecutable(
  home = runtimeHome(),
  configured = process.env[AGENT_BROWSER_BIN_ENV],
  executableLookup: (name: string) => string | null = findExecutable,
): string | null {
  if (configured) return executableLookup(configured);
  return (
    executableLookup(join(home, ".local/bin/agent-browser")) || executableLookup("agent-browser")
  );
}
function resolveBrowser(home = runtimeHome()): string {
  const configured = process.env[AGENT_BROWSER_BIN_ENV];
  return findAgentBrowserExecutable(home, configured) || configured || "agent-browser";
}
function isNetworkFreeBrowserCommand(args: string[]): boolean {
  return args.length === 2 && args[0] === "open" && args[1] === "about:blank";
}

export async function runAgentBrowser(
  args: string[],
  session?: string | null,
  browserProfile?: string | null,
  timeoutOverrideMs?: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const active = context();
  const selectedSignal = signal ?? active.signal;
  throwIfAborted(selectedSignal);
  if (!active.allowPrivateNetwork && !isNetworkFreeBrowserCommand(args))
    throw new AgentscrapeNetworkPolicyError("browser_egress_unverifiable");
  const selectedSession = resolveBrowserSession(session, active);
  const profile = browserProfile || active.profile;
  const home = runtimeHome();
  const path = healthStatePath(home);
  const browser = resolveBrowser(home);
  const argv = [browser, "--session", selectedSession];
  if (profile) argv.push("--browserctl-profile", profile);
  argv.push(...args);
  const key = outageKey(selectedSession, profile, browser, path);
  const now = Date.now();
  pruneOutageCache(now);
  let outage = outageCache.get(key) ?? null;
  if (!outage) {
    outage = knownUpstreamDown(path, now);
    if (outage) setOutage(key, outage, now);
  }
  if (outage) {
    return {
      argv,
      exitCode: 1,
      stdout: "",
      stderr: outage.reason,
      timedOut: false,
      truncated: false,
    };
  }
  let result: ProcessResult;
  try {
    result = await runProcess(argv, {
      timeoutMs: timeoutMs(timeoutOverrideMs),
      maxOutputBytes: AGENT_BROWSER_OUTPUT_MAX_BYTES,
      ...(selectedSignal ? { signal: selectedSignal } : {}),
    });
  } catch (error) {
    throwIfAborted(selectedSignal);
    const value = asError(error);
    // A missing agent-browser executable is absent extraction infrastructure, not a
    // browser/page failure: report it as an unavailable dependency so queue owners
    // can keep the request retryable until the dependency is installed.
    if (/not found on PATH|ENOENT|no such file/i.test(value.message))
      throw new AgentscrapeUpstreamDownError(`Failed to run agent-browser: ${value.message}`);
    throw new AgentscrapeBrowserError(`Failed to run agent-browser: ${value.message}`);
  }
  throwIfAborted(selectedSignal);
  if (result.exitCode === 0) outageCache.delete(key);
  if (result.timedOut) {
    result.stderr = `${AGENT_BROWSER_TIMEOUT_PREFIX}${timeoutMs(timeoutOverrideMs) / 1000}s`;
  } else if (
    result.exitCode !== 0 &&
    !isCancelledResult(result) &&
    !isTimeoutResult(result) &&
    result.stderr.includes("failed to acquire browser from browserctl")
  ) {
    const reason = upstreamReason(result.stderr.trim());
    const outageNow = Date.now();
    setOutage(key, { reason, expiresAtMs: outageNow + OUTAGE_CACHE_TTL_MS }, outageNow);
    result.stderr = reason;
  }
  return result;
}
function throwUpstream(result: ProcessResult): void {
  if (result.exitCode === 0) return;
  if (isCancelledResult(result))
    throw new AgentscrapeCancelledError(result.stderr.trim() || "operation cancelled");
  if (result.stderr.startsWith(UPSTREAM_DOWN_PREFIX))
    throw new AgentscrapeUpstreamDownError(result.stderr);
}
function isTimeoutResult(result: ProcessResult): boolean {
  return (
    result.timedOut ||
    result.stderr.startsWith(AGENT_BROWSER_TIMEOUT_PREFIX) ||
    /\b(?:timed out|timeout(?: of)?(?: .*?)? exceeded)\b/i.test(result.stderr)
  );
}
function isCancelledResult(result: ProcessResult): boolean {
  return result.exitCode === 130 || /\b(?:cancelled|canceled|interrupted)\b/i.test(result.stderr);
}

/** Require a successful agent-browser command while preserving stable operational error types. */
export function requireAgentBrowserSuccess(
  result: ProcessResult,
  command = "agent-browser command failed",
  retryable = true,
): ProcessResult {
  if (result.exitCode === 0) return result;
  const detail = result.stderr.trim() || `agent-browser exited with status ${result.exitCode}`;
  if (isCancelledResult(result)) throw new AgentscrapeCancelledError(detail);
  if (result.stderr.startsWith(UPSTREAM_DOWN_PREFIX))
    throw new AgentscrapeUpstreamDownError(result.stderr);
  if (isTimeoutResult(result))
    throw new AgentscrapeTimeoutError("agent-browser operation timed out");
  if (result.truncated)
    throw new AgentscrapeArtifactError(
      `agent-browser output exceeds the ${AGENT_BROWSER_OUTPUT_MAX_BYTES}-byte limit`,
    );
  throw new AgentscrapeBrowserError(`${command}: ${detail}`, retryable);
}
export async function setMediaMode(
  media?: string | null,
  session?: string | null,
  signal?: AbortSignal,
): Promise<void> {
  if (!media) return;
  const mode = media.toLowerCase();
  if (!["light", "dark"].includes(mode))
    throw new AgentscrapeUsageError(`Invalid media mode '${media}'. Expected light or dark`);
  const result = await runAgentBrowser(
    ["set", "media", mode],
    session,
    undefined,
    undefined,
    signal,
  );
  requireAgentBrowserSuccess(result, `Failed to set media mode: ${mode}`);
}
async function currentUrl(session?: string | null): Promise<string | null> {
  const result = await runAgentBrowser(["eval", "window.location.href"], session);
  throwUpstream(result);
  // Navigation evidence is a best-effort probe; its absence is handled by the primary command.
  return result.exitCode === 0 ? result.stdout.trim().replace(/^"|"$/g, "") : null;
}
async function diagnosticUrl(session?: string | null): Promise<string | null> {
  const active = context();
  try {
    const result = await runAgentBrowser(["eval", "window.location.href"], session);
    if (result.exitCode !== 0) {
      if (isCancelledResult(result))
        throw new AgentscrapeCancelledError(
          result.stderr.trim() || "browser diagnostic was cancelled",
        );
      throwIfAborted(active.signal);
      return null;
    }
    let value: unknown = result.stdout.trim();
    try {
      value = JSON.parse(value as string);
    } catch {
      // Browser wrappers may return a bare URL.
    }
    return typeof value === "string" && value ? redactUrl(value, 768) : null;
  } catch (error) {
    throwIfAborted(active.signal);
    if (error instanceof AgentscrapeCancelledError) throw error;
    return null;
  }
}
function currentUid(): bigint | null {
  return process.getuid ? BigInt(process.getuid()) : null;
}
function secureScreenshotStat(value: HealthStat): boolean {
  const uid = currentUid();
  return (
    uid !== null &&
    value.isFile() &&
    value.uid === uid &&
    value.nlink === 1n &&
    value.size <= SCREENSHOT_MAX_BYTES &&
    (value.mode & 0o177n) === 0n
  );
}
interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}
function ownedScreenshotDirectory(path: string, expected?: DirectoryIdentity): boolean {
  const uid = currentUid();
  const value = lstatSync(path, { bigint: true });
  return (
    uid !== null &&
    value.isDirectory() &&
    !value.isSymbolicLink() &&
    value.uid === uid &&
    (!expected || (value.dev === expected.dev && value.ino === expected.ino))
  );
}
function secureScreenshotDirectory(path: string, expected?: DirectoryIdentity): boolean {
  return (
    ownedScreenshotDirectory(path, expected) &&
    (lstatSync(path, { bigint: true }).mode & 0o077n) === 0n
  );
}
async function retainScreenshot(session?: string | null): Promise<string | undefined> {
  const active = context();
  if (!active.retainArtifacts) return undefined;
  const directory = mkdtempSync(join(tmpdir(), SCREENSHOT_DIRECTORY_PREFIX));
  let retained = false;
  let directoryIdentity: DirectoryIdentity | null = null;
  try {
    const created = lstatSync(directory, { bigint: true });
    directoryIdentity = { dev: created.dev, ino: created.ino };
    chmodSync(directory, 0o700);
    if (!secureScreenshotDirectory(directory, directoryIdentity))
      throw new Error("unsafe screenshot directory");
    const screenshot = join(directory, `${randomUUID()}.png`);
    const captured = await runAgentBrowser(["screenshot", screenshot], session);
    if (captured.exitCode !== 0) {
      if (isCancelledResult(captured))
        throw new AgentscrapeCancelledError(
          captured.stderr.trim() || "browser screenshot was cancelled",
        );
      throw new Error("screenshot capture failed");
    }
    const descriptor = openSync(screenshot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.uid !== currentUid() ||
        before.nlink !== 1n ||
        before.size > SCREENSHOT_MAX_BYTES
      )
        throw new Error("unsafe screenshot artifact");
      fchmodSync(descriptor, 0o600);
      const secured = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(screenshot, { bigint: true });
      if (
        !secureScreenshotStat(secured) ||
        !secureScreenshotStat(named) ||
        named.isSymbolicLink() ||
        secured.dev !== named.dev ||
        secured.ino !== named.ino ||
        !sameHealthStat(secured, fstatSync(descriptor, { bigint: true })) ||
        !sameHealthStat(named, lstatSync(screenshot, { bigint: true }))
      )
        throw new Error("unstable screenshot artifact");
    } finally {
      closeSync(descriptor);
    }
    if (!secureScreenshotDirectory(directory, directoryIdentity))
      throw new Error("unsafe screenshot directory");
    retained = true;
    return directory;
  } catch (error) {
    throwIfAborted(active.signal);
    if (error instanceof AgentscrapeCancelledError) throw error;
    return undefined;
  } finally {
    if (!retained && directoryIdentity) {
      try {
        if (ownedScreenshotDirectory(directory, directoryIdentity))
          rmSync(directory, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort and limited to the exact random directory inode we created.
      }
    }
  }
}
function reachedNavigationTarget(
  current: string | null,
  target: string,
  before: string | null,
): boolean {
  if (!current || current === "about:blank") return false;
  try {
    const actual = new URL(current);
    const requested = new URL(target);
    actual.hash = "";
    requested.hash = "";
    if (actual.href === requested.href) return true;
  } catch {
    // A changed browser-reported value is still useful evidence for non-standard wrappers.
  }
  return before !== null && current !== before;
}

/**
 * Best-effort attach of an operator-established session for this URL. Returns
 * the session name when one was attached, or null when no conduit is
 * configured, none is stored for the origin, or the daemon is unreachable.
 */
async function attachConduitSession(url: string, session?: string | null): Promise<string | null> {
  if (!conduitConfigured()) return null;
  const resolved = await resolveSession(url);
  if (resolved === null) return null;
  const attached = await attachSession(resolved, (args) => runAgentBrowser(args, session));
  return attached ? resolved.sessionName : null;
}

/**
 * Stop before navigating when this origin needs a signed-in browser and no
 * session exists for it.
 *
 * The signal is deliberately the absence of a stored session rather than
 * anything read off the page. An origin's signed-in rule answers "is this
 * session live?" at its probe URL; it cannot answer "is this arbitrary page a
 * login wall?" — a signed-in LinkedIn user reading a job posting is not on
 * /feed. Judging every page by that rule would report a block on every fetch.
 *
 * Failing here rather than after navigating also avoids the worse outcome:
 * extracting a login wall and storing it as though it were the requested
 * content.
 */
async function assertConduitSignedIn(requestedUrl: string, attached: string | null): Promise<void> {
  if (attached !== null || !conduitConfigured()) return;
  const rule = await resolveOrigin(requestedUrl);
  if (rule === null || rule.escalation !== "human_signin") return;
  // Naming which of the two it is matters: "no session" sends a reader looking
  // for something to create, "expired" sends them to replace what is there.
  if (rule.staleSession !== null) {
    throw new AgentscrapeAuthError(
      `${rule.origin} requires a signed-in browser and the stored session ` +
        `'${rule.staleSession.sessionName}' has expired. ` +
        `Replace it with: agentweb signin --origin ${rule.origin}`,
    );
  }
  throw new AgentscrapeAuthError(
    `${rule.origin} requires a signed-in browser and no session is stored. ` +
      `Capture one with: agentweb signin --origin ${rule.origin}`,
  );
}

export async function openPage(
  url: string,
  session?: string | null,
  media?: string | null,
  contentSelector?: string | null,
): Promise<void> {
  const active = context();
  throwIfAborted(active.signal);
  if (!active.allowPrivateNetwork)
    throw new AgentscrapeNetworkPolicyError("browser_egress_unverifiable");
  const requestedUrl = url;
  await setMediaMode(media, session);
  // Attach an operator-established session for this origin before navigating,
  // when a conduit is configured and knows one. Best effort by contract: an
  // absent or unreachable conduit means unauthenticated extraction, never a
  // failed fetch.
  const attachedSession = await attachConduitSession(url, session);
  await assertConduitSignedIn(requestedUrl, attachedSession);
  const before = await currentUrl(session);
  const opened = await runAgentBrowser(["open", url], session);
  throwUpstream(opened);
  const navigationTimedOut = isTimeoutResult(opened);
  const navigationFailed = opened.exitCode !== 0;
  if (navigationFailed && !navigationTimedOut)
    throw new AgentscrapeBrowserError(
      `Failed to open URL: ${opened.stderr.trim() || "browser navigation failed"}`,
    );

  // Network-idle is best-effort when it times out for a busy SPA. Other command failures and
  // browserctl outages are hard failures rather than evidence of a usable page.
  const idle = await runAgentBrowser(["wait", "--load", "networkidle"], session);
  throwUpstream(idle);
  if (idle.exitCode !== 0 && !isTimeoutResult(idle))
    throw new AgentscrapeBrowserError(
      `Failed while waiting for network idle: ${idle.stderr.trim() || "browser wait failed"}`,
    );

  if (contentSelector) {
    // Individual selector waits are retry probes; exhaustion becomes one typed browser failure.
    for (let attempt = 0; attempt < (navigationFailed ? 5 : 2); attempt += 1) {
      const result = await runAgentBrowser(["wait", contentSelector], session);
      throwUpstream(result);
      if (result.exitCode === 0) return;
    }
    const url = await diagnosticUrl(session);
    const artifactDirectory = await retainScreenshot(session);
    throw new AgentscrapeBrowserError(
      url
        ? `Content not found for the requested selector. Current URL: ${url}`
        : "Content not found for the requested selector.",
      true,
      artifactDirectory,
    );
  }

  if (!navigationFailed) return;
  const after = await currentUrl(session);
  if (reachedNavigationTarget(after, url, before)) return;
  if (navigationTimedOut)
    throw new AgentscrapeTimeoutError("browser navigation timed out without final URL evidence");
  throw new AgentscrapeBrowserError(
    `Failed to open URL: ${opened.stderr.trim() || "browser navigation failed"}`,
  );
}
export async function warmClaudeSession(
  session?: string | null,
  media?: string | null,
): Promise<void> {
  await openPage("https://claude.ai", session, media, CLAUDE_APP_READY_SELECTOR);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runAgentBrowser(["eval", "document.body?.innerText || ''"], session);
    requireAgentBrowserSuccess(result, "Failed to inspect Claude session");
    const lowered = result.stdout.toLowerCase();
    if (lowered.includes("new chat")) return;
    if (
      ["continue with google", "continue with email", "meet claude"].every((x) =>
        lowered.includes(x),
      )
    )
      throw new AgentscrapeAuthError("Claude authentication required - browser is not signed in");
    const waited = await runAgentBrowser(["wait", "2000"], session);
    requireAgentBrowserSuccess(waited, "Failed while waiting for the Claude session");
  }
  throw new AgentscrapeBrowserError("Claude session did not reach the signed-in app");
}
export async function closeSession(session?: string | null, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let result: ProcessResult;
  try {
    result = await runProcess(
      [resolveBrowser(), "--session", session || defaultSession(), "close"],
      {
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    throwIfAborted(signal);
    if (/not found on PATH|ENOENT|no such file/i.test(asError(error).message))
      throw new AgentscrapeUpstreamDownError("Failed to close browser session");
    throw new AgentscrapeBrowserError("Failed to close browser session");
  }
  throwIfAborted(signal);
  requireAgentBrowserSuccess(result, "Failed to close browser session");
}

/** Internal cleanup path; explicit session closes must use closeSession instead. */
export async function closeSessionBestEffort(session: string): Promise<void> {
  try {
    await closeSession(session);
  } catch {
    // Automatic cleanup must not replace the operation's value or failure.
  }
}

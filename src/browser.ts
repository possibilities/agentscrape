import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentscrapeAuthError,
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeTimeoutError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  asError,
  throwIfAborted,
} from "./errors";
import { findExecutable, type ProcessResult, runProcess } from "./subprocess";

export const AGENT_BROWSER_BIN_ENV = "AGENTSCRAPE_AGENT_BROWSER_BIN";
export const AGENT_BROWSER_TIMEOUT_ENV = "AGENTSCRAPE_AGENT_BROWSER_TIMEOUT";
export const AGENT_BROWSER_TIMEOUT_PREFIX = "agent-browser timed out after ";
export const UPSTREAM_DOWN_PREFIX = "upstream down: ";
export const CLAUDE_APP_READY_SELECTOR = "[data-testid='account-settings'], main";
let unavailableReason: string | null = null;
export interface BrowserSessionScope {
  name: string;
  owned: boolean;
  used: boolean;
}
interface BrowserContext {
  profile: string | null;
  signal: AbortSignal | null;
  session: BrowserSessionScope | null;
}
const browserContext = new AsyncLocalStorage<BrowserContext>();
function context(): BrowserContext {
  return browserContext.getStore() ?? { profile: null, signal: null, session: null };
}

function defaultSession(): string {
  return `agentscrape-${process.pid}`;
}
function freshSession(): string {
  return `agentscrape-${process.pid}-${randomUUID().replaceAll("-", "")}`;
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
function knownUpstreamDown(): string | null {
  const path = join(runtimeHome(), ".local/state/browserctl/check-health-state.yaml");
  if (!existsSync(path)) return null;
  try {
    const state = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (state.is_down !== true || typeof state.last_run_at !== "string") return null;
    const age = Date.now() - new Date(state.last_run_at).getTime();
    if (!Number.isFinite(age) || age > 15 * 60_000) return null;
    return `browserctl: ${typeof state.reason === "string" ? state.reason : "browserctl is down"}`;
  } catch {
    return null;
  }
}
export function resetBrowserUnavailableCache(): void {
  unavailableReason = null;
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
export async function withBrowserSession<T>(
  requested: string | null | undefined,
  fn: (scope: BrowserSessionScope, owner: boolean) => Promise<T>,
): Promise<T> {
  const active = context();
  if (!requested && active.session)
    return browserContext.run({ ...active, session: active.session }, () =>
      fn(active.session!, false),
    );

  const scope: BrowserSessionScope = requested
    ? { name: requested, owned: false, used: false }
    : { name: freshSession(), owned: true, used: false };
  const owner = scope.owned;
  const capturedName = scope.name;
  try {
    return await browserContext.run({ ...active, session: scope }, () => fn(scope, owner));
  } finally {
    if (owner && scope.used) await closeSession(capturedName);
  }
}
function resolveBrowser(): string {
  const override = process.env[AGENT_BROWSER_BIN_ENV];
  if (override) return findExecutable(override) || override;
  const managed = join(runtimeHome(), ".local/bin/agent-browser");
  return (
    (existsSync(managed) && findExecutable(managed)) ||
    findExecutable("agent-browser") ||
    "agent-browser"
  );
}
export async function runAgentBrowser(
  args: string[],
  session?: string | null,
  browserProfile?: string | null,
  timeoutOverrideMs?: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const active = context();
  const selectedSession = resolveBrowserSession(session, active);
  const selectedSignal = signal ?? active.signal;
  throwIfAborted(selectedSignal);
  if (unavailableReason === null) {
    const reason = knownUpstreamDown();
    if (reason) unavailableReason = `${UPSTREAM_DOWN_PREFIX}${reason}`;
  }
  if (unavailableReason !== null) {
    return {
      argv: ["agent-browser"],
      exitCode: 1,
      stdout: "",
      stderr: unavailableReason,
      timedOut: false,
      truncated: false,
    };
  }
  const argv = [resolveBrowser(), "--session", selectedSession];
  const profile = browserProfile || active.profile;
  if (profile) argv.push("--browserctl-profile", profile);
  argv.push(...args);
  let result: ProcessResult;
  try {
    result = await runProcess(argv, {
      timeoutMs: timeoutMs(timeoutOverrideMs),
      maxOutputBytes: 8_000_000,
      ...(selectedSignal ? { signal: selectedSignal } : {}),
    });
  } catch (error) {
    throwIfAborted(selectedSignal);
    const value = asError(error);
    const missingExecutable = /not found on PATH|ENOENT|no such file/i.test(value.message);
    throw new AgentscrapeBrowserError(
      `Failed to run agent-browser: ${value.message}`,
      !missingExecutable,
    );
  }
  throwIfAborted(selectedSignal);
  if (result.timedOut) {
    result.stderr = `${AGENT_BROWSER_TIMEOUT_PREFIX}${timeoutMs(timeoutOverrideMs) / 1000}s: ${argv.join(" ")}`;
  } else if (
    result.exitCode !== 0 &&
    result.stderr.includes("failed to acquire browser from browserctl")
  ) {
    unavailableReason = `${UPSTREAM_DOWN_PREFIX}${result.stderr.trim()}`;
    result.stderr = unavailableReason;
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
  if (isTimeoutResult(result)) throw new AgentscrapeTimeoutError(detail);
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
async function diagnostics(session?: string | null): Promise<Record<string, string>> {
  const evalValue = async (expression: string) => {
    const result = await runAgentBrowser(["eval", expression], session);
    throwUpstream(result);
    // Diagnostics never replace the primary browser failure.
    return result.exitCode === 0 ? result.stdout.trim().replace(/^"|"$/g, "") : "";
  };
  const screenshot = `/tmp/agentscrape-debug-${process.pid}.png`;
  const [url, title, hint] = await Promise.all([
    evalValue("window.location.href"),
    evalValue("document.title"),
    evalValue("document.body?.innerText?.substring(0, 200) || ''"),
  ]);
  const captured = await runAgentBrowser(["screenshot", screenshot], session);
  throwUpstream(captured);
  // Screenshot capture is also diagnostic-only and may fail without changing classification.
  return { url, title, hint, screenshot };
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

export async function openPage(
  url: string,
  session?: string | null,
  media?: string | null,
  contentSelector?: string | null,
): Promise<void> {
  await setMediaMode(media, session);
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
    const info = await diagnostics(session);
    throw new AgentscrapeBrowserError(
      `Content not found (selector: ${contentSelector})\n  URL:        ${info.url}\n  Title:      ${info.title}\n  Body hint:  ${info.hint}\n  Screenshot: ${info.screenshot}`,
    );
  }

  if (!navigationFailed) return;
  const after = await currentUrl(session);
  if (reachedNavigationTarget(after, url, before)) return;
  if (navigationTimedOut)
    throw new AgentscrapeTimeoutError(
      opened.stderr || `Navigation to ${url} timed out without final URL evidence`,
    );
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
  // Session close is cleanup-only: a completed nonzero command is intentionally best-effort.
  await runProcess([resolveBrowser(), "--session", session || defaultSession(), "close"], {
    timeoutMs: 30_000,
    maxOutputBytes: 64_000,
    ...(signal ? { signal } : {}),
  });
}

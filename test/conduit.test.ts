import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachSession,
  CONDUIT_SOCKET_ENV,
  CONDUIT_TOKEN_FILE_ENV,
  conduitConfigured,
  evaluateSignedIn,
  type OriginRule,
  resolveOrigin,
  resolveSession,
} from "../src/conduit";

const temporary: string[] = [];
const priorSocket = process.env[CONDUIT_SOCKET_ENV];
const priorToken = process.env[CONDUIT_TOKEN_FILE_ENV];

afterEach(() => {
  if (priorSocket === undefined) delete process.env[CONDUIT_SOCKET_ENV];
  else process.env[CONDUIT_SOCKET_ENV] = priorSocket;
  if (priorToken === undefined) delete process.env[CONDUIT_TOKEN_FILE_ENV];
  else process.env[CONDUIT_TOKEN_FILE_ENV] = priorToken;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "agentscrape-conduit-"));
  temporary.push(value);
  return value;
}

function tokenFile(contents = "worker-token-value"): string {
  const path = join(root(), "worker-token");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

describe("conduit configuration", () => {
  test("is unconfigured unless both a socket and a readable token are present", () => {
    delete process.env[CONDUIT_SOCKET_ENV];
    delete process.env[CONDUIT_TOKEN_FILE_ENV];
    expect(conduitConfigured()).toBeFalse();

    process.env[CONDUIT_SOCKET_ENV] = "/nonexistent/agentweb.sock";
    expect(conduitConfigured()).toBeFalse();

    process.env[CONDUIT_TOKEN_FILE_ENV] = join(root(), "missing-token");
    expect(conduitConfigured()).toBeFalse();

    process.env[CONDUIT_TOKEN_FILE_ENV] = tokenFile();
    expect(conduitConfigured()).toBeTrue();
  });

  test("an empty token file leaves the conduit unconfigured", () => {
    process.env[CONDUIT_SOCKET_ENV] = "/nonexistent/agentweb.sock";
    process.env[CONDUIT_TOKEN_FILE_ENV] = tokenFile("   \n");
    expect(conduitConfigured()).toBeFalse();
  });
});

describe("session resolution degrades instead of failing", () => {
  test("returns null with no conduit configured", async () => {
    delete process.env[CONDUIT_SOCKET_ENV];
    delete process.env[CONDUIT_TOKEN_FILE_ENV];
    expect(await resolveSession("https://x.com/a/status/1")).toBeNull();
  });

  test("returns null when the daemon socket is unreachable", async () => {
    process.env[CONDUIT_SOCKET_ENV] = join(root(), "absent.sock");
    process.env[CONDUIT_TOKEN_FILE_ENV] = tokenFile();
    // An unreachable conduit must mean unauthenticated extraction, never a throw.
    expect(await resolveSession("https://x.com/a/status/1")).toBeNull();
  });
});

describe("session attachment", () => {
  test("writes private state, loads it, and removes it afterward", async () => {
    const seen: { args: string[]; contents: string; mode: number }[] = [];
    const attached = await attachSession(
      { sessionName: "x-auth", origin: "https://x.com", state: '{"cookies":[]}' },
      async (args) => {
        const path = args[2] as string;
        const { mode } = await import("node:fs").then((fs) => fs.statSync(path));
        seen.push({ args, contents: readFileSync(path, "utf8"), mode: mode & 0o777 });
        return { exitCode: 0 };
      },
    );

    expect(attached).toBeTrue();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args.slice(0, 2)).toEqual(["state", "load"]);
    expect(seen[0]!.contents).toBe('{"cookies":[]}');
    expect(seen[0]!.mode).toBe(0o600);
    // The temporary state file must not outlive the call.
    expect(existsSyncSafe(seen[0]!.args[2] as string)).toBeFalse();
  });

  test("a failing or throwing loader reports no attachment and still cleans up", async () => {
    let path = "";
    expect(
      await attachSession(
        { sessionName: "x-auth", origin: "https://x.com", state: '{"cookies":[]}' },
        async (args) => {
          path = args[2] as string;
          return { exitCode: 1 };
        },
      ),
    ).toBeFalse();
    expect(existsSyncSafe(path)).toBeFalse();

    expect(
      await attachSession(
        { sessionName: "x-auth", origin: "https://x.com", state: '{"cookies":[]}' },
        async (args) => {
          path = args[2] as string;
          throw new Error("driver exploded");
        },
      ),
    ).toBeFalse();
    expect(existsSyncSafe(path)).toBeFalse();
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

describe("origin rule evaluation", () => {
  const rule = (over: Partial<OriginRule>): OriginRule => ({
    origin: "https://www.linkedin.com",
    signedInKind: "url_contains",
    signedInValue: "/feed",
    escalation: "human_signin",
    staleSession: null,
    ...over,
  });

  test("a login wall is detected as signed out", () => {
    const wall = { url: "https://www.linkedin.com/login", text: "Sign in", selectorHits: 0 };
    expect(evaluateSignedIn(rule({}), wall)).toBeFalse();
    expect(
      evaluateSignedIn(rule({ signedInKind: "text", signedInValue: "My jobs" }), wall),
    ).toBeFalse();
  });

  test("a signed-in page passes each rule kind", () => {
    expect(
      evaluateSignedIn(rule({}), {
        url: "https://www.linkedin.com/feed/",
        text: "",
        selectorHits: 0,
      }),
    ).toBeTrue();
    expect(
      evaluateSignedIn(rule({ signedInKind: "text", signedInValue: "My jobs" }), {
        url: "",
        text: "My jobs today",
        selectorHits: 0,
      }),
    ).toBeTrue();
    expect(
      evaluateSignedIn(rule({ signedInKind: "selector", signedInValue: "[data-x]" }), {
        url: "",
        text: "",
        selectorHits: 2,
      }),
    ).toBeTrue();
  });

  test("an origin without a rule is never treated as blocked", () => {
    expect(
      evaluateSignedIn(rule({ signedInKind: "none", signedInValue: null }), {
        url: "https://www.linkedin.com/login",
        text: "Sign in",
        selectorHits: 0,
      }),
    ).toBeTrue();
  });

  test("origin resolution returns null with no conduit reachable", async () => {
    delete process.env[CONDUIT_SOCKET_ENV];
    expect(await resolveOrigin("https://www.linkedin.com/jobs/view/1")).toBeNull();
  });
});

describe("stale sessions are named as such", () => {
  test("a stale session is reported distinctly from a missing one", () => {
    // The remedy differs in kind: one creates a session, the other replaces it.
    const missing: OriginRule = {
      origin: "https://x.com",
      signedInKind: "url_contains",
      signedInValue: "/home",
      escalation: "human_signin",
      staleSession: null,
    };
    const stale: OriginRule = {
      ...missing,
      staleSession: { sessionName: "x-auth", reason: "the site no longer accepts it" },
    };
    expect(missing.staleSession).toBeNull();
    expect(stale.staleSession?.sessionName).toBe("x-auth");
  });
});

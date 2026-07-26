import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLinks, fetchMarkdown } from "../src/api";
import {
  AGENT_BROWSER_BIN_ENV,
  resetBrowserUnavailableCache,
  runAgentBrowser,
  withBrowserSession,
} from "../src/browser";

const temporary: string[] = [];
const originalBrowser = process.env[AGENT_BROWSER_BIN_ENV];
const originalHome = process.env.HOME;
const originalInterleave = process.env.AGENTSCRAPE_TEST_INTERLEAVE;
const originalState = process.env.AGENTSCRAPE_TEST_STATE;
const originalFetch = globalThis.fetch;

afterEach(() => {
  resetBrowserUnavailableCache();
  if (originalBrowser === undefined) delete process.env[AGENT_BROWSER_BIN_ENV];
  else process.env[AGENT_BROWSER_BIN_ENV] = originalBrowser;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalInterleave === undefined) delete process.env.AGENTSCRAPE_TEST_INTERLEAVE;
  else process.env.AGENTSCRAPE_TEST_INTERLEAVE = originalInterleave;
  if (originalState === undefined) delete process.env.AGENTSCRAPE_TEST_STATE;
  else process.env.AGENTSCRAPE_TEST_STATE = originalState;
  globalThis.fetch = originalFetch;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface BrowserEvent {
  session: string;
  command: string[];
}

interface Fixture {
  root: string;
  home: string;
  events: string;
}

function fixture(interleave = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentscrape-browser-session-"));
  temporary.push(root);
  const home = join(root, "home");
  const state = join(root, "state");
  const browser = join(root, "agent-browser");
  const events = join(state, "events.jsonl");
  mkdirSync(home);
  mkdirSync(state);
  writeFileSync(
    browser,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "--session" || !args[1]) process.exit(90);
const session = args[1];
const command = args.slice(2);
const stateRoot = process.env.AGENTSCRAPE_TEST_STATE;
const key = Buffer.from(session).toString("hex");
const sessionRoot = join(stateRoot, key);
mkdirSync(sessionRoot, { recursive: true });
appendFileSync(join(stateRoot, "events.jsonl"), JSON.stringify({ session, command }) + "\\n");
const closed = join(sessionRoot, "closed");
if (command[0] === "close") {
  writeFileSync(closed, "closed");
  process.exit(0);
}
if (existsSync(closed)) {
  console.error("command used a closed session: " + session);
  process.exit(91);
}
if (command[0] === "open") {
  writeFileSync(join(sessionRoot, "url"), command[1]);
  if (process.env.AGENTSCRAPE_TEST_INTERLEAVE === "1") {
    writeFileSync(join(stateRoot, "open-" + process.pid), session);
    const deadline = Date.now() + 5000;
    while (readdirSync(stateRoot).filter((name) => name.startsWith("open-")).length < 2) {
      if (Date.now() > deadline) process.exit(92);
      await Bun.sleep(5);
    }
  }
  process.exit(0);
}
if (command[0] === "wait" || command[0] === "set") process.exit(0);
if (command[0] !== "eval") process.exit(93);
const expression = command[1] || "";
const urlPath = join(sessionRoot, "url");
if (expression === "window.location.href") {
  const url = existsSync(urlPath) ? readFileSync(urlPath, "utf8") + "#final" : "about:blank";
  console.log(JSON.stringify(url));
} else if (expression === "document.documentElement.outerHTML") {
  console.log(JSON.stringify("<html><body><main>Session body</main></body></html>"));
} else if (expression.includes("rootCount")) {
  console.log(JSON.stringify({ rootCount: 1, links: [{ url: "/docs/child", title: "Child", category: "" }] }));
} else if (expression.includes("return {html:")) {
  console.log(JSON.stringify({ html: "<main>Session body</main>" }));
} else if (expression.includes("const hasText")) {
  console.log(JSON.stringify("body"));
} else {
  console.log("null");
}
`,
  );
  chmodSync(browser, 0o755);
  process.env[AGENT_BROWSER_BIN_ENV] = browser;
  process.env.HOME = home;
  process.env.AGENTSCRAPE_TEST_STATE = state;
  if (interleave) process.env.AGENTSCRAPE_TEST_INTERLEAVE = "1";
  else delete process.env.AGENTSCRAPE_TEST_INTERLEAVE;
  return { root, home, events };
}

function events(value: Fixture): BrowserEvent[] {
  if (!existsSync(value.events)) return [];
  return readFileSync(value.events, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BrowserEvent);
}

function closes(items: BrowserEvent[]): BrowserEvent[] {
  return items.filter((item) => item.command[0] === "close");
}

function expectOwnedSessions(items: BrowserEvent[], count: number): string[] {
  const names = [...new Set(items.map((item) => item.session))];
  expect(names).toHaveLength(count);
  for (const name of names) {
    expect(name).toMatch(/^agentscrape-\d+-[0-9a-f]{32}$/);
    expect(name.length).toBeLessThanOrEqual(80);
  }
  return names;
}

const genericOptions = { generic: true, selector: "main", envelope: true } as const;

describe("owned browser session scopes", () => {
  test("concurrent implicit fetchMarkdown roots interleave without sharing or premature close", async () => {
    const value = fixture(true);
    const [first, second] = await Promise.all([
      fetchMarkdown("https://example.com/slow", genericOptions),
      fetchMarkdown("https://example.com/fast", genericOptions),
    ]);

    expect(first).toMatchObject({ status: "success" });
    expect(second).toMatchObject({ status: "success" });
    const items = events(value);
    const names = expectOwnedSessions(items, 2);
    expect(
      closes(items)
        .map((item) => item.session)
        .sort(),
    ).toEqual([...names].sort());
    for (const name of names) {
      const own = items.filter((item) => item.session === name);
      expect(own.filter((item) => item.command[0] === "close")).toHaveLength(1);
      const finalEval = own
        .map((item) => item.command.join(" "))
        .lastIndexOf("eval window.location.href");
      const close = own.findIndex((item) => item.command[0] === "close");
      expect(finalEval).toBeGreaterThanOrEqual(0);
      expect(finalEval).toBeLessThan(close);
    }
  });

  test("concurrent implicit fetchMarkdown and fetchLinks each own one session", async () => {
    const value = fixture(true);
    const [markdown, links] = await Promise.all([
      fetchMarkdown("https://example.com/page", genericOptions),
      fetchLinks("https://example.com/docs", { sectionSelector: ".links" }),
    ]);

    expect(markdown).toMatchObject({ status: "success" });
    expect(links.links).toHaveLength(1);
    const items = events(value);
    const names = expectOwnedSessions(items, 2);
    expect(
      closes(items)
        .map((item) => item.session)
        .sort(),
    ).toEqual([...names].sort());
  });

  test("explicit shared names are exact and caller-owned", async () => {
    const value = fixture();
    await Promise.all([
      fetchMarkdown("https://example.com/one", { ...genericOptions, session: "shared exact" }),
      fetchMarkdown("https://example.com/two", { ...genericOptions, session: "shared exact" }),
    ]);

    const items = events(value);
    expect(new Set(items.map((item) => item.session))).toEqual(new Set(["shared exact"]));
    expect(closes(items)).toHaveLength(0);
  });

  test("nested omitted operations inherit once, explicit overrides are not closed, and parent restores", async () => {
    const value = fixture();
    let rootName = "";
    await withBrowserSession(undefined, async (scope, owner) => {
      rootName = scope.name;
      expect(owner).toBeTrue();
      await fetchMarkdown("https://example.com/implicit", genericOptions);
      await fetchMarkdown("https://example.com/explicit", {
        ...genericOptions,
        session: "nested-explicit",
      });
      await runAgentBrowser(["eval", "window.location.href"]);
    });

    const items = events(value);
    expect(items.some((item) => item.session === rootName)).toBeTrue();
    expect(items.some((item) => item.session === "nested-explicit")).toBeTrue();
    expect(closes(items).map((item) => item.session)).toEqual([rootName]);
    expect(items.at(-1)).toMatchObject({ session: rootName, command: ["close"] });
  });

  test("named and inherited scope metadata preserves exact object identity", async () => {
    let inherited: unknown;
    await withBrowserSession("caller-name", async (named, namedOwner) => {
      expect(named).toEqual({ name: "caller-name", owned: false, used: false });
      expect(namedOwner).toBeFalse();
      await withBrowserSession(null, async (scope, owner) => {
        inherited = scope;
        expect(owner).toBeFalse();
      });
      expect(inherited).toBe(named);
    });
  });
});

describe("browser-free and low-level session behavior", () => {
  test("direct Markdown, offline HTML, and invalid requests issue no browser command or close", async () => {
    const value = fixture();
    globalThis.fetch = (async () =>
      new Response("# Direct", { status: 200 })) as unknown as typeof fetch;

    const direct = await fetchMarkdown("https://example.com/readme.md");
    expect(direct).toMatchObject({ markdown: "# Direct" });
    await expect(
      fetchMarkdown("https://x.com/example/status/123", {
        preset: "x-tweet",
        html: "<html><body>offline malformed input</body></html>",
      }),
    ).rejects.toThrow();
    await expect(fetchMarkdown("not a URL")).rejects.toThrow();
    expect(events(value)).toEqual([]);
  });

  test("runAgentBrowser outside a scope retains the PID fallback", async () => {
    const value = fixture();
    const result = await runAgentBrowser(["eval", "window.location.href"]);
    expect(result.exitCode).toBe(0);
    expect(events(value)).toEqual([
      { session: `agentscrape-${process.pid}`, command: ["eval", "window.location.href"] },
    ]);
  });

  test("a cached health result marks an owned scope used and closes that exact name", async () => {
    const value = fixture();
    const health = join(value.home, ".local/state/browserctl");
    mkdirSync(health, { recursive: true });
    writeFileSync(
      join(health, "check-health-state.yaml"),
      `is_down: true\nlast_run_at: ${new Date().toISOString()}\nreason: test outage\n`,
    );
    let name = "";
    await withBrowserSession(undefined, async (scope) => {
      name = scope.name;
      const result = await runAgentBrowser(["open", "https://example.com"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("upstream down");
    });

    expect(events(value)).toEqual([{ session: name, command: ["close"] }]);
  });

  test("nested inherited scopes share outage keys while independent implicit roots isolate", async () => {
    const value = fixture();
    const health = join(value.home, ".local/state/browserctl/check-health-state.yaml");
    mkdirSync(join(value.home, ".local/state/browserctl"), { recursive: true });
    writeFileSync(
      health,
      `is_down: true\nlast_run_at: ${new Date().toISOString()}\nreason: scoped outage\n`,
    );
    let firstName = "";
    await withBrowserSession(undefined, async (scope) => {
      firstName = scope.name;
      expect((await runAgentBrowser(["eval", "first"])).exitCode).toBe(1);
      rmSync(health);
      await withBrowserSession(undefined, async (nested) => {
        expect(nested).toBe(scope);
        expect((await runAgentBrowser(["eval", "nested"])).exitCode).toBe(1);
      });
    });

    let secondName = "";
    await withBrowserSession(undefined, async (scope) => {
      secondName = scope.name;
      expect((await runAgentBrowser(["eval", "window.location.href"])).exitCode).toBe(0);
    });
    expect(secondName).not.toBe(firstName);
    expect(events(value)).toEqual([
      { session: firstName, command: ["close"] },
      { session: secondName, command: ["eval", "window.location.href"] },
      { session: secondName, command: ["close"] },
    ]);
  });
});

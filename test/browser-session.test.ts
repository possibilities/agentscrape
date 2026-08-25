import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
  AGENT_BROWSER_SESSION_ENV,
  closeSession,
  currentBrowserArtifactRetention,
  openPage,
  resetBrowserUnavailableCache,
  runAgentBrowser,
  withBrowserArtifactRetention,
  withBrowserNetworkPolicy,
  withBrowserSession,
  withBrowserSignal,
} from "../src/browser";
import { checkPresets } from "../src/canary";
import { captureCorpus } from "../src/corpus";
import {
  AgentscrapeBrowserError,
  AgentscrapeCancelledError,
  AgentscrapeNetworkPolicyError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
} from "../src/errors";
import { loadRegistry, scrapeWithPreset } from "../src/presets";

const temporary: string[] = [];
const originalBrowser = process.env[AGENT_BROWSER_BIN_ENV];
const originalHome = process.env.HOME;
const originalInterleave = process.env.AGENTSCRAPE_TEST_INTERLEAVE;
const originalState = process.env.AGENTSCRAPE_TEST_STATE;
const originalMissingSelector = process.env.AGENTSCRAPE_TEST_MISSING_SELECTOR;
const originalTruncatedHtml = process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML;
const originalCloseExit = process.env.AGENTSCRAPE_TEST_CLOSE_EXIT;
const originalCloseStderr = process.env.AGENTSCRAPE_TEST_CLOSE_STDERR;
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
  if (originalMissingSelector === undefined) delete process.env.AGENTSCRAPE_TEST_MISSING_SELECTOR;
  else process.env.AGENTSCRAPE_TEST_MISSING_SELECTOR = originalMissingSelector;
  if (originalTruncatedHtml === undefined) delete process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML;
  else process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML = originalTruncatedHtml;
  if (originalCloseExit === undefined) delete process.env.AGENTSCRAPE_TEST_CLOSE_EXIT;
  else process.env.AGENTSCRAPE_TEST_CLOSE_EXIT = originalCloseExit;
  if (originalCloseStderr === undefined) delete process.env.AGENTSCRAPE_TEST_CLOSE_STDERR;
  else process.env.AGENTSCRAPE_TEST_CLOSE_STDERR = originalCloseStderr;
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
  if (process.env.AGENTSCRAPE_TEST_CLOSE_STDERR) {
    console.error(process.env.AGENTSCRAPE_TEST_CLOSE_STDERR);
  }
  const selectedExit = Number(process.env.AGENTSCRAPE_TEST_CLOSE_EXIT ?? "0");
  process.exit(Number.isInteger(selectedExit) && selectedExit >= 0 && selectedExit <= 255 ? selectedExit : 94);
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
if (command[0] === "screenshot") {
  writeFileSync(command[1], "png");
  process.exit(0);
}
if (
  command[0] === "wait" &&
  process.env.AGENTSCRAPE_TEST_MISSING_SELECTOR === "1" &&
  command[1] !== "--load"
) process.exit(1);
if (command[0] === "wait" || command[0] === "set") process.exit(0);
if (command[0] !== "eval") process.exit(93);
const expression = command[1] || "";
const urlPath = join(sessionRoot, "url");
if (expression === "window.location.href") {
  const url = existsSync(urlPath) ? readFileSync(urlPath, "utf8") + "#final" : "about:blank";
  console.log(JSON.stringify(url));
} else if (expression === "document.documentElement.outerHTML") {
  const html = process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML === "1"
    ? "<html>" + "x".repeat(8_100_000) + "</html>"
    : "<html><body><main>Session body</main></body></html>";
  console.log(JSON.stringify(html));
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
  delete process.env.AGENTSCRAPE_TEST_CLOSE_EXIT;
  delete process.env.AGENTSCRAPE_TEST_CLOSE_STDERR;
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

const genericOptions = {
  generic: true,
  selector: "main",
  envelope: true,
  allowPrivateNetwork: true,
} as const;

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
      fetchLinks("https://example.com/docs", {
        sectionSelector: ".links",
        allowPrivateNetwork: true,
      }),
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

  test("live API destinations retain both private HTML sidecars only on exact opt-in", async () => {
    const value = fixture();
    const defaultDestination = join(value.root, "default.md");
    const retainedDestination = join(value.root, "retained.md");
    await fetchMarkdown("https://example.com/default", {
      generic: true,
      destination: defaultDestination,
      allowPrivateNetwork: true,
    });
    expect(existsSync(join(value.root, "default.raw.html"))).toBeFalse();
    expect(existsSync(join(value.root, "default.selected.html"))).toBeFalse();

    const retained = await fetchMarkdown("https://example.com/retained", {
      generic: true,
      destination: retainedDestination,
      retainArtifacts: true,
      allowPrivateNetwork: true,
    });
    expect(retained).toMatchObject({
      full_html: "<html><body><main>Session body</main></body></html>",
      selected_html: "<main>Session body</main>",
    });
    for (const name of ["retained.raw.html", "retained.selected.html"]) {
      const path = join(value.root, name);
      expect(existsSync(path)).toBeTrue();
      expect(lstatSync(path).mode & 0o077).toBe(0);
    }
  });

  test("generic extraction does not materialize oversized raw HTML without retention", async () => {
    const value = fixture();
    process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML = "1";

    const result = await fetchMarkdown("https://example.com/large-shell", {
      generic: true,
      selector: "main",
      allowPrivateNetwork: true,
    });

    expect(result).toMatchObject({
      full_html: "",
      selected_html: "<main>Session body</main>",
      markdown: "Session body",
    });
    expect(
      events(value).some(
        (item) => item.command.join(" ") === "eval document.documentElement.outerHTML",
      ),
    ).toBeFalse();
  });

  test("envelope retention rejects before any browser command or file write", async () => {
    const value = fixture();
    const destination = join(value.root, "forbidden.json");
    await expect(
      fetchMarkdown("https://example.com/page", {
        envelope: true,
        generic: true,
        retainArtifacts: true,
        destination,
        allowPrivateNetwork: true,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    expect(events(value)).toEqual([]);
    expect(existsSync(destination)).toBeFalse();
  });

  test("omitted retention inherits for sidecars and explicit false narrows sidecars and screenshots", async () => {
    const value = fixture();
    await withBrowserArtifactRetention(true, async () => {
      expect(currentBrowserArtifactRetention()).toBeTrue();
      await fetchMarkdown("https://example.com/inherited", {
        generic: true,
        destination: join(value.root, "inherited.md"),
        allowPrivateNetwork: true,
      });
      expect(existsSync(join(value.root, "inherited.raw.html"))).toBeTrue();
      expect(existsSync(join(value.root, "inherited.selected.html"))).toBeTrue();

      await fetchMarkdown("https://example.com/narrowed", {
        generic: true,
        destination: join(value.root, "narrowed.md"),
        retainArtifacts: false,
        allowPrivateNetwork: true,
      });
      expect(existsSync(join(value.root, "narrowed.raw.html"))).toBeFalse();
      expect(existsSync(join(value.root, "narrowed.selected.html"))).toBeFalse();
      process.env.AGENTSCRAPE_TEST_MISSING_SELECTOR = "1";
      await expect(
        fetchMarkdown("https://x.com/example/status/1", {
          retainArtifacts: false,
          allowPrivateNetwork: true,
        }),
      ).rejects.toThrow("Content not found");
    });
    expect(currentBrowserArtifactRetention()).toBeFalse();
    expect(events(value).some((item) => item.command[0] === "screenshot")).toBeFalse();
  });

  test("inherited retention rejects envelope mode before operation effects", async () => {
    const value = fixture();
    const destination = join(value.root, "inherited-forbidden.json");
    let returned = false;
    await withBrowserArtifactRetention(true, async () => {
      try {
        await fetchMarkdown("https://example.com/page", {
          envelope: true,
          generic: true,
          destination,
          allowPrivateNetwork: true,
        });
        returned = true;
      } catch (error) {
        expect(error).toBeInstanceOf(AgentscrapeUsageError);
      }
    });
    expect(returned).toBeFalse();
    expect(events(value)).toEqual([]);
    expect(existsSync(destination)).toBeFalse();
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
      await withBrowserNetworkPolicy(true, () => runAgentBrowser(["eval", "window.location.href"]));
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

  test("failed automatic close preserves the exact callback failure and captured name", async () => {
    const value = fixture();
    process.env.AGENTSCRAPE_TEST_CLOSE_EXIT = "7";
    process.env.AGENTSCRAPE_TEST_CLOSE_STDERR = "automatic close failed";
    const sentinel = new Error("callback sentinel");
    let capturedName = "";
    let observed: unknown;

    try {
      await withBrowserSession(undefined, async (scope) => {
        capturedName = scope.name;
        await runAgentBrowser(["open", "about:blank"]);
        scope.name = "mutated-after-use";
        throw sentinel;
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(sentinel);
    expect(events(value)).toEqual([
      { session: capturedName, command: ["open", "about:blank"] },
      { session: capturedName, command: ["close"] },
    ]);
  });

  test("automatic close spawn failure preserves the exact successful value", async () => {
    const value = fixture();
    const sentinel = { exact: "return sentinel" };
    let capturedName = "";

    const observed = await withBrowserSession(undefined, async (scope) => {
      capturedName = scope.name;
      await runAgentBrowser(["open", "about:blank"]);
      rmSync(join(value.root, "agent-browser"));
      return sentinel;
    });

    expect(observed).toBe(sentinel);
    expect(events(value)).toEqual([{ session: capturedName, command: ["open", "about:blank"] }]);
  });
});

describe("strict browser session close", () => {
  test("completed nonzero close is a retryable, redacted, bounded browser failure", async () => {
    const value = fixture();
    process.env.AGENTSCRAPE_TEST_CLOSE_EXIT = "7";
    process.env.AGENTSCRAPE_TEST_CLOSE_STDERR = `token=STRICT-CLOSE-SECRET ${"diagnostic ".repeat(600)}`;
    let observed: unknown;

    try {
      await closeSession("strict-close");
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AgentscrapeBrowserError);
    const failure = observed as AgentscrapeBrowserError;
    expect(failure.retryable).toBeTrue();
    expect(failure.message).toStartWith("Failed to close browser session");
    expect(failure.message).not.toContain("STRICT-CLOSE-SECRET");
    expect(new TextEncoder().encode(failure.message).byteLength).toBeLessThanOrEqual(1024);
    expect(events(value)).toEqual([{ session: "strict-close", command: ["close"] }]);
  });

  test("exit zero succeeds despite incidental close stderr", async () => {
    const value = fixture();
    process.env.AGENTSCRAPE_TEST_CLOSE_STDERR = "incidental close warning";

    await closeSession("successful-close");

    expect(events(value)).toEqual([{ session: "successful-close", command: ["close"] }]);
  });

  test("pre-cancellation wins and a missing executable is an unavailable dependency", async () => {
    const value = fixture();
    const missing = join(value.root, "missing-agent-browser");
    process.env[AGENT_BROWSER_BIN_ENV] = missing;
    const controller = new AbortController();
    controller.abort(new Error("cancel close first"));

    await expect(closeSession("cancelled-close", controller.signal)).rejects.toBeInstanceOf(
      AgentscrapeCancelledError,
    );

    let observed: unknown;
    try {
      await closeSession("missing-close");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AgentscrapeUpstreamDownError);
    expect((observed as Error).message).toBe("Failed to close browser session");
    expect((observed as Error).message).not.toContain(missing);
    expect(events(value)).toEqual([]);
  });
});

describe("browser network consent", () => {
  test("rejects API and low-level HTTP navigation without commands or synthetic closes", async () => {
    const value = fixture();
    const markdown = await fetchMarkdown("https://example.com/page", {
      generic: true,
      selector: "main",
      envelope: true,
    });
    expect(markdown).toMatchObject({
      status: "failure",
      failure: { failure_class: "invalid_request", retryable: false },
    });
    await expect(
      fetchLinks("https://example.com/docs", { sectionSelector: ".links" }),
    ).rejects.toBeInstanceOf(AgentscrapeNetworkPolicyError);
    await expect(runAgentBrowser(["open", "https://example.com"])).rejects.toMatchObject({
      reason: "browser_egress_unverifiable",
    });
    expect(events(value)).toEqual([]);
  });

  test("denies eval expressions and non-HTTP opens before marking or closing a session", async () => {
    const value = fixture();
    await withBrowserSession(undefined, async (scope) => {
      for (const args of [
        ["eval", "location.href='http://127.0.0.1/'"],
        ["eval", "fetch('http://127.0.0.1/')"],
        ["open", "data:text/html,network-bypass"],
        ["open", "file:///etc/passwd"],
      ]) {
        await expect(runAgentBrowser(args)).rejects.toBeInstanceOf(AgentscrapeNetworkPolicyError);
      }
      await expect(openPage("data:text/html,network-bypass")).rejects.toBeInstanceOf(
        AgentscrapeNetworkPolicyError,
      );
      expect(scope.used).toBeFalse();
    });
    expect(events(value)).toEqual([]);
  });

  test("cancellation precedes consent without using or closing an owned session", async () => {
    const value = fixture();
    const direct = new AbortController();
    direct.abort();
    await withBrowserSession(undefined, async (scope) => {
      await expect(
        runAgentBrowser(
          ["eval", "window.location.href"],
          undefined,
          undefined,
          undefined,
          direct.signal,
        ),
      ).rejects.toBeInstanceOf(AgentscrapeCancelledError);

      const active = new AbortController();
      await withBrowserSignal(active.signal, async () => {
        active.abort();
        await expect(runAgentBrowser(["open", "https://example.com"])).rejects.toBeInstanceOf(
          AgentscrapeCancelledError,
        );
        await expect(openPage("about:blank")).rejects.toBeInstanceOf(AgentscrapeCancelledError);
      });
      expect(scope.used).toBeFalse();
    });
    expect(events(value)).toEqual([]);
  });

  test("an explicit false narrows inherited consent and only low-level about:blank is exempt", async () => {
    const value = fixture();
    await withBrowserNetworkPolicy(true, async () => {
      const denied = await fetchMarkdown("https://example.com/page", {
        generic: true,
        selector: "main",
        envelope: true,
        allowPrivateNetwork: false,
      });
      expect(denied).toMatchObject({ status: "failure" });
    });
    await expect(openPage("about:blank")).rejects.toBeInstanceOf(AgentscrapeNetworkPolicyError);
    expect(events(value)).toEqual([]);

    expect((await runAgentBrowser(["open", "about:blank"], "blank-session")).exitCode).toBe(0);
    expect(events(value)).toEqual([{ session: "blank-session", command: ["open", "about:blank"] }]);
  });

  test("direct preset, corpus, and canary paths deny before executable cleanup", async () => {
    const value = fixture();
    const preset = loadRegistry().byName("x-tweet")!;
    await expect(scrapeWithPreset("https://x.com/example/status/1", preset)).rejects.toBeInstanceOf(
      AgentscrapeNetworkPolicyError,
    );
    const corpusRoot = join(value.root, "corpus");
    await expect(
      captureCorpus("https://x.com/example/status/1", {
        preset: "x-tweet",
        expectFailure: "AgentscrapeError",
        root: corpusRoot,
      }),
    ).rejects.toBeInstanceOf(AgentscrapeNetworkPolicyError);
    expect(existsSync(join(corpusRoot, "x-tweet"))).toBeFalse();
    const canaryPath = join(value.root, "canaries.json");
    writeFileSync(
      canaryPath,
      `${JSON.stringify({ "x-tweet": { url: "https://x.com/example/status/1" } }, null, 2)}\n`,
    );
    await expect(checkPresets({ presets: ["x-tweet"], canaryPath })).rejects.toBeInstanceOf(
      AgentscrapeNetworkPolicyError,
    );
    expect(events(value)).toEqual([]);

    const allowed = await checkPresets({
      presets: ["x-tweet"],
      canaryPath,
      allowPrivateNetwork: true,
    });
    expect(allowed.results[0]?.status).not.toBe("not_configured");
    expect(events(value).length).toBeGreaterThan(0);
  });
});

describe("corpus capture security", () => {
  test("captured failure metadata is safe and sample paths are private", async () => {
    const value = fixture();
    const root = join(value.root, "captured-corpus");
    const sample = await captureCorpus("https://x.com/example/status/1?page=1#fragment", {
      preset: "x-tweet",
      expectFailure: "AgentscrapeError",
      root,
      allowPrivateNetwork: true,
    });
    expect(lstatSync(sample).mode & 0o077).toBe(0);
    for (const name of ["meta.json", "page.html"]) {
      expect(existsSync(join(sample, name))).toBeTrue();
      expect(lstatSync(join(sample, name)).mode & 0o077).toBe(0);
    }
    const text = readFileSync(join(sample, "meta.json"), "utf8");
    expect(text).not.toContain("#fragment");
    expect(JSON.parse(text)).toMatchObject({
      url: "https://x.com/example/status/1?page=1",
      failure: { type: "AgentscrapeError" },
    });
  });

  test("truncated direct failure-page output is not persisted", async () => {
    const value = fixture();
    process.env.AGENTSCRAPE_TEST_TRUNCATED_HTML = "1";
    const sample = await captureCorpus("https://x.com/example/status/1", {
      preset: "x-tweet",
      expectFailure: "AgentscrapeError",
      root: join(value.root, "truncated-corpus"),
      allowPrivateNetwork: true,
    });
    expect(existsSync(join(sample, "meta.json"))).toBeTrue();
    expect(existsSync(join(sample, "page.html"))).toBeFalse();
  });
});

describe("browser-free and low-level session behavior", () => {
  test("direct Markdown, offline HTML, and invalid requests issue no browser command or close", async () => {
    const value = fixture();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("# Direct", { headers: { "content-type": "text/markdown" } }),
    });
    const direct = await fetchMarkdown(`http://127.0.0.1:${server.port}/readme.md`, {
      allowPrivateNetwork: true,
    });
    server.stop(true);
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

  test("public link and corpus routes reject invalid URLs before sessions or publication", async () => {
    const value = fixture();
    const root = join(value.root, "invalid-corpus");
    const invalidUrls = [
      "not a URL",
      "file:///tmp/page.html",
      "https://user:password@example.com/page",
      "https://example.com/page?next=https%3A%2F%2Fother.example%2F%3Fapi_key%3Dnested-secret",
      `https://example.com/${"a".repeat(4090)}`,
      42,
    ];
    for (const invalid of invalidUrls) {
      await expect(
        fetchLinks(invalid as string, {
          preset: "x-timeline",
          html: "<main>injected</main>",
          allowPrivateNetwork: true,
        }),
      ).rejects.toBeInstanceOf(AgentscrapeUsageError);
      await expect(
        captureCorpus(invalid as string, {
          preset: "x-tweet",
          expectFailure: "AgentscrapeError",
          root,
          allowPrivateNetwork: true,
        }),
      ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    }
    expect(existsSync(root)).toBeFalse();
    expect(events(value)).toEqual([]);
  });

  test("runAgentBrowser outside a scope retains the PID fallback", async () => {
    const value = fixture();
    const result = await withBrowserNetworkPolicy(true, () =>
      runAgentBrowser(["eval", "window.location.href"]),
    );
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
      const result = await withBrowserNetworkPolicy(true, () =>
        runAgentBrowser(["open", "https://example.com"]),
      );
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
    await withBrowserNetworkPolicy(true, () =>
      withBrowserSession(undefined, async (scope) => {
        firstName = scope.name;
        expect((await runAgentBrowser(["eval", "first"])).exitCode).toBe(1);
        rmSync(health);
        await withBrowserSession(undefined, async (nested) => {
          expect(nested).toBe(scope);
          expect((await runAgentBrowser(["eval", "nested"])).exitCode).toBe(1);
        });
      }),
    );

    let secondName = "";
    await withBrowserNetworkPolicy(true, () =>
      withBrowserSession(undefined, async (scope) => {
        secondName = scope.name;
        expect((await runAgentBrowser(["eval", "window.location.href"])).exitCode).toBe(0);
      }),
    );
    expect(secondName).not.toBe(firstName);
    expect(events(value)).toEqual([
      { session: firstName, command: ["close"] },
      { session: secondName, command: ["eval", "window.location.href"] },
      { session: secondName, command: ["close"] },
    ]);
  });
});

describe("operator-pinned browser session", () => {
  const priorPinned = process.env[AGENT_BROWSER_SESSION_ENV];

  afterEach(() => {
    if (priorPinned === undefined) delete process.env[AGENT_BROWSER_SESSION_ENV];
    else process.env[AGENT_BROWSER_SESSION_ENV] = priorPinned;
  });

  test("reuses the pinned session for implicit work and never closes it", async () => {
    const value = fixture();
    process.env[AGENT_BROWSER_SESSION_ENV] = "operator-x";

    await withBrowserNetworkPolicy(true, () =>
      withBrowserSession(null, async () => {
        await runAgentBrowser(["eval", "null"]);
      }),
    );

    expect(events(value).map((event) => event.session)).toEqual(["operator-x"]);
    expect(events(value).some((event) => event.command[0] === "close")).toBeFalse();
  });

  test("rejects an unsafe pinned name and falls back to an owned ephemeral session", async () => {
    const value = fixture();
    process.env[AGENT_BROWSER_SESSION_ENV] = "bad name; rm -rf /";

    await withBrowserNetworkPolicy(true, () =>
      withBrowserSession(null, async () => {
        await runAgentBrowser(["eval", "null"]);
      }),
    );

    const sessions = events(value).map((event) => event.session);
    expect(sessions[0]).toStartWith("agentscrape-");
    expect(sessions).not.toContain("bad name; rm -rf /");
  });
});

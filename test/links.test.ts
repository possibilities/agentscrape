import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLinks } from "../src/api";
import { AgentscrapeUsageError, PresetDriftError } from "../src/errors";
import { offlineExtractLinks, scrapeLinks } from "../src/links";

const actualBrowser = await import("../src/browser");
// mock.module mutates the imported namespace in place, so snapshot the real
// exports first; the afterAll restore below rebuilds the module from this copy.
const realBrowserExports = { ...actualBrowser };
const openPage = mock(async () => {});
let snapshots: Array<Record<string, unknown>> = [];
let labels: string[] = [];
const runAgentBrowser = mock(async (args: string[]) => {
  const expression = args[1] ?? "";
  let stdout = "null";
  if (args[0] === "wait") stdout = "";
  else if (expression === "window.location.href") stdout = JSON.stringify("https://docs.test/docs");
  else if (expression.includes("return {rootCount: selected.length, links: out}"))
    stdout = JSON.stringify(snapshots.shift() ?? { rootCount: 1, links: [] });
  else if (expression.includes("count: items.length"))
    stdout = JSON.stringify({ rootCount: 1, count: labels.length, labels });
  else if (expression.includes("item.click()")) stdout = "true";
  return {
    argv: ["agent-browser", ...args],
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
  };
});
const mockModule = mock.module;
mockModule("../src/browser", () => ({ ...actualBrowser, openPage, runAgentBrowser }));

beforeEach(() => {
  openPage.mockClear();
  runAgentBrowser.mockClear();
  labels = [];
  snapshots = [];
});
afterAll(() => {
  // mock.restore() does not undo module mocks; restore the real browser module so
  // later test files are not left with the always-successful stub.
  mock.module("../src/browser", () => realBrowserExports);
  mock.restore();
});

const link = (url: string, title: string, category = "") => ({ url, title, category });
const snap = (...links: Array<{ url: string; title: string; category: string }>) => ({
  rootCount: 1,
  links,
});

describe("link extraction parity", () => {
  test("extracts each accordion panel incrementally and labels it by toggle", async () => {
    labels = ["Guides", "Reference"];
    const home = link("https://docs.test/docs/home", "Home");
    const guide = link("https://docs.test/docs/guide", "Guide");
    const api = link("https://docs.test/docs/api", "API");
    snapshots = [snap(home), snap(home), snap(home, guide), snap(home, guide), snap(home, api)];
    const result = await scrapeLinks("https://docs.test/docs", "#navigation-items", "button");
    expect(result.map(({ url, category }) => ({ url, category }))).toEqual([
      { url: home.url, category: "" },
      { url: guide.url, category: "Guides" },
      { url: api.url, category: "Reference" },
    ]);
    expect(
      runAgentBrowser.mock.calls.filter(([args]) => args[1]?.includes("item.click()")),
    ).toHaveLength(2);
    const evalSource = runAgentBrowser.mock.calls.map(([args]) => args[1] ?? "").join("\n");
    expect(evalSource).toContain('[role="tablist"]');
    expect(evalSource).toContain("document.getElementById(controls)");
  });

  test("direct fetchLinks maps malformed, missing, and empty selectors to usage", async () => {
    await expect(
      fetchLinks("https://docs.test/docs", { sectionSelector: "[", session: "direct" }),
    ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    expect(openPage).not.toHaveBeenCalled();

    for (const frames of [
      [
        { rootCount: 0, links: [] },
        { rootCount: 0, links: [] },
        { rootCount: 0, links: [] },
      ],
      [snap(), snap(), snap()],
    ]) {
      snapshots = frames;
      await expect(
        fetchLinks("https://docs.test/docs", {
          sectionSelector: "#navigation-items",
          session: "direct",
        }),
      ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    }
  });

  test("does not let auto-matched presets ignore caller selectors", async () => {
    const url = "https://x.com/agentscrape";
    for (const selectors of [
      { sectionSelector: "" },
      { categorySelector: "" },
      { categorySelector: "[" },
      { toggleSelector: "[" },
    ]) {
      await expect(fetchLinks(url, { ...selectors, session: "direct" })).rejects.toBeInstanceOf(
        AgentscrapeUsageError,
      );
    }
    await expect(fetchLinks(url, { toggleSelector: "button", session: "direct" })).rejects.toThrow(
      "provide --preset or at least one selector (--section-selector / --category-selector)",
    );
    expect(openPage).not.toHaveBeenCalled();
    expect(runAgentBrowser).not.toHaveBeenCalled();
  });

  test("rejects explicit presets combined with caller selectors before browser effects", async () => {
    await expect(
      fetchLinks("https://docs.test/docs", {
        preset: "docs-sidebar",
        sectionSelector: "#navigation-items",
      }),
    ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    expect(openPage).not.toHaveBeenCalled();
    expect(runAgentBrowser).not.toHaveBeenCalled();
  });

  test("rejects unsafe request identities before browser effects, including injected HTML", async () => {
    const html = readFileSync(join(import.meta.dir, "fixtures/x-timeline.html"), "utf8");
    for (const invalid of [
      "not a URL",
      "file:///tmp/timeline.html",
      "https://user:password@x.com/testuser",
      "https://x.com/testuser?next=https%3A%2F%2Fother.example%2F%3Fapi_key%3Dnested-secret",
      `https://x.com/testuser#${"a".repeat(4090)}`,
      42,
    ]) {
      await expect(
        fetchLinks(invalid as string, { preset: "x-timeline", html, session: "direct" }),
      ).rejects.toBeInstanceOf(AgentscrapeUsageError);
    }
    expect(openPage).not.toHaveBeenCalled();
    expect(runAgentBrowser).not.toHaveBeenCalled();
  });

  test("keeps an explicit preset name-based on a valid nonmatching URL", async () => {
    // x-timeline deliberately declares no automatic URL patterns.
    const result = await fetchLinks("https://x.com/testuser", {
      preset: "x-timeline",
      html: readFileSync(join(import.meta.dir, "fixtures/x-timeline.html"), "utf8"),
      limit: 2,
      session: "direct",
    });
    expect(result.links?.map((item) => item.url)).toEqual([
      "https://x.com/testuser/status/100",
      "https://x.com/testuser/status/500",
    ]);
    expect(openPage).not.toHaveBeenCalled();
    expect(runAgentBrowser).not.toHaveBeenCalled();
  });

  test("classifies missing and empty required preset selectors as drift", async () => {
    snapshots = [
      { rootCount: 0, links: [] },
      { rootCount: 0, links: [] },
      { rootCount: 0, links: [] },
    ];
    expect(scrapeLinks("https://docs.test/docs", "#missing")).rejects.toBeInstanceOf(
      PresetDriftError,
    );
    snapshots = [snap(), snap(), snap()];
    expect(scrapeLinks("https://docs.test/docs", "#empty")).rejects.toBeInstanceOf(
      PresetDriftError,
    );
  });

  test("offline extraction skips unsafe destinations", () => {
    expect(
      offlineExtractLinks(
        `<nav><a href="javascript:x">active</a><a href="%6a%61vascript:x">encoded</a><a href="/%zz">bad</a><a href="/ok">ok</a></nav>`,
        "nav",
        "https://docs.test/docs",
      ),
    ).toEqual([{ url: "https://docs.test/ok", title: "ok", category: "" }]);
  });

  test("offline extraction preserves heading categories and drifts on empty roots", () => {
    expect(
      offlineExtractLinks(
        '<nav><h2>Guide</h2><a href="/docs/start">Start</a></nav>',
        "nav",
        "https://docs.test/docs",
      ),
    ).toEqual([{ url: "https://docs.test/docs/start", title: "Start", category: "Guide" }]);
    expect(() => offlineExtractLinks("<main></main>", "nav", "https://docs.test/docs")).toThrow(
      PresetDriftError,
    );
  });
});

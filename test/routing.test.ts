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

const projectRoot = join(import.meta.dir, "..");
const apiPath = join(projectRoot, "src/api.ts");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  home: string;
  ghMarker: string;
  browserMarker: string;
  fetchMarker: string;
  handlerMarker: string;
  gh: string;
  browser: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentscrape-routing-"));
  temporary.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const value: Fixture = {
    root,
    home,
    ghMarker: join(root, "gh.marker"),
    browserMarker: join(root, "browser.marker"),
    fetchMarker: join(root, "fetch.marker"),
    handlerMarker: join(root, "handler.marker"),
    gh: join(bin, "gh"),
    browser: join(bin, "agent-browser"),
  };
  writeFileSync(
    value.gh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$GH_MARKER"
case "$*" in
  *"gist view"*"--files"*) printf 'note.md\n' ;;
  *"api -q .name"*) printf 'README.md\n' ;;
  *) printf '# fake gh content\n' ;;
esac
`,
  );
  writeFileSync(
    value.browser,
    `#!/bin/sh
printf '%s\n' "$*" >> "$BROWSER_MARKER"
exit 41
`,
  );
  chmodSync(value.gh, 0o755);
  chmodSync(value.browser, 0o755);
  return value;
}

function writePreset(value: Fixture, name: string, preset: Record<string, unknown>): void {
  const directory = join(value.root, "scrapers");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(preset, null, 2)}\n`);
}

function writeClaimedLinksPreset(value: Fixture, name: string, domain: string): void {
  writePreset(value, name, {
    name,
    summary: `Claim ${domain} without an automatic page-kind match`,
    domain,
    mode: "links",
    selector: "body",
  });
}

async function program(
  value: Fixture,
  body: string,
): Promise<{ code: number; stdout: string; stderr: string; value: any }> {
  const script = join(value.root, "program.ts");
  writeFileSync(
    script,
    `globalThis.fetch = async (input) => {
  await Bun.write(process.env.FETCH_MARKER, String(input));
  return new Response("# fake direct Markdown", {
    status: 200,
    headers: { "content-type": "text/markdown" },
  });
};
const api = await import(${JSON.stringify(apiPath)});
try {
${body}
} catch (error) {
  const value = error;
  console.log(JSON.stringify({
    error: {
      name: value?.name,
      message: value?.message,
      errorClass: value?.errorClass,
    },
  }));
}
`,
  );
  const child = Bun.spawn([process.execPath, script], {
    cwd: value.root,
    env: {
      ...process.env,
      HOME: value.home,
      PATH: `${join(value.root, "bin")}:${process.env.PATH ?? ""}`,
      AGENTSCRAPE_AGENT_BROWSER_BIN: value.browser,
      GH_MARKER: value.ghMarker,
      BROWSER_MARKER: value.browserMarker,
      FETCH_MARKER: value.fetchMarker,
      HANDLER_MARKER: value.handlerMarker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const text = stdout.trim();
  return { code, stdout, stderr, value: text ? JSON.parse(text) : null };
}

function expectMarkers(
  value: Fixture,
  present: Array<"gh" | "browser" | "fetch" | "handler">,
): void {
  const markers = {
    gh: value.ghMarker,
    browser: value.browserMarker,
    fetch: value.fetchMarker,
    handler: value.handlerMarker,
  };
  for (const [name, path] of Object.entries(markers))
    expect(existsSync(path), `${name} marker`).toBe(present.includes(name as keyof typeof markers));
}

function resultBody(url: string, options = "{}"): string {
  return `  const result = await api.fetchMarkdown(${JSON.stringify(url)}, ${options});
  console.log(JSON.stringify({
    markdown: result.markdown,
    status: result.status,
    failure: result.failure,
    requested_url: result.requested_url,
  }));`;
}

describe("policy-first automatic routing", () => {
  for (const [label, url] of [
    ["GitHub", "https://github.com/owner/repository"],
    ["Gist", "https://gist.github.com/owner/abc123"],
  ] as const) {
    test(`automatically routes parseable ${label} URLs through gh`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url));

      expect(output.code).toBe(0);
      expect(output.value.markdown).toContain("fake gh content");
      expectMarkers(value, ["gh"]);
    });
  }

  test("routes an unclaimed .md pathname through pinned direct HTTP rather than native fetch", async () => {
    const value = fixture();
    const output = await program(value, resultBody("https://docs.invalid/guide.md?download=1"));

    expect(output.value.error).toMatchObject({ errorClass: "provider" });
    expectMarkers(value, []);
  });
});

describe("preset and generic precedence", () => {
  for (const [label, url] of [
    ["GitHub", "https://github.com/owner/repository"],
    [".md", "https://docs.invalid/guide.md"],
  ] as const) {
    test(`rejects an invalid explicit preset before the ${label} fast path`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url, `{ preset: "missing" }`));

      expect(output.value.error).toMatchObject({
        message: "preset 'missing' not found",
        errorClass: "selection",
      });
      expectMarkers(value, []);
    });

    test(`rejects generic plus explicit preset before the ${label} fast path`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url, `{ generic: true, preset: "missing" }`));

      expect(output.value.error).toMatchObject({ errorClass: "selection" });
      expect(output.value.error.message).toContain("--generic conflicts with explicit preset");
      expectMarkers(value, []);
    });
  }

  test("an explicit preset is selected by name without URL-match eligibility", async () => {
    const value = fixture();
    writePreset(value, "named-route", {
      name: "named-route",
      summary: "Explicit content route ineligible for the requested URL",
      domain: "elsewhere.invalid",
      mode: "content",
      handler: "named.handle",
      schema: "NamedPage",
      url_patterns: ["^https://elsewhere[.]invalid/eligible$"],
    });
    const url = "https://github.com/owner/repository?View=Original#Fragment";
    const output = await program(
      value,
      `  class NamedPage extends api.ScrapeSchema {
    constructor(content) { super(); this.content = content; }
    toMarkdown() { return this.content; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "named.handle",
    schemaName: "NamedPage",
    schema: NamedPage,
    handler: async (receivedUrl) => {
      await Bun.write(process.env.HANDLER_MARKER, receivedUrl);
      const structured = new NamedPage("# Explicit named preset executed");
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
      };
    },
  });
  try {
    const result = await api.fetchMarkdown(${JSON.stringify(url)}, {
      preset: "named-route",
      html: "<main>Offline input</main>",
    });
    console.log(JSON.stringify({ markdown: result.markdown }));
  } finally {
    unregister();
  }`,
    );

    expect(output.code).toBe(0);
    expect(output.value.markdown).toBe("# Explicit named preset executed");
    expect(readFileSync(value.handlerMarker, "utf8")).toBe(url);
    expectMarkers(value, ["handler"]);
  });

  test("fetchMarkdown rejects a selector preset before browser effects", async () => {
    const value = fixture();
    const output = await program(
      value,
      resultBody("https://docs.invalid/guide", `{ preset: "docs-sidebar" }`),
    );

    expect(output.value.error).toMatchObject({
      name: "AgentscrapeUsageError",
      errorClass: "usage",
    });
    expect(output.value.error.message).toContain("not a content-mode preset");
    expectMarkers(value, []);
  });

  test("generic forces the browser instead of GitHub or direct fetch", async () => {
    for (const url of ["https://github.com/owner/repository", "https://docs.invalid/guide.md"]) {
      const value = fixture();
      const output = await program(
        value,
        resultBody(url, `{ generic: true, allowPrivateNetwork: true }`),
      );

      expect(output.value.error).toBeDefined();
      expectMarkers(value, ["browser"]);
    }
  });

  test("captures a generic envelope final URL before closing its implicit browser session", async () => {
    const value = fixture();
    const opened = join(value.root, "browser.opened");
    const closed = join(value.root, "browser.closed");
    const finalUrl = "https://example.invalid/final";
    writeFileSync(
      value.browser,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$BROWSER_MARKER"
case "$*" in
  *" close") touch ${JSON.stringify(closed)} ;;
  *" eval window.location.href")
    if [ -f ${JSON.stringify(closed)} ]; then
      printf 'session already closed' >&2
      exit 1
    elif [ -f ${JSON.stringify(opened)} ]; then
      printf '%s' ${JSON.stringify(JSON.stringify(finalUrl))}
    else
      printf '"about:blank"'
    fi ;;
  *" open "*) touch ${JSON.stringify(opened)} ;;
  *" wait --load networkidle") ;;
  *" eval document.documentElement.outerHTML")
    printf '"<html><body><main>Offline browser page</main></body></html>"' ;;
  *"querySelectorAll"*)
    printf '{"html":"<main>Offline browser page</main>"}' ;;
  *) printf 'unexpected command: %s' "$*" >&2; exit 1 ;;
esac
`,
    );

    const output = await program(
      value,
      `  const result = await api.fetchMarkdown("https://example.invalid/start", {
    envelope: true,
    generic: true,
    selector: "main",
    allowPrivateNetwork: true,
  });
  console.log(JSON.stringify(result));`,
    );

    expect(output.code).toBe(0);
    expect(output.value).toMatchObject({ status: "success", final_url: finalUrl });
    expectMarkers(value, ["browser"]);
    const commands = readFileSync(value.browserMarker, "utf8").trim().split("\n");
    const finalUrlCommands = commands
      .map((command, index) => (command.endsWith(" eval window.location.href") ? index : -1))
      .filter((index) => index >= 0);
    const closeIndex = commands.findIndex((command) => command.endsWith(" close"));
    expect(finalUrlCommands).toHaveLength(2);
    expect(finalUrlCommands.at(-1)!).toBeLessThan(closeIndex);
  });
});

describe("generic caller selector provenance", () => {
  test("an explicit body selector bypasses auto-detection and selects body", async () => {
    const value = fixture();
    writeFileSync(
      value.browser,
      `#!/bin/sh
printf '%s\n' "$*" >> "$BROWSER_MARKER"
case "$*" in
  *" eval window.location.href") printf '"about:blank"' ;;
  *" open "*) ;;
  *" wait --load networkidle") ;;
  *" eval document.documentElement.outerHTML") printf '"<html><body>Selected body</body></html>"' ;;
  *'querySelectorAll("body")'*) printf '{"html":"<body>Selected body</body>"}' ;;
  *hasText*) printf 'auto-detection must not run' >&2; exit 9 ;;
  *) printf 'unexpected command: %s' "$*" >&2; exit 1 ;;
esac
`,
    );
    const output = await program(
      value,
      resultBody(
        "https://example.invalid/page",
        `{ generic: true, selector: "body", session: "explicit-body", allowPrivateNetwork: true }`,
      ),
    );

    expect(output.value.markdown).toContain("Selected body");
    const commands = readFileSync(value.browserMarker, "utf8");
    expect(commands).toContain('querySelectorAll("body")');
    expect(commands).not.toContain("const hasText");
  });

  for (const [label, selector, selection] of [
    ["malformed", "[", null],
    ["missing", "#missing", '{"error":"no_match","count":0}'],
    ["multiple", ".many", '{"error":"multiple_match","count":2}'],
  ] as const) {
    test(`${label} caller selectors are typed usage errors`, async () => {
      const value = fixture();
      if (selection !== null) {
        writeFileSync(
          value.browser,
          `#!/bin/sh
printf '%s\\n' "$*" >> "$BROWSER_MARKER"
case "$*" in
  *" eval window.location.href") printf '"about:blank"' ;;
  *" open "*) ;;
  *" wait --load networkidle") ;;
  *" eval document.documentElement.outerHTML") printf '"<html><body><main>Body</main></body></html>"' ;;
  *querySelectorAll*) printf '%s' ${JSON.stringify(selection)} ;;
  *" close") ;;
  *) printf 'unexpected command: %s' "$*" >&2; exit 1 ;;
esac
`,
        );
      }
      const output = await program(
        value,
        resultBody(
          "https://example.invalid/page",
          `{ generic: true, selector: ${JSON.stringify(selector)}, allowPrivateNetwork: true }`,
        ),
      );

      expect(output.value.error).toMatchObject({
        name: "AgentscrapeUsageError",
        errorClass: "usage",
      });
      const commands = existsSync(value.browserMarker)
        ? readFileSync(value.browserMarker, "utf8")
        : "";
      if (label === "malformed") expect(commands).not.toContain(" open ");
    });
  }
});

describe("claimed domains fail closed", () => {
  test("rejects an unsupported .md URL on a claimed domain", async () => {
    const value = fixture();
    writeClaimedLinksPreset(value, "claimed-docs", "claimed.invalid");
    const output = await program(value, resultBody("https://claimed.invalid/guide.md"));

    expect(output.value.error).toMatchObject({ errorClass: "selection" });
    expect(output.value.error.message).toContain("no preset matches this URL");
    expectMarkers(value, []);
  });

  test("rejects a parseable GitHub URL claimed by an unmatched local preset", async () => {
    const value = fixture();
    writeClaimedLinksPreset(value, "claimed-github", "github.com");
    const output = await program(value, resultBody("https://github.com/owner/repository"));

    expect(output.value.error).toMatchObject({ errorClass: "selection" });
    expect(output.value.error.message).toContain("no preset matches this URL");
    expectMarkers(value, []);
  });
});

describe("request validation precedes every route side effect", () => {
  test("an invalid live X tweet route has no browser side effects", async () => {
    const value = fixture();
    const output = await program(
      value,
      resultBody(
        "https://x.com/alice?next=/bob/status/123",
        `{ preset: "x-tweet", session: "route-validation" }`,
      ),
    );

    expect(output.value.error).toMatchObject({
      name: "AgentscrapeUsageError",
      errorClass: "usage",
    });
    expectMarkers(value, []);
  });

  for (const [label, url] of [
    ["malformed", "not-a-url"],
    ["non-HTTP", "ftp://example.com/file.md"],
    ["credential-bearing", "https://user:secret@github.com/owner/repository"],
  ] as const) {
    test(`plain mode rejects ${label} URLs as typed usage errors`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url));

      expect(output.value.error).toMatchObject({
        name: "AgentscrapeUsageError",
        errorClass: "usage",
      });
      expectMarkers(value, []);
    });
  }

  for (const [name, url, options] of [
    ["maxContentBytes", "https://github.com/owner/repository", `{ maxContentBytes: 0 }`],
    ["maxRelations", "https://docs.invalid/Guide.md?View=Case", `{ maxRelations: -1 }`],
  ] as const) {
    test(`programmatic invalid ${name} is typed usage in plain mode`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url, options));

      expect(output.value.error).toMatchObject({
        name: "AgentscrapeUsageError",
        errorClass: "usage",
      });
      expectMarkers(value, []);
    });

    test(`programmatic invalid ${name} is envelope invalid_request`, async () => {
      const value = fixture();
      const output = await program(value, resultBody(url, `{ envelope: true, ...${options} }`));

      expect(output.value).toMatchObject({
        status: "failure",
        requested_url: url,
        failure: { failure_class: "invalid_request" },
      });
      expectMarkers(value, []);
    });
  }
});

describe("definition-role X status routing", () => {
  const articleUrl = "https://x.com/i/status/2047794182463394072";
  const articleHtml = readFileSync(
    join(import.meta.dir, "corpus/x-article/sample-001/page.html"),
    "utf8",
  );

  test("accepts a local x-article shadow with the official article pair", async () => {
    const value = fixture();
    writePreset(value, "x-article", {
      name: "x-article",
      summary: "Local shadow retaining the article definition",
      domain: "x.com",
      aliases: ["twitter.com"],
      mode: "content",
      handler: "x.scrape_article",
      schema: "XArticle",
    });
    const output = await program(
      value,
      `  const result = await api.fetchMarkdown(${JSON.stringify(articleUrl)}, {
    envelope: true,
    html: ${JSON.stringify(articleHtml)},
  });
  console.log(JSON.stringify(result));`,
    );

    expect(output.value).toMatchObject({
      status: "success",
      extractor: { implementation: "x-article" },
      metadata: { content_type: "article" },
    });
    expectMarkers(value, []);
  });

  test("fails closed when a local x-article shadow has no article role", async () => {
    const value = fixture();
    writePreset(value, "x-article", {
      name: "x-article",
      summary: "Mismatched local article shadow",
      domain: "x.com",
      aliases: ["twitter.com"],
      mode: "content",
      handler: "shadow.handle",
      schema: "ShadowArticle",
    });
    const output = await program(
      value,
      `  class ShadowArticle extends api.ScrapeSchema {
    toMarkdown() { return "# Must not execute"; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "shadow.handle",
    schemaName: "ShadowArticle",
    schema: ShadowArticle,
    handler: async () => {
      await Bun.write(process.env.HANDLER_MARKER, "must not run");
      const structured = new ShadowArticle();
      return { full_html: "", selected_html: "", markdown: structured.toMarkdown(), structured };
    },
  });
  try {
    const result = await api.fetchMarkdown(${JSON.stringify(articleUrl)}, {
      envelope: true,
      html: ${JSON.stringify(articleHtml)},
    });
    console.log(JSON.stringify(result));
  } finally {
    unregister();
  }`,
    );

    expect(output.value).toMatchObject({
      status: "failure",
      extractor: { implementation: "x-tweet" },
      failure: { failure_class: "internal_error" },
    });
    expect(output.value.failure.evidence).toContain(
      "automatic X status article routing requires the official x-article preset",
    );
    expectMarkers(value, []);
  });
});

describe("registered content routing", () => {
  test("a registered matching preset wins and receives the original URL", async () => {
    const value = fixture();
    writePreset(value, "registered-route", {
      name: "registered-route",
      summary: "Registered matching route",
      domain: "github.com",
      mode: "content",
      handler: "routing.handle",
      schema: "RoutingPage",
      url_patterns: ["^https://github[.]com/registered/route[?]View=Case$"],
    });
    const url = "https://github.com/registered/route?View=Case#Original";
    const output = await program(
      value,
      `  class RoutingPage extends api.ScrapeSchema {
    constructor(content) { super(); this.content = content; }
    toMarkdown() { return this.content; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "routing.handle",
    schemaName: "RoutingPage",
    schema: RoutingPage,
    handler: async (url) => {
      await Bun.write(process.env.HANDLER_MARKER, url);
      const structured = new RoutingPage(url);
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
      };
    },
  });
  try {
    const result = await api.fetchMarkdown(${JSON.stringify(url)}, { html: "offline" });
    console.log(JSON.stringify({ markdown: result.markdown }));
  } finally {
    unregister();
  }`,
    );

    expect(output.value.markdown).toBe(url);
    expect(readFileSync(value.handlerMarker, "utf8")).toBe(url);
    expectMarkers(value, ["handler"]);
  });

  test("a default non-browser custom extractor builds a generic envelope", async () => {
    const value = fixture();
    writePreset(value, "custom-envelope", {
      name: "custom-envelope",
      summary: "Custom generic envelope",
      domain: "custom.test",
      mode: "content",
      handler: "envelope.handle",
      schema: "EnvelopePage",
      url_patterns: ["^https://custom[.]test/start[?]View=Case$"],
    });
    const url = "https://custom.test/start?View=Case";
    const output = await program(
      value,
      `  class EnvelopePage extends api.ScrapeSchema {
    constructor(content) { super(); this.content = content; }
    toMarkdown() { return this.content; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "envelope.handle",
    schemaName: "EnvelopePage",
    schema: EnvelopePage,
    handler: async (receivedUrl) => {
      await Bun.write(process.env.HANDLER_MARKER, receivedUrl);
      const structured = new EnvelopePage("# Custom title\\n\\n[Reference](/reference)");
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
      };
    },
  });
  try {
    const result = await api.fetchMarkdown(${JSON.stringify(url)}, { envelope: true });
    console.log(JSON.stringify(result));
  } finally {
    unregister();
  }`,
    );

    expect(output.value).toMatchObject({
      status: "success",
      requested_url: url,
      final_url: url,
      extractor: { implementation: "custom-envelope" },
      metadata: { title: "Custom title" },
    });
    expect(output.value.relations).toEqual([
      { relation_type: "references", target_url: "https://custom.test/reference" },
    ]);
    expect(readFileSync(value.handlerMarker, "utf8")).toBe(url);
    expectMarkers(value, ["handler"]);
  });

  test("an explicit custom result final URL wins without browser capture", async () => {
    const value = fixture();
    writePreset(value, "custom-final", {
      name: "custom-final",
      summary: "Custom provider final URL",
      domain: "custom.test",
      mode: "content",
      handler: "final.handle",
      schema: "FinalPage",
    });
    const requested = "https://custom.test/start";
    const finalUrl = "https://custom.test/final?ok=yes";
    const output = await program(
      value,
      `  class FinalPage extends api.ScrapeSchema {
    toMarkdown() { return "# Final"; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "final.handle",
    schemaName: "FinalPage",
    schema: FinalPage,
    capabilities: { browser: true },
    handler: async () => {
      await Bun.write(process.env.HANDLER_MARKER, "ran");
      const structured = new FinalPage();
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
        final_url: ${JSON.stringify(finalUrl)},
      };
    },
  });
  try {
    const result = await api.fetchMarkdown(${JSON.stringify(requested)}, {
      envelope: true,
      preset: "custom-final",
    });
    console.log(JSON.stringify(result));
  } finally {
    unregister();
  }`,
    );

    expect(output.value).toMatchObject({
      status: "success",
      requested_url: requested,
      final_url: finalUrl,
      extractor: { implementation: "custom-final" },
    });
    expectMarkers(value, ["handler"]);
  });

  test("a browser-enabled custom extractor captures the browser final URL", async () => {
    const value = fixture();
    writePreset(value, "custom-browser", {
      name: "custom-browser",
      summary: "Browser-enabled custom content",
      domain: "custom.test",
      mode: "content",
      handler: "browser.handle",
      schema: "BrowserPage",
    });
    const finalUrl = "https://custom.test/captured";
    writeFileSync(
      value.browser,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$BROWSER_MARKER"
case "$*" in
  *" eval window.location.href") printf '%s' ${JSON.stringify(JSON.stringify(finalUrl))} ;;
  *" close") ;;
  *) printf 'unexpected command: %s' "$*" >&2; exit 1 ;;
esac
`,
    );
    const output = await program(
      value,
      `  class BrowserPage extends api.ScrapeSchema {
    toMarkdown() { return "# Browser capability"; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "browser.handle",
    schemaName: "BrowserPage",
    schema: BrowserPage,
    capabilities: { browser: true },
    handler: async () => {
      await Bun.write(process.env.HANDLER_MARKER, "ran");
      const structured = new BrowserPage();
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
      };
    },
  });
  try {
    const result = await api.fetchMarkdown("https://custom.test/start", {
      envelope: true,
      preset: "custom-browser",
      allowPrivateNetwork: true,
    });
    console.log(JSON.stringify(result));
  } finally {
    unregister();
  }`,
    );

    expect(output.value).toMatchObject({ status: "success", final_url: finalUrl });
    expectMarkers(value, ["browser", "handler"]);
    expect(readFileSync(value.browserMarker, "utf8")).toContain("eval window.location.href");
  });

  test("fetchLinks rejects a non-link custom extractor before handler and browser effects", async () => {
    const value = fixture();
    writePreset(value, "custom-no-links", {
      name: "custom-no-links",
      summary: "Custom content without links capability",
      domain: "custom.test",
      mode: "content",
      handler: "no-links.handle",
      schema: "NoLinksPage",
    });
    const output = await program(
      value,
      `  class NoLinksPage extends api.ScrapeSchema {
    toMarkdown() { return "# No links"; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "no-links.handle",
    schemaName: "NoLinksPage",
    schema: NoLinksPage,
    handler: async () => {
      await Bun.write(process.env.HANDLER_MARKER, "must not run");
      const structured = new NoLinksPage();
      return { full_html: "", selected_html: "", markdown: structured.toMarkdown(), structured };
    },
  });
  try {
    await api.fetchLinks("https://custom.test/start", { preset: "custom-no-links" });
  } finally {
    unregister();
  }`,
    );

    expect(output.value.error).toMatchObject({
      name: "AgentscrapeUsageError",
      errorClass: "usage",
    });
    expect(output.value.error.message).toContain("emits no links");
    expectMarkers(value, []);
  });

  test("a preset named x-timeline cannot claim timeline options without the capability", async () => {
    const value = fixture();
    writePreset(value, "x-timeline", {
      name: "x-timeline",
      summary: "Name-only timeline shadow",
      domain: "custom.test",
      mode: "content",
      handler: "name-only-timeline.handle",
      schema: "NameOnlyTimeline",
    });
    const output = await program(
      value,
      `  class NameOnlyTimeline extends api.ScrapeSchema {
    toMarkdown() { return "# Name only"; }
  }
  const unregister = api.registerContentHandler({
    handlerName: "name-only-timeline.handle",
    schemaName: "NameOnlyTimeline",
    schema: NameOnlyTimeline,
    capabilities: { links: true },
    handler: async () => {
      await Bun.write(process.env.HANDLER_MARKER, "must not run");
      const structured = new NameOnlyTimeline();
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
        links: [],
      };
    },
  });
  try {
    await api.fetchLinks("https://custom.test/start", { preset: "x-timeline", limit: 1 });
  } finally {
    unregister();
  }`,
    );

    expect(output.value.error).toMatchObject({
      name: "AgentscrapeUsageError",
      errorClass: "usage",
      message: "--limit is only valid with the x-timeline preset",
    });
    expectMarkers(value, []);
  });

  test("fetchLinks executes a custom links opt-in and enforces its result", async () => {
    const value = fixture();
    writePreset(value, "custom-links", {
      name: "custom-links",
      summary: "Custom content with links capability",
      domain: "custom.test",
      mode: "content",
      handler: "links.handle",
      schema: "LinksPage",
    });
    const output = await program(
      value,
      `  class LinksPage extends api.ScrapeSchema {
    toMarkdown() { return "# Links"; }
  }
  let calls = 0;
  const unregister = api.registerContentHandler({
    handlerName: "links.handle",
    schemaName: "LinksPage",
    schema: LinksPage,
    capabilities: { links: true },
    handler: async () => {
      calls += 1;
      await Bun.write(process.env.HANDLER_MARKER, "ran");
      const structured = new LinksPage();
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
        ...(calls === 1 ? { links: [{
          url: "https://custom.test/item",
          title: "Item",
          section: "",
          category: "",
        }] } : {}),
      };
    },
  });
  try {
    const result = await api.fetchLinks("https://custom.test/start", { preset: "custom-links" });
    let missingLinksError;
    try {
      await api.fetchLinks("https://custom.test/start", { preset: "custom-links" });
    } catch (error) {
      missingLinksError = error?.message;
    }
    console.log(JSON.stringify({ links: result.links, missingLinksError }));
  } finally {
    unregister();
  }`,
    );

    expect(output.value.links).toEqual([
      {
        url: "https://custom.test/item",
        title: "Item",
        section: "",
        category: "",
      },
    ]);
    expect(output.value.missingLinksError).toContain("content-mode preset and emits no links");
    expectMarkers(value, ["handler"]);
  });
});

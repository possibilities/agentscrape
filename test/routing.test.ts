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

function writeClaimedLinksPreset(value: Fixture, name: string, domain: string): void {
  const directory = join(value.root, "scrapers");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.yaml`),
    `name: ${name}
summary: Claim ${domain} without an automatic page-kind match
domain: ${domain}
mode: links
selector: body
`,
  );
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

  test("routes an unclaimed .md pathname through the bounded fetch even with a query", async () => {
    const value = fixture();
    const output = await program(value, resultBody("https://docs.invalid/guide.md?download=1"));

    expect(output.value.markdown).toBe("# fake direct Markdown");
    expectMarkers(value, ["fetch"]);
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
    const directory = join(value.root, "scrapers");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "named-route.yaml"),
      `name: named-route
summary: Explicit content route ineligible for the requested URL
domain: elsewhere.invalid
mode: content
handler: named.handle
schema: NamedPage
url_patterns:
  - '^https://elsewhere[.]invalid/eligible$'
`,
    );
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

  test("generic forces the browser instead of GitHub or direct fetch", async () => {
    for (const url of ["https://github.com/owner/repository", "https://docs.invalid/guide.md"]) {
      const value = fixture();
      const output = await program(value, resultBody(url, `{ generic: true }`));

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
        `{ generic: true, selector: "body", session: "explicit-body" }`,
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
          `{ generic: true, selector: ${JSON.stringify(selector)} }`,
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

describe("registered content routing", () => {
  test("a registered matching preset wins and receives the original URL", async () => {
    const value = fixture();
    const directory = join(value.root, "scrapers");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "registered-route.yaml"),
      `name: registered-route
summary: Registered matching route
domain: github.com
mode: content
handler: routing.handle
schema: RoutingPage
url_patterns:
  - '^https://github[.]com/registered/route[?]View=Case$'
`,
    );
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
});

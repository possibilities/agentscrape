import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-cli-"));
  temporary.push(path);
  return path;
}
async function command(
  args: string[],
  options: { stdin?: string; home?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: root,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(options.home ? { HOME: options.home } : {}),
      ...options.env,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
function cliBrowser(directory: string): { path: string; events: string } {
  const path = join(directory, "agent-browser");
  const events = join(directory, "events.jsonl");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args.slice(2);
appendFileSync(${JSON.stringify(events)}, JSON.stringify(command) + "\\n");
if (command[0] === "close" || command[0] === "open" || (command[0] === "wait" && command[1] === "--load")) process.exit(0);
if (command[0] === "wait") { console.error("selector missing token=CLI-WAIT-SECRET"); process.exit(7); }
if (command[0] === "screenshot") { writeFileSync(command[1], "cli screenshot"); process.exit(0); }
if (command[0] === "eval") {
  const expression = command[1] || "";
  if (expression === "window.location.href") console.log(JSON.stringify("https://example.com/page?token=CLI-URL-SECRET"));
  else if (expression === "document.documentElement.outerHTML") console.log(JSON.stringify("<html><body><main>CLI body</main></body></html>"));
  else if (expression.includes("hasText")) console.log(JSON.stringify("body"));
  else if (expression.includes("return {html:")) console.log(JSON.stringify({ html: "<main>CLI body</main>" }));
  else console.log("false");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(path, 0o755);
  return { path, events };
}

describe("CLI offline smoke suite", () => {
  test("entry point is executable and help inventories every final command", async () => {
    expect(statSync(join(root, "src/cli.ts")).mode & 0o111).not.toBe(0);
    const result = await command(["--help"]);
    expect(result.code).toBe(0);
    for (const name of [
      "fetch-markdown",
      "fetch-links",
      "discover-feed",
      "list-presets",
      "show-preset",
      "validate-preset",
      "capture-corpus",
      "test-corpus",
      "check-presets",
      "convert-html",
      "open-session",
      "close-session",
      "process-queue",
      "reconcile-queue",
    ]) {
      expect(result.stdout).toContain(name);
    }
  });
  test("version and preset inspection commands succeed", async () => {
    expect((await command(["--version"])).stdout.trim()).toBe("agentscrape 0.1.0");
    expect((await command(["list-presets"])).stdout).toContain("deepwiki-wiki-page");
    expect((await command(["show-preset", "x-tweet"])).stdout).toContain("Schema: TweetThread");
    expect((await command(["validate-preset", "deepwiki-wiki-page"])).stdout).toContain("OK:");
  });
  test("HTML conversion supports stdin and recursive directory mode", async () => {
    const stdin = await command(["convert-html"], { stdin: "<h1>Hello</h1><p>World</p>" });
    expect(stdin.code).toBe(0);
    expect(stdin.stdout).toContain("# Hello");
    const directory = temp();
    writeFileSync(join(directory, "one.html"), "<h1>One</h1>");
    const converted = await command(["convert-html", "--dir", directory]);
    expect(converted.code).toBe(0);
    expect(readFileSync(join(directory, "one.md"), "utf8")).toContain("# One");
  });
  test("feed command emits JSON success and classified malformed failure", async () => {
    const valid = await command([
      "discover-feed",
      "test/fixtures/feeds/rss.xml",
      "--source-url",
      "https://blog.example.com/feed.xml",
    ]);
    expect(valid.code).toBe(0);
    expect(valid.stderr).toBe("");
    expect(JSON.parse(valid.stdout)).toMatchObject({ status: "success", failure: null });

    const invalid = await command([
      "discover-feed",
      "test/fixtures/feeds/invalid.xml",
      "--source-url",
      "https://blog.example.com/feed.xml",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toBe("");
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      status: "failure",
      failure: { code: "malformed_xml" },
    });
  });

  test("recorded feed filesystem faults emit complete safe failures", async () => {
    const directory = temp();
    const source =
      "https://blog.example.com/feed.xml?QUERY-SECRET-MARKER=value#FRAGMENT-SECRET-MARKER";
    const normalizedSource = "https://blog.example.com/feed.xml";
    const missing = join(directory, "LOCAL-MISSING-PATH-MARKER.xml");
    const markedDirectory = join(directory, "LOCAL-DIRECTORY-PATH-MARKER");
    mkdirSync(markedDirectory);
    writeFileSync(join(markedDirectory, "content.xml"), "PRIVATE-FIXTURE-CONTENT-MARKER");

    for (const path of [missing, markedDirectory]) {
      const result = await command(["discover-feed", path, "--source-url", source]);
      expect(result.code, path).toBe(1);
      expect(result.stderr, path).toBe("");
      expect(JSON.parse(result.stdout), path).toMatchObject({
        schema_version: "1",
        status: "failure",
        source_url: normalizedSource,
        source_format: "unknown",
        validators: { etag: null, last_modified: null },
        cursor: {
          validators: { etag: null, last_modified: null },
          newest_seen_at: null,
          next_url: null,
        },
        items: [],
        pagination: { pages: [], complete: false, stop_reason: "failed", next_url: null },
        warnings: [],
        failure: {
          code: "invalid_options",
          retryable: false,
          message: "A recorded response could not be read.",
        },
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(path);
      expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE-FIXTURE-CONTENT-MARKER");
      expect(`${result.stdout}${result.stderr}`).not.toContain("QUERY-SECRET-MARKER");
      expect(`${result.stdout}${result.stderr}`).not.toContain("FRAGMENT-SECRET-MARKER");
    }
  });

  test("recorded feed byte and UTF-8 boundaries use stable failures", async () => {
    const directory = temp();
    const source = "https://blog.example.com/feed.xml";
    const oversized = join(directory, "LOCAL-OVERSIZED-PATH-MARKER.xml");
    const invalidUtf8 = join(directory, "LOCAL-UTF8-PATH-MARKER.xml");
    writeFileSync(oversized, "PRIVATE-OVERSIZED-FIXTURE-CONTENT");
    writeFileSync(invalidUtf8, Buffer.from([0x50, 0x52, 0x49, 0x56, 0x41, 0x54, 0x45, 0xc3, 0x28]));

    const cases: Array<[string, string[], string, string, string]> = [
      [
        oversized,
        ["--max-response-bytes", "8"],
        "response_limit_exceeded",
        "response_limit",
        "A recorded response exceeds the configured byte limit.",
      ],
      [
        invalidUtf8,
        [],
        "invalid_utf8",
        "malformed_response",
        "The feed response is not valid UTF-8.",
      ],
    ];
    for (const [path, options, code, stop, message] of cases) {
      const result = await command(["discover-feed", path, "--source-url", source, ...options]);
      expect(result.code, code).toBe(1);
      expect(result.stderr, code).toBe("");
      expect(JSON.parse(result.stdout), code).toMatchObject({
        status: "failure",
        source_format: "unknown",
        items: [],
        pagination: { pages: [], stop_reason: stop },
        failure: { code, retryable: false, message },
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(path);
      expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE");
    }
  });

  test("a missing supplemental recorded page fails before initial-page parsing", async () => {
    const directory = temp();
    const missing = join(directory, "LOCAL-MISSING-PAGE-PATH-MARKER.xml");
    const result = await command([
      "discover-feed",
      "test/fixtures/feeds/feed-page-1.xml",
      "--source-url",
      "https://paged.example.com/feed?page=1",
      "--page",
      "https://paged.example.com/feed?page=2",
      missing,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failure",
      items: [],
      pagination: { pages: [], stop_reason: "failed" },
      failure: { code: "invalid_options", message: "A recorded response could not be read." },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(missing);
    expect(`${result.stdout}${result.stderr}`).not.toContain("page-one-item");
  });

  test("feed partial exit follows failure nullability and supports YAML", async () => {
    const source = "https://paged.example.com/feed?page=1";
    const missingPage = await command([
      "discover-feed",
      "test/fixtures/feeds/feed-page-1.xml",
      "--source-url",
      source,
    ]);
    expect(missingPage.code).toBe(0);
    expect(missingPage.stderr).toBe("");
    expect(JSON.parse(missingPage.stdout)).toMatchObject({
      status: "partial",
      pagination: { stop_reason: "missing_page" },
      failure: null,
    });

    const malformedPage = await command([
      "discover-feed",
      "test/fixtures/feeds/feed-page-1.xml",
      "--source-url",
      source,
      "--page",
      "https://paged.example.com/feed?page=2",
      "test/fixtures/feeds/invalid.xml",
      "--format",
      "yaml",
    ]);
    expect(malformedPage.code).toBe(1);
    expect(malformedPage.stderr).toBe("");
    expect(parseYaml(malformedPage.stdout)).toMatchObject({
      status: "partial",
      items: [{ stable_id: "page-one-item" }],
      pagination: {
        pages: [{ url: source }],
        stop_reason: "malformed_page",
      },
      failure: { code: "malformed_xml", retryable: false },
    });
    expect(`${malformedPage.stdout}${malformedPage.stderr}`).not.toContain(
      "test/fixtures/feeds/invalid.xml",
    );
    expect(`${malformedPage.stdout}${malformedPage.stderr}`).not.toContain("broken");
  });
  test("unrelated envelope invalid requests retain operational exit behavior", async () => {
    const invalid = await command(["fetch-markdown", "not-a-url", "--envelope"]);
    expect(invalid.code).toBe(1);
    const invalidEnvelope = JSON.parse(invalid.stdout);
    expect(invalidEnvelope.schema_version).toBe("1");
    expect(invalidEnvelope.failure.failure_class).toBe("invalid_request");
    const claimed = await command([
      "fetch-markdown",
      "https://x.com/deep/unsupported/path",
      "--envelope",
    ]);
    expect(claimed.code).toBe(1);
    expect(JSON.parse(claimed.stdout).failure.failure_class).toBe("invalid_request");
  });
  test("forwards explicit direct-network consent without making it global", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response("# CLI direct");
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/page.md`;
      const denied = await command(["fetch-markdown", url, "--envelope"]);
      expect(denied.code).toBe(2);
      expect(JSON.parse(denied.stdout).failure.failure_class).toBe("invalid_request");
      expect(requests).toBe(0);
      const allowed = await command([
        "fetch-markdown",
        url,
        "--envelope",
        "--allow-private-network",
      ]);
      expect(allowed.code).toBe(0);
      expect(JSON.parse(allowed.stdout).status).toBe("success");
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("fetch-markdown CLI retains private HTML sidecars only with its explicit flag", async () => {
    const directory = temp();
    const home = join(directory, "home");
    mkdirSync(home);
    const browser = cliBrowser(directory);
    const env = { AGENTSCRAPE_AGENT_BROWSER_BIN: browser.path };
    const defaultDestination = join(directory, "default.md");
    const retainedDestination = join(directory, "retained.md");
    const common = ["--generic", "--allow-private-network"];

    const defaults = await command(
      ["fetch-markdown", "https://example.com/default", defaultDestination, ...common],
      { home, env },
    );
    expect(defaults.code, defaults.stderr).toBe(0);
    expect(existsSync(join(directory, "default.raw.html"))).toBeFalse();
    expect(existsSync(join(directory, "default.selected.html"))).toBeFalse();

    const retained = await command(
      [
        "fetch-markdown",
        "https://example.com/retained",
        retainedDestination,
        ...common,
        "--retain-artifacts",
      ],
      { home, env },
    );
    expect(retained.code, retained.stderr).toBe(0);
    expect(readFileSync(join(directory, "retained.raw.html"), "utf8")).toBe(
      "<html><body><main>CLI body</main></body></html>",
    );
    expect(readFileSync(join(directory, "retained.selected.html"), "utf8")).toBe(
      "<main>CLI body</main>",
    );
    expect(statSync(join(directory, "retained.raw.html")).mode & 0o077).toBe(0);
    expect(statSync(join(directory, "retained.selected.html")).mode & 0o077).toBe(0);
  });

  test("structured CLI destinations retain browser evidence policy without HTML sidecars", async () => {
    const directory = temp();
    const home = join(directory, "home");
    mkdirSync(home);
    const browser = cliBrowser(directory);
    const env = { AGENTSCRAPE_AGENT_BROWSER_BIN: browser.path };

    for (const selected of ["json", "yaml"] as const) {
      const destination = join(directory, `retained.${selected}`);
      const result = await command(
        [
          "fetch-markdown",
          `https://example.com/${selected}`,
          destination,
          `--${selected}`,
          "--generic",
          "--allow-private-network",
          "--retain-artifacts",
        ],
        { home, env },
      );
      expect(result.code, result.stderr).toBe(0);
      const persisted = readFileSync(destination, "utf8");
      if (selected === "json") expect(persisted.trimStart().startsWith("{")).toBeTrue();
      else {
        expect(persisted.trimStart().startsWith("{")).toBeFalse();
        expect(persisted).toContain("content: CLI body");
      }
      const parsed = selected === "json" ? JSON.parse(persisted) : parseYaml(persisted);
      expect(parsed).toMatchObject({ content: "CLI body" });
      expect(existsSync(join(directory, "retained.raw.html"))).toBeFalse();
      expect(existsSync(join(directory, "retained.selected.html"))).toBeFalse();
    }
  });

  test("CLI forbids envelope retention before browser/files and prints a separate artifact notice", async () => {
    const directory = temp();
    const home = join(directory, "home");
    mkdirSync(home);
    const browser = cliBrowser(directory);
    const env = { AGENTSCRAPE_AGENT_BROWSER_BIN: browser.path };
    const forbidden = join(directory, "forbidden.json");
    const rejected = await command(
      [
        "fetch-markdown",
        "https://example.com/page",
        forbidden,
        "--generic",
        "--allow-private-network",
        "--envelope",
        "--retain-artifacts",
      ],
      { home, env },
    );
    expect(rejected.code).toBe(2);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("cannot be combined");
    expect(existsSync(forbidden)).toBeFalse();
    expect(existsSync(browser.events)).toBeFalse();

    const failed = await command(
      [
        "fetch-markdown",
        "https://x.com/example/status/1",
        "--preset",
        "x-tweet",
        "--allow-private-network",
        "--retain-artifacts",
      ],
      { home, env },
    );
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    const lines = failed.stderr.trim().split("\n");
    const notice = lines.find((line) => line.startsWith("Artifacts retained: "));
    const diagnostic = lines.find((line) => line.startsWith("Error: "));
    expect(notice).toBeString();
    expect(diagnostic).toBeString();
    const artifactDirectory = notice!.slice("Artifacts retained: ".length);
    temporary.push(artifactDirectory);
    expect(diagnostic).not.toContain(artifactDirectory);
    expect(failed.stderr).not.toContain("CLI-WAIT-SECRET");
    expect(failed.stderr).not.toContain("CLI-URL-SECRET");
    expect(statSync(artifactDirectory).mode & 0o077).toBe(0);
    const screenshot = readdirSync(artifactDirectory)[0]!;
    expect(statSync(join(artifactDirectory, screenshot)).mode & 0o077).toBe(0);
  });

  test("corpus filter smoke passes", async () => {
    const result = await command(["test-corpus", "--preset", "deepwiki-wiki-page"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 passed, 0 failed");
  });
  test("canary command requires live acknowledgement and browser network consent", async () => {
    const withoutLive = await command(["check-presets"]);
    expect(withoutLive.code).toBe(2);
    expect(withoutLive.stderr).toContain("requires --live");

    const withoutConsent = await command([
      "check-presets",
      "--live",
      "--preset",
      "deepwiki-wiki-page",
    ]);
    expect(withoutConsent.code).toBe(2);
    expect(withoutConsent.stdout).toBe("");
    expect(withoutConsent.stderr).toContain(
      "Browser-backed live navigation requires explicit unrestricted network consent",
    );
  });
  test("empty queue and reconciliation commands are safe in an isolated home", async () => {
    const home = temp();
    const processResult = await command(["process-queue"], { home });
    expect(processResult.code).toBe(0);
    expect(processResult.stderr).toContain("processed=0");
    const inventory = await command(["reconcile-queue"], { home });
    expect(inventory.code).toBe(0);
    expect(JSON.parse(inventory.stdout).total_records).toBe(0);
  });
  test("queue inventory redacts malformed records and processing drains frozen records", async () => {
    const home = temp();
    const queue = join(home, ".local/share/agentscrape/queue");
    mkdirSync(queue, { recursive: true });
    writeFileSync(
      join(queue, "indexed.yaml"),
      "url: https://example.com/a\ndestination: /tmp/a.md\nindexer: agentbrain\nsource: agentbot\n",
    );
    writeFileSync(
      join(queue, "malformed.yaml"),
      "url: [unterminated\npassword: TOP-SECRET-MALFORMED\n",
    );
    const inventory = await command(["reconcile-queue"], { home });
    expect(inventory.code).toBe(0);
    expect(JSON.parse(inventory.stdout).total_records).toBe(2);
    expect(inventory.stdout).not.toContain("TOP-SECRET-MALFORMED");
    const processed = await command(["process-queue"], { home });
    expect(processed.code).toBe(0);
    expect(existsSync(join(queue, "indexed.yaml"))).toBeFalse();
    expect(readdirSync(join(home, ".local/share/agentscrape/frozen"))).toHaveLength(1);
    expect(processed.stderr).toContain(
      "processed=0 failed=1 frozen=1 retry_scheduled=0 retry_waiting=0 retry_exhausted=0",
    );
    expect(existsSync(join(home, ".local/share/agentscrape/failed/malformed.yaml"))).toBeTrue();
  });
  test("usage failures use exit 2 across an argv compatibility table", async () => {
    const cases: Array<[string[], string]> = [
      [[], "missing command"],
      [["does-not-exist"], "unknown command"],
      [["fetch-markdown"], "requires URL"],
      [["fetch-markdown", "https://example.com", "--bogus"], "unknown option"],
      [["fetch-markdown", "https://example.com", "--media", "sepia"], "--media"],
      [["fetch-markdown", "https://example.com", "--max-content-bytes", "1.5"], "integer"],
      [["fetch-markdown", "https://example.com", "--max-relations", "-1"], "at least 0"],
      [["fetch-links", "https://x.com/example", "--limit", "0"], "at least 1"],
      [["fetch-links", "https://x.com/example", "--max-scrolls", "1.5"], "integer"],
      [["fetch-links", "https://x.com/example", "--since-id", "abc"], "only digits"],
      [["fetch-links", "https://x.com/example", "--json", "--yaml"], "one output format"],
      [
        [
          "discover-feed",
          "test/fixtures/feeds/rss.xml",
          "test/fixtures/feeds/atom.xml",
          "--source-url",
          "https://blog.example.com/feed.xml",
        ],
        "at most one FILE",
      ],
      [["discover-feed", "test/fixtures/feeds/rss.xml"], "requires --source-url"],
      [
        ["discover-feed", "", "--source-url", "https://blog.example.com/feed.xml"],
        "FILE must be non-empty",
      ],
      [
        [
          "discover-feed",
          "test/fixtures/feeds/rss.xml",
          "--source-url",
          "https://blog.example.com/feed.xml",
          "--source-kind",
          "other",
        ],
        "--source-kind",
      ],
      [
        [
          "discover-feed",
          "test/fixtures/feeds/rss.xml",
          "--source-url",
          "https://blog.example.com/feed.xml",
          "--max-pages",
          "101",
        ],
        "at most 100",
      ],
      [["reconcile-queue", "--limit", "0"], "at least 1"],
      [["list-presets", "--format", "xml"], "--format"],
    ];
    for (const [argv, message] of cases) {
      const result = await command(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stdout, argv.join(" ")).toBe("");
      expect(result.stderr, argv.join(" ")).toContain(message);
    }
  });

  test("compatibility help and format positions are accepted and documented", async () => {
    for (const argv of [
      ["--format", "yaml", "list-presets"],
      ["list-presets", "--format", "human"],
      ["--agent-help"],
      ["--agent-teaser"],
      ["--help-json"],
      ["fetch-links", "--help-json"],
      ["discover-feed", "--help-json"],
    ]) {
      const result = await command(argv);
      expect(result.code, argv.join(" ")).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    }
    const rootJson = (await command(["--help-json"])).stdout;
    const linksJson = (await command(["fetch-links", "--help-json"])).stdout;
    const feedJson = JSON.parse((await command(["discover-feed", "--help-json"])).stdout);
    expect(() => JSON.parse(rootJson)).not.toThrow();
    expect(() => JSON.parse(linksJson)).not.toThrow();
    expect(feedJson.arguments.find((argument: any) => argument.name === "file")).toMatchObject({
      positional: true,
      required: false,
    });
    expect(
      feedJson.arguments.find((argument: any) => argument.name === "--source-url"),
    ).toMatchObject({ required: true });
    expect((await command(["discover-feed", "--help"])).stdout).toContain(
      "discover-feed [FILE] --source-url URL",
    );
    const markdownHelp = (await command(["fetch-markdown", "--help"])).stdout;
    for (const option of [
      "--selector",
      "--media",
      "--session",
      "--preset",
      "--generic",
      "--retain-artifacts",
      "--max-content-bytes",
      "--max-relations",
      "--allow-private-network",
    ])
      expect(markdownHelp).toContain(option);
    const markdownJson = JSON.parse((await command(["fetch-markdown", "--help-json"])).stdout);
    expect(
      markdownJson.arguments.find((argument: any) => argument.name === "--retain-artifacts"),
    ).toMatchObject({ type: "flag", required: false });
    const captureHelp = (await command(["capture-corpus", "--help"])).stdout;
    const canaryHelp = (await command(["check-presets", "--help"])).stdout;
    expect(captureHelp).toContain("--allow-private-network");
    expect(canaryHelp).toContain("--allow-private-network");
    const captureJson = JSON.parse((await command(["capture-corpus", "--help-json"])).stdout);
    expect(
      captureJson.arguments.find((argument: any) => argument.name === "--allow-private-network"),
    ).toMatchObject({ type: "flag", required: false });
    const linksHelp = (await command(["fetch-links", "--help"])).stdout;
    for (const option of [
      "--section-selector",
      "--category-selector",
      "--toggle-selector",
      "--limit",
      "--max-scrolls",
      "--since-id",
      "--include-replies",
      "--include-reposts",
      "--media",
      "--session",
      "--allow-private-network",
    ])
      expect(linksHelp).toContain(option);
  });

  test("recursive conversion skips symlinks and never clobbers destinations", async () => {
    const directory = temp();
    const outside = temp();
    writeFileSync(join(directory, "safe.html"), "<h1>Safe</h1>");
    writeFileSync(join(directory, "occupied.html"), "<h1>Keep source</h1>");
    writeFileSync(join(directory, "occupied.md"), "existing");
    writeFileSync(join(directory, "blocked.html"), "<h1>Blocked</h1>");
    writeFileSync(join(outside, "target.md"), "outside");
    writeFileSync(join(outside, "linked.html"), "<h1>Outside</h1>");
    symlinkSync(join(outside, "target.md"), join(directory, "blocked.md"));
    symlinkSync(join(outside, "linked.html"), join(directory, "linked.html"));
    symlinkSync(outside, join(directory, "linked-directory"));

    const result = await command(["convert-html", "--dir", directory]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(directory, "safe.md"), "utf8")).toContain("# Safe");
    expect(existsSync(join(directory, "safe.html"))).toBeFalse();
    expect(readFileSync(join(directory, "occupied.md"), "utf8")).toBe("existing");
    expect(existsSync(join(directory, "occupied.html"))).toBeTrue();
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("outside");
    expect(existsSync(join(directory, "blocked.html"))).toBeTrue();
    expect(existsSync(join(outside, "linked.html"))).toBeTrue();

    const rootLink = join(temp(), "root-link");
    symlinkSync(directory, rootLink);
    const refused = await command(["convert-html", "--dir", rootLink]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("real directory");
  });

  test("signals emit one cancelled envelope and stay quiet outside envelope mode", async () => {
    let arrived: (() => void) | undefined;
    const nextArrival = () =>
      new Promise<void>((resolve) => {
        arrived = resolve;
      });
    let requestArrived = nextArrival();
    const server = Bun.serve({
      port: 0,
      fetch() {
        arrived?.();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(30_000);
              controller.enqueue(new TextEncoder().encode("late"));
            },
          }),
        );
      },
    });
    const runInterrupted = async (envelope: boolean, signal: "SIGINT" | "SIGTERM") => {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "fetch-markdown",
          `http://127.0.0.1:${server.port}/slow.md`,
          "--allow-private-network",
          ...(envelope ? ["--envelope"] : []),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      await requestArrived;
      requestArrived = nextArrival();
      child.kill(signal);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    try {
      const envelope = await runInterrupted(true, "SIGINT");
      expect(envelope.code).toBe(130);
      expect(envelope.stderr).toBe("");
      const payload = JSON.parse(envelope.stdout);
      expect(payload.schema_version).toBe("1");
      expect(payload.status).toBe("failure");
      expect(payload.failure.failure_class).toBe("cancelled");
      expect(envelope.stdout.match(/"failure_class"/g)).toHaveLength(1);

      const plain = await runInterrupted(false, "SIGTERM");
      expect(plain.code).toBe(143);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toBe("");
    } finally {
      server.stop(true);
    }
  });
});

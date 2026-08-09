// Characterization of the three config loaders — presets, corpus meta, canaries — pinning the
// accept/reject sets and the error prose the rest of the suite relies on. Written against the
// hand-rolled validators before the zod port; the port must keep every pin green.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPresets } from "../src/canary";
import { CorpusError, loadMeta } from "../src/corpus";
import { PresetConfigError } from "../src/errors";
import { loadRegistry, validatePresetFile } from "../src/presets";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-config-validation-"));
  temporary.push(path);
  return path;
}
function presetProblems(preset: Record<string, unknown>): string[] {
  const path = join(directory(), "probe.json");
  writeFileSync(path, `${JSON.stringify(preset, null, 2)}\n`);
  return validatePresetFile(path);
}
const linksBase = {
  name: "probe",
  summary: "characterization probe",
  domain: "probe.test",
  mode: "links",
  selector: "nav",
};
const contentBase = {
  name: "probe",
  summary: "characterization probe",
  domain: "probe.test",
  mode: "content",
  handler: "x.scrape_tweet",
  schema: "TweetThread",
};
const navBase = {
  name: "probe",
  summary: "characterization probe",
  domain: "probe.test",
  mode: "nav-links",
  section_selector: "nav a",
  category_selector: "main a",
};

describe("preset validator characterization", () => {
  test("accepts the three mode baselines and empty-string identity fields", () => {
    expect(presetProblems(linksBase)).toEqual([]);
    expect(presetProblems(contentBase)).toEqual([]);
    expect(presetProblems(navBase)).toEqual([]);
    expect(presetProblems({ ...linksBase, name: "" })).toEqual([]);
    expect(presetProblems({ ...contentBase, aliases: [], url_patterns: [] })).toEqual([]);
  });
  test("tolerates null wherever a string is expected", () => {
    // The strict string check deliberately lets null through; only the per-mode
    // requires checks reject a null where a nonempty selector or handler is needed.
    expect(presetProblems({ name: null, summary: null, domain: null, mode: null })).toEqual([]);
    expect(presetProblems({ ...linksBase, browser_profile: null, toggle_selector: null })).toEqual(
      [],
    );
    expect(presetProblems({ ...contentBase, handler: null })).toEqual([
      "content mode requires 'handler'",
    ]);
  });
  test("tolerates the editor $schema pointer whatever its value", () => {
    expect(presetProblems({ ...linksBase, $schema: 42 })).toEqual([]);
    expect(presetProblems({ ...linksBase, $schema: { nested: true } })).toEqual([]);
  });
  test("names unknown keys in one sorted message", () => {
    expect(presetProblems({ ...linksBase, zeta: 1, alpha: 2 })).toEqual([
      "unknown keys: alpha, zeta",
    ]);
  });
  test("reports missing required fields in declaration order", () => {
    expect(presetProblems({})).toEqual([
      "missing required field: name",
      "missing required field: summary",
      "missing required field: domain",
      "missing required field: mode",
    ]);
  });
  test("rejects non-string, non-null values for every string field", () => {
    for (const value of [42, true, [], {}]) {
      expect(presetProblems({ ...linksBase, name: value })).toEqual([
        "field 'name' must be a string",
      ]);
    }
    expect(presetProblems({ ...linksBase, summary: 42 })).toEqual([
      "field 'summary' must be a string",
    ]);
    expect(presetProblems({ ...linksBase, domain: 42 })).toEqual([
      "field 'domain' must be a string",
    ]);
    expect(presetProblems({ ...linksBase, browser_profile: 42 })).toEqual([
      "field 'browser_profile' must be a string",
    ]);
    expect(presetProblems({ ...navBase, toggle_selector: 42 })).toEqual([
      "field 'toggle_selector' must be a string",
    ]);
    expect(presetProblems({ ...contentBase, handler: 42 })).toEqual([
      "field 'handler' must be a string",
      "content mode requires 'handler'",
    ]);
    expect(presetProblems({ ...linksBase, selector: 42 })).toEqual([
      "field 'selector' must be a string",
      "links mode requires 'selector'",
    ]);
  });
  test("a non-string mode is a type problem, not an enum problem", () => {
    expect(presetProblems({ name: "p", summary: "s", domain: "d.test", mode: 42 })).toEqual([
      "field 'mode' must be a string",
    ]);
    expect(presetProblems({ name: "p", summary: "s", domain: "d.test", mode: "bogus" })).toEqual([
      "invalid mode: 'bogus' (must be one of content, links, nav-links)",
    ]);
  });
  test("list fields reject null and non-string items with one message per field", () => {
    for (const value of [null, "x", [1], ["a", 2]]) {
      expect(presetProblems({ ...linksBase, aliases: value })).toEqual([
        "field 'aliases' must be a list of strings",
      ]);
    }
    expect(presetProblems({ ...contentBase, url_patterns: null })).toEqual([
      "field 'url_patterns' must be a list of strings",
    ]);
    expect(presetProblems({ ...contentBase, url_patterns: ["^a$", 7] })).toEqual([
      "field 'url_patterns' must be a list of strings",
    ]);
    expect(presetProblems({ ...contentBase, url_patterns: [7, "no-anchor"] })).toEqual([
      "field 'url_patterns' must be a list of strings",
      "url_pattern 'no-anchor' must have visible start (^) and end ($) anchors",
    ]);
  });
  test("an unanchored, uncompilable pattern earns both pattern messages in order", () => {
    const problems = presetProblems({ ...contentBase, url_patterns: ["(bad"] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toBe("url_pattern '(bad' must have visible start (^) and end ($) anchors");
    expect(problems[1]).toStartWith("invalid url_pattern '(bad': ");
  });
  test("fields from another mode are named even when null, and patterns are still checked", () => {
    expect(presetProblems({ ...linksBase, handler: null })).toEqual([
      "fields not valid for mode 'links': handler",
    ]);
    expect(presetProblems({ ...linksBase, url_patterns: ["^a$"], handler: "h" })).toEqual([
      "fields not valid for mode 'links': handler, url_patterns",
    ]);
    expect(presetProblems({ ...linksBase, url_patterns: ["unanchored"] })).toEqual([
      "fields not valid for mode 'links': url_patterns",
      "url_pattern 'unanchored' must have visible start (^) and end ($) anchors",
    ]);
  });
  test("per-mode requires demand nonempty strings", () => {
    // An empty handler is still a string, so the pair check runs and reports it too.
    expect(presetProblems({ ...contentBase, handler: "" })).toEqual([
      "content mode requires 'handler'",
      "handler '' is not registered with schema 'TweetThread'",
    ]);
    expect(presetProblems({ name: "p", summary: "s", domain: "d.test", mode: "links" })).toEqual([
      "links mode requires 'selector'",
    ]);
    expect(
      presetProblems({ name: "p", summary: "s", domain: "d.test", mode: "nav-links" }),
    ).toEqual([
      "nav-links mode requires 'section_selector'",
      "nav-links mode requires 'category_selector'",
    ]);
  });
  test("content references must resolve to the registered pair", () => {
    expect(presetProblems({ ...contentBase, handler: "no.such" })).toEqual([
      "cannot resolve handler 'no.such'; the CLI does not load local executable code (register trusted TypeScript handlers through the package API)",
      "handler 'no.such' is not registered with schema 'TweetThread'",
    ]);
    expect(presetProblems({ ...contentBase, schema: "NoSchema" })).toEqual([
      "schema 'NoSchema' is not a ScrapeSchema class",
    ]);
    expect(presetProblems({ ...contentBase, schema: "XArticle" })).toEqual([
      "handler 'x.scrape_tweet' is not registered with schema 'XArticle'",
    ]);
  });
  test("selector fields must be valid CSS for the mode that uses them", () => {
    const linksProblems = presetProblems({ ...linksBase, selector: "[" });
    expect(linksProblems).toHaveLength(1);
    expect(linksProblems[0]).toStartWith("field 'selector' is not valid CSS: ");
    const navProblems = presetProblems({ ...navBase, section_selector: "[", toggle_selector: "]" });
    expect(navProblems).toHaveLength(2);
    expect(navProblems[0]).toStartWith("field 'section_selector' is not valid CSS: ");
    expect(navProblems[1]).toStartWith("field 'toggle_selector' is not valid CSS: ");
  });
  test("registry aggregation dedupes, sorts, and names duplicate identities", () => {
    const official = directory();
    const write = (file: string, preset: Record<string, unknown>) =>
      writeFileSync(join(official, file), `${JSON.stringify(preset, null, 2)}\n`);
    mkdirSync(official, { recursive: true });
    // Duplicate-name detection only sees presets that validate on their own.
    write("one.json", { ...linksBase, name: "dup" });
    write("two.json", { ...linksBase, name: "dup", selector: "main" });
    write("zeta.json", { ...linksBase, name: "zeta-carrier", zeta: 1 });
    write("three.json", {
      ...contentBase,
      name: "pat-a",
      url_patterns: ["^https://probe[.]test/a$"],
    });
    write("four.json", {
      ...contentBase,
      name: "pat-b",
      url_patterns: ["^https://probe[.]test/a$"],
    });
    try {
      loadRegistry({ officialDir: official, localDir: join(official, "absent") });
      throw new Error("registry unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(PresetConfigError);
      const problems = (error as PresetConfigError).problems;
      expect(problems).toEqual([...problems].sort());
      expect(problems).toContain("duplicate preset name 'dup' within official presets");
      expect(problems).toContain(
        "url_pattern '^https://probe[.]test/a$' is declared by multiple presets: pat-a, pat-b",
      );
      expect(problems).toContain("zeta.json (official): unknown keys: zeta");
    }
  });
});

function metaError(meta: unknown): string {
  const root = directory();
  writeFileSync(
    join(root, "meta.json"),
    typeof meta === "string" ? meta : `${JSON.stringify(meta, null, 2)}\n`,
  );
  try {
    loadMeta(root);
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusError);
    return (error as Error).message;
  }
  throw new Error("loadMeta unexpectedly succeeded");
}
const validMeta = {
  version: 1,
  preset: "probe",
  mode: "links",
  url: "https://probe.test/",
  expect: "success",
};

describe("corpus meta loader characterization", () => {
  test("returns the raw object, unknown keys and unchecked field types included", () => {
    const root = directory();
    const meta = {
      ...validMeta,
      preset: null,
      url: 42,
      links: "not-a-list",
      failure: "not-an-object",
      assertions: 7,
      category_pages: {},
      custom_note: "kept",
    };
    writeFileSync(join(root, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    const loaded = loadMeta(root) as unknown as Record<string, unknown>;
    expect(loaded).toEqual(meta);
  });
  test("checks the contract version first, missing means undefined", () => {
    expect(metaError({})).toBe("unsupported sample contract version undefined (expected 1)");
    expect(metaError({ ...validMeta, version: "1" })).toBe(
      "unsupported sample contract version 1 (expected 1)",
    );
    expect(metaError({ ...validMeta, version: 2 })).toBe(
      "unsupported sample contract version 2 (expected 1)",
    );
  });
  test("names the first missing required field before judging values", () => {
    expect(metaError({ version: 1 })).toBe("meta.json missing required field: preset");
    expect(metaError({ version: 1, preset: "p" })).toBe("meta.json missing required field: mode");
    expect(metaError({ version: 1, preset: "p", mode: "bogus" })).toBe(
      "meta.json missing required field: url",
    );
    expect(metaError({ version: 1, preset: "p", mode: "links", url: "u" })).toBe(
      "meta.json missing required field: expect",
    );
  });
  test("rejects unsupported modes and expectations with the offending value", () => {
    expect(metaError({ ...validMeta, mode: "bogus" })).toBe(
      "meta.json has unsupported mode: 'bogus'",
    );
    expect(metaError({ ...validMeta, mode: null })).toBe("meta.json has unsupported mode: 'null'");
    expect(metaError({ ...validMeta, mode: 42 })).toBe("meta.json has unsupported mode: '42'");
    expect(metaError({ ...validMeta, expect: "maybe" })).toBe(
      "meta.json 'expect' must be 'success' or 'failure', got 'maybe'",
    );
    expect(metaError({ ...validMeta, expect: null })).toBe(
      "meta.json 'expect' must be 'success' or 'failure', got 'null'",
    );
  });
  test("reports absent, malformed, and non-object files by shape", () => {
    expect(() => loadMeta(directory())).toThrow("missing meta.json");
    expect(metaError("{ truncated")).toStartWith("malformed meta.json: ");
    expect(metaError("[]\n")).toBe("meta.json must be a JSON object");
    expect(metaError("null\n")).toBe("meta.json must be a JSON object");
  });
});

function canaryFile(content: unknown): string {
  const path = join(directory(), "canaries.json");
  writeFileSync(
    path,
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
  return path;
}

describe("canary loader characterization", () => {
  test("rejects non-object roots with the mapping message", async () => {
    for (const content of ["[]\n", "null\n", "5\n", '"x"\n']) {
      await expect(checkPresets({ canaryPath: canaryFile(content) })).rejects.toThrow(
        "preset-canaries.json must be a JSON object mapping preset name to config",
      );
    }
  });
  test("strips the editor $schema pointer whatever its value", async () => {
    const envelope = await checkPresets({ canaryPath: canaryFile({ $schema: 99 }) });
    expect(envelope.results).toEqual([]);
  });
  test("never validates canary entries: junk degrades to not_configured", async () => {
    const canaryPath = canaryFile({
      "x-tweet": 5,
      "x-article": { invariants: { min_markdown_chars: "junk" } },
      "x-profile": { url: "" },
      "deepwiki-wiki-page": null,
      ghost: { url: "https://probe.test/" },
    });
    const envelope = await checkPresets({
      canaryPath,
      presets: ["x-tweet", "x-article", "x-profile", "deepwiki-wiki-page", "ghost"],
    });
    expect(envelope.results).toEqual([
      { preset: "x-tweet", status: "not_configured", detail: "no canary url configured" },
      { preset: "x-article", status: "not_configured", detail: "no canary url configured" },
      { preset: "x-profile", status: "not_configured", detail: "no canary url configured" },
      { preset: "deepwiki-wiki-page", status: "not_configured", detail: "no canary configured" },
      { preset: "ghost", status: "not_configured", detail: "preset not found in registry" },
    ]);
  });
});

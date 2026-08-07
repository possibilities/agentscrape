import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresetConfigError, PresetOutputError, PresetSelectionError } from "../src/errors";
import { officialExtractorDefinitions, resolveExtractorDefinition } from "../src/extractors";
import {
  canonicalMatchUrl,
  loadRegistry,
  matchPreset,
  registerContentHandler,
  resolveContentDefinition,
  schemaNames,
  scrapeWithPreset,
  selectPreset,
  validateContentResult,
  validatePresetFile,
} from "../src/presets";
import { GenericPage, ScrapeSchema, TweetContent, TweetThread } from "../src/schemas";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-preset-"));
  temporary.push(path);
  return path;
}
function writePreset(path: string, name: string, text: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${name}.yaml`), text);
}

describe("strict preset registry", () => {
  test("loads every official preset", () => {
    const registry = loadRegistry();
    expect(registry.presets.map((item) => item.name)).toContain("deepwiki-wiki-page");
    expect(registry.presets.map((item) => item.name)).toContain("x-article");
    expect(registry.presets).toHaveLength(9);
  });
  test("publishes one immutable definition for every official content pair", () => {
    const expectedPairs = [
      "chatgpt.scrape_conversation:ChatGPTConversation",
      "deepwiki.scrape_search_conversation:DeepWikiSearchConversation",
      "deepwiki.scrape_wiki_page:DeepWikiWikiPage",
      "x.scrape_article:XArticle",
      "x.scrape_profile:XProfile",
      "x.scrape_timeline:XTimeline",
      "x.scrape_tweet:TweetThread",
    ];
    const pairs = officialExtractorDefinitions.map(
      (definition) => `${definition.handlerName}:${definition.schemaName}`,
    );
    expect(pairs).toEqual(expectedPairs);
    expect(new Set(pairs).size).toBe(7);
    expect(Object.isFrozen(officialExtractorDefinitions)).toBeTrue();
    for (const definition of officialExtractorDefinitions) {
      expect(Object.isFrozen(definition), definition.schemaName).toBeTrue();
      expect(Object.isFrozen(definition.capabilities), definition.schemaName).toBeTrue();
      expect(Object.isFrozen(definition.implementationIdentity), definition.schemaName).toBeTrue();
      expect(definition.capabilities.browser, definition.schemaName).toBeTrue();
      expect(definition.capabilities.markdown, definition.schemaName).toBeTrue();
      expect(definition.projector, definition.schemaName).toBeFunction();
      expect(resolveExtractorDefinition(definition.handlerName, definition.schemaName)).toBe(
        definition,
      );
    }

    const contentPresets = loadRegistry().presets.filter((preset) => preset.mode === "content");
    expect(contentPresets).toHaveLength(7);
    for (const preset of contentPresets) {
      const definition = resolveContentDefinition(preset);
      expect(definition, preset.name).not.toBeNull();
      expect(definition?.handlerName).toBe(preset.handler);
      expect(definition?.schemaName).toBe(preset.schema);
      expect(Object.isFrozen(definition), preset.name).toBeTrue();
    }
    expect(schemaNames()).toEqual(
      officialExtractorDefinitions.map((definition) => definition.schemaName).sort(),
    );
  });
  test("canonicalizes only credential-free HTTP URLs", () => {
    expect(canonicalMatchUrl("HTTPS://X.COM:443/User?a=1#fragment")).toBe("https://x.com/User?a=1");
    expect(canonicalMatchUrl("https://user:pass@x.com/a")).toBeNull();
    expect(canonicalMatchUrl("file:///tmp/a")).toBeNull();
  });
  test("matches anchored official routes without look-alike hosts", () => {
    const registry = loadRegistry();
    expect(registry.pageKindMatches("https://x.com/user/status/123")[0]?.name).toBe("x-tweet");
    expect(registry.pageKindMatches("https://x.com.evil.test/user/status/123")).toEqual([]);
    expect(registry.pageKindMatches("https://x.com/user/status/123/extra")[0]?.name).toBe(
      "x-tweet",
    );
  });
  test("fails closed on claimed unsupported routes", () => {
    const registry = loadRegistry();
    expect(() => selectPreset("https://x.com/deep/unsupported/path", registry)).toThrow(
      PresetSelectionError,
    );
    expect(
      selectPreset("https://x.com/deep/unsupported/path", registry, { generic: true }),
    ).toBeNull();
    expect(selectPreset("https://example.test/a", registry)).toBeNull();
  });
  test("named presets and generic override conflict", () => {
    const registry = loadRegistry();
    expect(() => selectPreset("https://x.com/a", registry, { preset: "missing" })).toThrow(
      "not found",
    );
    expect(() =>
      selectPreset("https://x.com/a", registry, { preset: "x-tweet", generic: true }),
    ).toThrow("conflicts");
  });
  test("explicit-only timeline never auto-matches", () => {
    const registry = loadRegistry();
    expect(registry.byName("x-timeline")?.url_patterns).toEqual([]);
    expect(matchPreset("https://x.com/karpathy", registry.presets)?.name).toBe("x-profile");
  });
  test("matches only exact DeepWiki wiki and search routes", () => {
    const registry = loadRegistry();
    for (const url of [
      "https://deepwiki.com/acme/widget",
      "https://www.deepwiki.com/acme/widget/",
      "https://deepwiki.com/acme/widget?mode=fast",
    ]) {
      expect(
        registry.pageKindMatches(url).map((preset) => preset.name),
        url,
      ).toEqual(["deepwiki-wiki-page"]);
    }
    for (const url of [
      "https://deepwiki.com/search/example_abc",
      "https://www.deepwiki.com/search/example-abc/",
      "https://deepwiki.com/search/example_abc?mode=fast",
    ]) {
      expect(
        registry.pageKindMatches(url).map((preset) => preset.name),
        url,
      ).toEqual(["deepwiki-search-conversation"]);
    }
    for (const url of [
      "https://deepwiki.com/acme/widget/extra",
      "https://deepwiki.com/search/example_abc/extra",
    ]) {
      expect(registry.pageKindMatches(url), url).toEqual([]);
      expect(() => selectPreset(url, registry), url).toThrow(PresetSelectionError);
    }
  });
  test("does not match embedded DeepWiki URLs on unrelated hosts", () => {
    const registry = loadRegistry();
    for (const url of [
      "https://unrelated.test/https://deepwiki.com/acme/widget",
      "https://unrelated.test/?next=https://deepwiki.com/search/example_abc",
    ]) {
      expect(registry.pageKindMatches(url), url).toEqual([]);
    }
  });
  test("reserved X application routes never auto-match profiles", () => {
    const registry = loadRegistry();
    const reserved = [
      "i",
      "home",
      "search",
      "explore",
      "notifications",
      "messages",
      "settings",
      "compose",
      "intent",
    ];
    const mixedCase = (word: string) =>
      [...word]
        .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character))
        .join("");
    for (const host of ["x.com", "twitter.com"])
      for (const word of reserved)
        for (const route of [word, `${word.toUpperCase()}/`, `${mixedCase(word)}?view=app`]) {
          const url = `https://${host}/${route}`;
          expect(registry.pageKindMatches(url), url).toEqual([]);
          expect(() => selectPreset(url, registry), url).toThrow(PresetSelectionError);
        }
  });
  test("ordinary mixed-case and underscore X handles still auto-match profiles", () => {
    const registry = loadRegistry();
    for (const url of [
      "https://x.com/Mixed_Case?tab=posts",
      "https://www.twitter.com/Another_User/",
    ]) {
      expect(
        registry.pageKindMatches(url).map((preset) => preset.name),
        url,
      ).toEqual(["x-profile"]);
    }
  });
  test("local preset can shadow one official contract", () => {
    const local = directory();
    const official = directory();
    writePreset(
      official,
      "x",
      "name: x\nsummary: official\ndomain: x.test\nmode: links\nselector: nav\n",
    );
    writePreset(
      local,
      "x",
      "name: x\nsummary: local\ndomain: x.test\nmode: links\nselector: main\n",
    );
    const registry = loadRegistry({ officialDir: official, localDir: local });
    expect(registry.presets).toHaveLength(1);
    expect(registry.byName("x")?.summary).toBe("local");
    expect(registry.byName("x")?.source).toBe("local");
  });
  test("gates automatic matching by the declared domain and aliases", () => {
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "host-gated",
      "name: host-gated\nsummary: Host-gated route\ndomain: allowed.test\naliases: [alias.test]\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['^https://[^/]+/page$']\n",
    );
    const registry = loadRegistry({ officialDir: official, localDir: local });
    for (const url of [
      "https://allowed.test/page",
      "https://www.allowed.test/page",
      "https://alias.test/page",
    ]) {
      expect(
        registry.pageKindMatches(url).map((preset) => preset.name),
        url,
      ).toEqual(["host-gated"]);
    }
    expect(registry.pageKindMatches("https://other.test/page")).toEqual([]);
  });
  test("keeps wildcard-domain automatic matching host-agnostic", () => {
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "wildcard",
      "name: wildcard\nsummary: Host-agnostic route\ndomain: '*'\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['^https://[^/]+/portable$']\n",
    );
    const registry = loadRegistry({ officialDir: official, localDir: local });
    for (const url of ["https://one.test/portable", "https://elsewhere.invalid/portable"])
      expect(
        registry.pageKindMatches(url).map((preset) => preset.name),
        url,
      ).toEqual(["wildcard"]);
  });
  test("requires visible anchors for published automatic patterns", () => {
    const official = directory();
    const invalid = directory();
    writePreset(
      invalid,
      "unanchored",
      "name: unanchored\nsummary: Invalid automatic routes\ndomain: local.test\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['https://local[.]test/page', '^https://local[.]test/start-only']\n",
    );
    const invalidPath = join(invalid, "unanchored.yaml");
    const fileProblems = validatePresetFile(invalidPath);
    expect(fileProblems).toHaveLength(2);
    expect(
      fileProblems.every((problem) => problem.includes("visible start (^) and end ($) anchors")),
    ).toBeTrue();
    try {
      loadRegistry({ officialDir: official, localDir: invalid });
      throw new Error("unanchored preset unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(PresetConfigError);
      expect((error as PresetConfigError).problems).toHaveLength(2);
      expect((error as PresetConfigError).problems.join(" ")).toContain("visible start");
    }

    const valid = directory();
    writePreset(
      valid,
      "anchored",
      "name: anchored\nsummary: Valid automatic route\ndomain: local.test\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['^https://local[.]test/page$']\n",
    );
    expect(validatePresetFile(join(valid, "anchored.yaml"))).toEqual([]);
    expect(
      loadRegistry({ officialDir: official, localDir: valid }).byName("anchored"),
    ).not.toBeNull();
  });
  test("requires runtime regex matches to span the canonical URL", () => {
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "alternation",
      "name: alternation\nsummary: Superficially anchored alternation\ndomain: allowed.test\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['^https://allowed[.]test/page|suffix$']\n",
    );
    expect(validatePresetFile(join(local, "alternation.yaml"))).toEqual([]);
    const registry = loadRegistry({ officialDir: official, localDir: local });
    expect(
      registry.pageKindMatches("https://allowed.test/page").map((preset) => preset.name),
    ).toEqual(["alternation"]);
    expect(registry.pageKindMatches("https://allowed.test/page/extra")).toEqual([]);
    expect(registry.pageKindMatches("https://allowed.test/only-suffix")).toEqual([]);
  });
  test("explicit by-name selection is independent of URL eligibility", () => {
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "named",
      "name: named\nsummary: Explicit route\ndomain: allowed.test\nmode: content\nhandler: chatgpt.scrape_conversation\nschema: ChatGPTConversation\nurl_patterns: ['^https://allowed[.]test/page$']\n",
    );
    const registry = loadRegistry({ officialDir: official, localDir: local });
    const unrelated = "https://other.test/not-eligible";
    expect(registry.pageKindMatches(unrelated)).toEqual([]);
    expect(selectPreset(unrelated, registry, { preset: "named" })?.name).toBe("named");
  });
  test("unknown fields and invalid mode fields block publication", () => {
    const official = directory();
    writePreset(
      official,
      "bad",
      "name: bad\nsummary: no\ndomain: bad.test\nmode: content\nselector: body\nbogus: true\n",
    );
    try {
      loadRegistry({ officialDir: official, localDir: join(official, "absent") });
      throw new Error("registry unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(PresetConfigError);
      expect((error as PresetConfigError).problems.join(" ")).toContain("unknown keys: bogus");
      expect((error as PresetConfigError).problems.join(" ")).toContain("not valid for mode");
    }
  });
  test("malformed regex and unresolved content references are aggregated", () => {
    const official = directory();
    writePreset(
      official,
      "bad",
      "name: bad\nsummary: no\ndomain: bad.test\nmode: content\nhandler: no.no\nschema: NoSchema\nurl_patterns: ['(bad']\n",
    );
    expect(() => loadRegistry({ officialDir: official, localDir: join(official, "none") })).toThrow(
      PresetConfigError,
    );
  });
  test("single-file validation reports strict errors", () => {
    const root = directory();
    const path = join(root, "bad.yaml");
    writeFileSync(path, "name: bad\nsummary: x\ndomain: x.test\nmode: links\n");
    expect(validatePresetFile(path)).toContain("links mode requires 'selector'");
  });
  test("rejects malformed preset selector syntax at publication time", () => {
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "bad-selector",
      "name: bad-selector\nsummary: Invalid CSS\ndomain: docs.test\nmode: links\nselector: '['\n",
    );
    expect(validatePresetFile(join(local, "bad-selector.yaml")).join(" ")).toContain(
      "not valid CSS",
    );
    expect(() => loadRegistry({ officialDir: official, localDir: local })).toThrow(
      PresetConfigError,
    );
  });
  test("strictly normalizes and freezes custom capabilities", () => {
    class CapabilityPage extends ScrapeSchema {
      toMarkdown(): string {
        return "# Capabilities";
      }
    }
    const handler = async () => {
      const structured = new CapabilityPage();
      return {
        full_html: "",
        selected_html: "",
        markdown: structured.toMarkdown(),
        structured,
      };
    };
    for (const capabilities of [null, { browser: "yes" }, { links: 1 }, { timelineOptions: true }])
      expect(() =>
        registerContentHandler({
          handlerName: "capabilities.invalid",
          schemaName: "InvalidCapabilityPage",
          handler,
          schema: CapabilityPage,
          capabilities: capabilities as never,
        }),
      ).toThrow(PresetConfigError);

    const unregisterDefault = registerContentHandler({
      handlerName: "capabilities.default",
      schemaName: "DefaultCapabilityPage",
      handler,
      schema: CapabilityPage,
    });
    const defaultDefinition = resolveExtractorDefinition(
      "capabilities.default",
      "DefaultCapabilityPage",
    )!;
    expect(defaultDefinition.capabilities).toEqual({
      browser: false,
      markdown: true,
      links: false,
      timelineOptions: false,
      xRole: null,
    });
    expect(Object.isFrozen(defaultDefinition)).toBeTrue();
    expect(Object.isFrozen(defaultDefinition.capabilities)).toBeTrue();
    expect(Object.isFrozen(defaultDefinition.implementationIdentity)).toBeTrue();
    expect(schemaNames()).toContain("DefaultCapabilityPage");
    unregisterDefault();
    unregisterDefault();
    expect(resolveExtractorDefinition("capabilities.default", "DefaultCapabilityPage")).toBeNull();
    expect(schemaNames()).not.toContain("DefaultCapabilityPage");

    expect(() =>
      registerContentHandler({
        handlerName: "x.scrape_tweet",
        schemaName: "BuiltinCollisionPage",
        handler,
        schema: CapabilityPage,
      }),
    ).toThrow("content handler 'x.scrape_tweet' is already registered");
    expect(() =>
      registerContentHandler({
        handlerName: "capabilities.builtin-schema",
        schemaName: "XArticle",
        handler,
        schema: CapabilityPage,
      }),
    ).toThrow("content schema 'XArticle' is already registered");

    const supplied = { browser: true, links: true };
    const unregisterOptIn = registerContentHandler({
      handlerName: "capabilities.opt-in",
      schemaName: "OptInCapabilityPage",
      handler,
      schema: CapabilityPage,
      capabilities: supplied,
    });
    supplied.browser = false;
    supplied.links = false;
    const optIn = resolveExtractorDefinition("capabilities.opt-in", "OptInCapabilityPage")!;
    expect(optIn.capabilities).toEqual({
      browser: true,
      markdown: true,
      links: true,
      timelineOptions: false,
      xRole: null,
    });
    expect(Reflect.set(optIn.capabilities, "browser", false)).toBeFalse();
    expect(optIn.capabilities.browser).toBeTrue();
    expect(() =>
      registerContentHandler({
        handlerName: "capabilities.opt-in",
        schemaName: "OtherCapabilityPage",
        handler,
        schema: CapabilityPage,
      }),
    ).toThrow("content handler 'capabilities.opt-in' is already registered");
    expect(() =>
      registerContentHandler({
        handlerName: "capabilities.other",
        schemaName: "OptInCapabilityPage",
        handler,
        schema: CapabilityPage,
      }),
    ).toThrow("content schema 'OptInCapabilityPage' is already registered");
    unregisterOptIn();
  });
  test("explicit TypeScript registration safely binds a custom handler and schema", async () => {
    class CustomPage extends ScrapeSchema {
      constructor(public content: string) {
        super();
      }
      toMarkdown(): string {
        return this.content;
      }
    }
    const handler = async () => {
      const structured = new CustomPage("# Registered");
      return {
        full_html: "<h1>Registered</h1>",
        selected_html: "<h1>Registered</h1>",
        markdown: structured.toMarkdown(),
        structured,
      };
    };
    const unregister = registerContentHandler({
      handlerName: "custom.registered",
      schemaName: "CustomPage",
      handler,
      schema: CustomPage,
    });
    const official = directory();
    const local = directory();
    writePreset(
      local,
      "custom",
      "name: custom\nsummary: Registered content\ndomain: custom.test\nmode: content\nhandler: custom.registered\nschema: CustomPage\nurl_patterns: ['^https://custom\\.test/page$']\n",
    );
    const registry = loadRegistry({ officialDir: official, localDir: local });
    const preset = registry.byName("custom")!;
    try {
      const result = await scrapeWithPreset("https://custom.test/page", preset);
      expect(result.markdown).toBe("# Registered");
      expect(() => validateContentResult(result, preset)).not.toThrow();
      expect(() =>
        registerContentHandler({
          handlerName: "custom.registered",
          schemaName: "OtherCustomPage",
          handler,
          schema: CustomPage,
        }),
      ).toThrow("already registered");
    } finally {
      unregister();
    }
    await expect(scrapeWithPreset("https://custom.test/page", preset)).rejects.toThrow(
      "Preset 'custom' has no resolvable handler",
    );
    try {
      loadRegistry({ officialDir: official, localDir: local });
      throw new Error("unregistered content preset unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(PresetConfigError);
      expect((error as PresetConfigError).problems.join(" ")).toContain(
        "CLI does not load local executable code",
      );
    }
  });
});

describe("content output contract", () => {
  const preset = loadRegistry().byName("x-tweet")!;
  const schema = new TweetThread({
    author_name: "A",
    author_handle: "a",
    tweets: [new TweetContent({ text: "hello" })],
  });
  const valid = () => ({
    full_html: "<html></html>",
    selected_html: "",
    markdown: schema.toMarkdown(),
    structured: schema,
  });
  test("accepts the declared schema and canonical renderer", () => {
    expect(() => validateContentResult(valid(), preset)).not.toThrow();
  });
  test("rejects missing artifact fields", () => {
    expect(() => validateContentResult({ markdown: "x", structured: schema }, preset)).toThrow(
      PresetOutputError,
    );
  });
  test("rejects wrong structured type", () => {
    const result = valid();
    const generic = new GenericPage("https://x.com", "hello");
    expect(() =>
      validateContentResult(
        { ...result, structured: generic, markdown: generic.toMarkdown() },
        preset,
      ),
    ).toThrow("expected TweetThread");
  });
  test("rejects empty and divergent Markdown", () => {
    expect(() => validateContentResult({ ...valid(), markdown: " " }, preset)).toThrow(
      "empty markdown",
    );
    expect(() => validateContentResult({ ...valid(), markdown: "different" }, preset)).toThrow(
      "diverges",
    );
  });
});

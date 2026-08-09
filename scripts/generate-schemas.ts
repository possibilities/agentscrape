#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_VERSION, FAILURE_TYPES } from "../src/corpus";
import {
  COMMON,
  MODE_FIELDS,
  PRESET_MODES,
  type PresetMode,
  REQUIRED_FIELDS,
  STRING_FIELDS,
} from "../src/presets";

const DRAFT = "http://json-schema.org/draft-07/schema#";
const ANCHORED_PATTERN = "^\\^[\\s\\S]*\\$$";

// Every field the preset validator knows, in the order it composes them.
const PRESET_FIELDS = [
  ...new Set([...COMMON, ...Object.values(MODE_FIELDS).flatMap((set) => [...set])]),
];

// Which of a mode's fields the validator demands rather than merely permits. The permitted set
// lives in MODE_FIELDS; this split exists only inside problems() in src/presets.ts.
const MODE_REQUIRED: Record<PresetMode, string[]> = {
  content: ["handler", "schema"],
  links: ["selector"],
  "nav-links": ["section_selector", "category_selector"],
};

const PRESET_DESCRIPTIONS: Record<string, string> = {
  name: "Registry identity for this preset. `--preset NAME` selects it, and the name must be unique among the official presets and among the local `scrapers/` presets.",
  summary: "One-line description of what the preset extracts, shown by `list-presets`.",
  domain:
    'Host this preset claims, or "*" to match any host. Declaring a domain claims the entire host: a URL on it that matches no preset fails rather than falling back to generic extraction.',
  mode: "Extraction strategy. `content` runs a registered handler, `links` collects anchors under one selector, and `nav-links` walks a two-level navigation.",
  aliases:
    "Further hosts claimed on the same terms as `domain`, such as twitter.com alongside x.com.",
  browser_profile:
    "Browser profile the scrape runs under when the caller supplies none, for pages that need a signed-in session.",
  url_patterns:
    "JavaScript regular expressions matched against the canonicalized URL. Each must carry a visible `^` start anchor and `$` end anchor, and no two presets may declare the same pattern.",
  handler:
    "Registered content extractor to run, named `module.function`. The CLI never loads local executable code, so the handler must already be registered through the package API.",
  schema:
    "Name of the ScrapeSchema class the handler returns. It must be registered together with `handler`.",
  selector: "CSS selector for the anchors to collect.",
  section_selector: "CSS selector for the top-level section links to visit.",
  category_selector: "CSS selector for the links to collect on each section page that was visited.",
  toggle_selector:
    "CSS selector for expander controls to click before links are collected, such as collapsed navigation sections.",
};

function describe(descriptions: Record<string, string>, field: string): string {
  const description = descriptions[field];
  if (!description) throw new Error(`no schema description for field '${field}'`);
  return description;
}

function presetProperty(field: string): Record<string, unknown> {
  const description = describe(PRESET_DESCRIPTIONS, field);
  if (field === "mode") return { type: "string", enum: [...PRESET_MODES], description };
  if (STRING_FIELDS.has(field)) return { type: "string", description };
  // The validator's only non-string fields are its two lists of strings.
  const items =
    field === "url_patterns"
      ? { type: "string", pattern: ANCHORED_PATTERN }
      : { type: "string" as const };
  return { type: "array", items, description };
}

function presetSchema(): Record<string, unknown> {
  return {
    $schema: DRAFT,
    title: "Agentscrape preset",
    description:
      "A preset in `config/presets/` or a project's `scrapers/` directory: the routing rule and extraction strategy for one kind of page.",
    type: "object",
    required: [...REQUIRED_FIELDS],
    additionalProperties: false,
    properties: {
      $schema: {
        type: "string",
        description: "Path to this schema, for editor completion. The preset loader ignores it.",
      },
      ...Object.fromEntries(PRESET_FIELDS.map((field) => [field, presetProperty(field)])),
    },
    allOf: PRESET_MODES.map((mode) => {
      const applicable = new Set([...COMMON, ...MODE_FIELDS[mode]]);
      const forbidden = PRESET_FIELDS.filter((field) => !applicable.has(field));
      return {
        if: { properties: { mode: { const: mode } }, required: ["mode"] },
        // biome-ignore lint/suspicious/noThenProperty: draft-07 names this conditional keyword.
        then: {
          required: MODE_REQUIRED[mode],
          properties: Object.fromEntries(forbidden.map((field) => [field, false])),
        },
      };
    }),
  };
}

function canariesSchema(): Record<string, unknown> {
  return {
    $schema: DRAFT,
    title: "Agentscrape preset canaries",
    description:
      "Public URLs and semantic invariants for `agentscrape check-presets --live`. A canary URL is published with the repository, so it must be a durable public resource rather than a page the operator happens to have open. Presets with nothing that qualifies carry no canary; check-presets only probes what is listed here.",
    type: "object",
    properties: {
      $schema: {
        type: "string",
        description: "Path to this schema, for editor completion. The canary loader ignores it.",
      },
    },
    additionalProperties: {
      type: "object",
      description:
        "Canary for the preset named by this key. A preset with no canary is reported as `not_configured` rather than probed.",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description:
            "Durable public page to scrape with the preset. Omitting it reports the preset as `not_configured`.",
        },
        invariants: {
          type: "object",
          description:
            "Semantic floors the live result must clear. A result that parses but falls short is reported as drift, not as an operational failure.",
          properties: {
            min_markdown_chars: {
              type: "integer",
              minimum: 1,
              description: "Shortest acceptable rendered markdown, in characters.",
            },
            require_title: {
              type: "boolean",
              description:
                "When true, the structured result's `title` must be present and nonblank.",
            },
            min_rounds: {
              type: "integer",
              minimum: 1,
              description: "Fewest acceptable entries in the structured result's `rounds` list.",
            },
            min_citations: {
              type: "integer",
              minimum: 1,
              description: "Fewest acceptable entries in the structured result's `citations` list.",
            },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  };
}

function corpusMetaSchema(): Record<string, unknown> {
  return {
    $schema: DRAFT,
    title: "Agentscrape corpus sample metadata",
    description:
      "The `meta.json` beside a captured sample under `test/corpus/`: what the sample was captured from and what replaying it must produce.",
    type: "object",
    required: ["version", "preset", "mode", "url", "expect"],
    additionalProperties: true,
    properties: {
      version: {
        const: CORPUS_VERSION,
        description:
          "Sample contract version. A sample declaring any other version is rejected rather than replayed.",
      },
      preset: {
        type: "string",
        description:
          "Preset that captured the sample. It must match the corpus directory the sample lives in.",
      },
      mode: {
        type: "string",
        enum: [...PRESET_MODES],
        description: "Extraction mode to replay. It must match the preset's mode in the registry.",
      },
      url: {
        type: "string",
        description: "Redacted URL the sample was captured from, replayed as the request URL.",
      },
      expect: {
        type: "string",
        enum: ["success", "failure"],
        description:
          "Whether replay must succeed and match the recorded output, or must raise the recorded failure.",
      },
      structured: {
        description:
          "Structured payload the content-mode handler must return, compared as deeply equal. Absent means the payload is not asserted.",
      },
      links: {
        type: "array",
        description:
          "Links the `links` or `nav-links` replay must return, compared as deeply equal. Required for a successful sample in either mode.",
      },
      failure: {
        type: "object",
        description: "Failure a sample with `expect: failure` must raise.",
        properties: {
          type: {
            type: "string",
            enum: Object.keys(FAILURE_TYPES),
            description: "Error class the replay must throw, matched with `instanceof`.",
          },
          contains: {
            type: "string",
            description: "Substring the thrown error's message must contain.",
          },
          message_captured: {
            type: "string",
            description:
              "Redacted message recorded when the sample was captured. It documents the capture and is not asserted.",
          },
        },
      },
      assertions: {
        type: "object",
        description: "Substring checks against the markdown a successful replay renders.",
        properties: {
          contains: {
            type: "array",
            items: { type: "string" },
            description: "Substrings the rendered markdown must contain.",
          },
          not_contains: {
            type: "array",
            items: { type: "string" },
            description: "Substrings the rendered markdown must not contain.",
          },
        },
      },
      category_pages: {
        type: "array",
        description:
          "Captured second-level pages for a `nav-links` replay, one per section link followed.",
        items: {
          type: "object",
          required: ["section_url", "page"],
          properties: {
            section_url: {
              type: "string",
              description: "Section link whose page this fixture stands in for.",
            },
            page: {
              type: "string",
              description: "Filename of the captured page, relative to the sample directory.",
            },
          },
        },
      },
    },
  };
}

export function buildSchemas(): Record<string, Record<string, unknown>> {
  return {
    "preset.schema.json": presetSchema(),
    "preset-canaries.schema.json": canariesSchema(),
    "corpus-meta.schema.json": corpusMetaSchema(),
  };
}

if (import.meta.main) {
  const directory = join(import.meta.dir, "../config");
  const paths = Object.entries(buildSchemas()).map(([name, schema]) => {
    const path = join(directory, name);
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
    return path;
  });
  // Generated JSON has to land in the repo's own formatting or `bun run check` rejects it.
  const formatter = Bun.spawnSync(
    [join(import.meta.dir, "../node_modules/.bin/biome"), "format", "--write", ...paths],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (formatter.exitCode !== 0) process.exit(1);
  for (const path of paths) console.log(path);
}

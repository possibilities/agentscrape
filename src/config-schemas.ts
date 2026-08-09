/**
 * The three user-editable config surfaces as zod schemas — the single source of
 * truth. The loaders validate with these at load, and
 * `scripts/generate-schemas.ts` emits the three `config/*.schema.json` files
 * from them, so a config key exists exactly when it is declared (and described)
 * here. `test/schemas.test.ts` fails when a checked-in schema drifts.
 *
 * Contract:
 * - Parse behavior mirrors the historical hand-rolled validators exactly. In
 *   particular a preset field that expects a string has always tolerated null,
 *   so those fields parse as string-or-null while the published schema keeps
 *   documenting plain strings (the generator flattens the null branch away,
 *   preserving the schema the fleet has always published).
 * - Checks the loaders enforce later than parse — handler/schema registration,
 *   CSS selector syntax, regex compilability, per-mode requires, canary entry
 *   shapes, corpus replay contracts — stay in loader code or ride along as
 *   `.meta()` annotations. Meta keys pass through to the emitted JSON Schema
 *   verbatim and never touch parsing.
 * - `$schema` appears only in published-file schemas; every loader tolerates
 *   the key whatever its value ($schema is stripped or passed through, never
 *   validated).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Presets — config/presets/*.json and a project's scrapers/*.json
// ---------------------------------------------------------------------------

export const PRESET_MODES = ["content", "links", "nav-links"] as const;
export type PresetMode = (typeof PRESET_MODES)[number];

/** Fields whose absence is a problem on its own; everything else is per-mode. */
export const REQUIRED_FIELDS = ["name", "summary", "domain", "mode"] as const;
/** Fields every mode accepts. */
export const COMMON = new Set(["name", "summary", "domain", "mode", "aliases", "browser_profile"]);
/** Fields each mode additionally accepts. */
export const MODE_FIELDS: Record<PresetMode, Set<string>> = {
  content: new Set(["url_patterns", "handler", "schema"]),
  links: new Set(["selector", "toggle_selector"]),
  "nav-links": new Set(["section_selector", "category_selector", "toggle_selector"]),
};
// Which of a mode's fields the validator demands rather than merely permits. The permitted set
// lives in MODE_FIELDS; this split exists only inside problems() in src/presets.ts.
export const MODE_REQUIRED: Record<PresetMode, string[]> = {
  content: ["handler", "schema"],
  links: ["selector"],
  "nav-links": ["section_selector", "category_selector"],
};

/** Every url_pattern must carry a visible start and end anchor. */
export const ANCHORED_PATTERN = "^\\^[\\s\\S]*\\$$";
const anchoredRegExp = new RegExp(ANCHORED_PATTERN);

/**
 * The preset validator has always let null stand wherever a string is
 * expected (an unset-by-null field falls out in toConfig); the published
 * schema keeps documenting `type: "string"`, so the generator flattens the
 * null branch back out of the emitted node.
 */
const stringField = (description: string) => z.string().nullable().describe(description);

const presetShape = {
  name: stringField(
    "Registry identity for this preset. `--preset NAME` selects it, and the name must be unique among the official presets and among the local `scrapers/` presets.",
  ),
  summary: stringField(
    "One-line description of what the preset extracts, shown by `list-presets`.",
  ),
  domain: stringField(
    'Host this preset claims, or "*" to match any host. Declaring a domain claims the entire host: a URL on it that matches no preset fails rather than falling back to generic extraction.',
  ),
  mode: z
    .enum(PRESET_MODES)
    .nullable()
    .describe(
      "Extraction strategy. `content` runs a registered handler, `links` collects anchors under one selector, and `nav-links` walks a two-level navigation.",
    ),
  aliases: z
    .array(z.string())
    .describe(
      "Further hosts claimed on the same terms as `domain`, such as twitter.com alongside x.com.",
    )
    .optional(),
  browser_profile: stringField(
    "Browser profile the scrape runs under when the caller supplies none, for pages that need a signed-in session.",
  ).optional(),
  url_patterns: z
    .array(z.string().regex(anchoredRegExp))
    .describe(
      "JavaScript regular expressions matched against the canonicalized URL. Each must carry a visible `^` start anchor and `$` end anchor, and no two presets may declare the same pattern.",
    )
    .optional(),
  handler: stringField(
    "Registered content extractor to run, named `module.function`. The CLI never loads local executable code, so the handler must already be registered through the package API.",
  ).optional(),
  schema: stringField(
    "Name of the ScrapeSchema class the handler returns. It must be registered together with `handler`.",
  ).optional(),
  selector: stringField("CSS selector for the anchors to collect.").optional(),
  toggle_selector: stringField(
    "CSS selector for expander controls to click before links are collected, such as collapsed navigation sections.",
  ).optional(),
  section_selector: stringField(
    "CSS selector for the top-level section links to visit.",
  ).optional(),
  category_selector: stringField(
    "CSS selector for the links to collect on each section page that was visited.",
  ).optional(),
};

/** Every field the preset validator knows, in the order it composes them. */
export const PRESET_FIELD_NAMES: ReadonlyArray<string> = Object.keys(presetShape);

/**
 * The per-mode conditionals the published schema documents. Applicability and
 * the per-mode requires are enforced by problems() in src/presets.ts from the
 * same COMMON/MODE_FIELDS/MODE_REQUIRED constants; they ride here as meta so
 * the emitted schema states them without changing parse behavior.
 */
const presetConditionals = PRESET_MODES.map((mode) => {
  const applicable = new Set([...COMMON, ...MODE_FIELDS[mode]]);
  const forbidden = PRESET_FIELD_NAMES.filter((field) => !applicable.has(field));
  return {
    if: { properties: { mode: { const: mode } }, required: ["mode"] },
    // biome-ignore lint/suspicious/noThenProperty: draft-07 names this conditional keyword.
    then: {
      required: MODE_REQUIRED[mode],
      properties: Object.fromEntries(forbidden.map((field) => [field, false])),
    },
  };
});

/** What problems() validates: one preset file with `$schema` already stripped. */
export const presetValuesSchema = z.strictObject(presetShape);

/**
 * What `preset.schema.json` documents: the same surface plus the `$schema`
 * pointer a preset file may carry for editor tooling.
 */
export const presetFileSchema = z
  .strictObject({
    $schema: z
      .string()
      .describe("Path to this schema, for editor completion. The preset loader ignores it.")
      .optional(),
    ...presetShape,
  })
  .meta({ allOf: presetConditionals });

// ---------------------------------------------------------------------------
// Preset canaries — config/preset-canaries.json
// ---------------------------------------------------------------------------

export const canaryInvariantsSchema = z
  .looseObject({
    min_markdown_chars: z
      .int()
      .min(1)
      .describe("Shortest acceptable rendered markdown, in characters.")
      .optional(),
    require_title: z
      .boolean()
      .describe("When true, the structured result's `title` must be present and nonblank.")
      .optional(),
    min_rounds: z
      .int()
      .min(1)
      .describe("Fewest acceptable entries in the structured result's `rounds` list.")
      .optional(),
    min_citations: z
      .int()
      .min(1)
      .describe("Fewest acceptable entries in the structured result's `citations` list.")
      .optional(),
  })
  .describe(
    "Semantic floors the live result must clear. A result that parses but falls short is reported as drift, not as an operational failure.",
  );

export const canaryEntrySchema = z
  .looseObject({
    url: z
      .string()
      .meta({
        format: "uri",
        description:
          "Durable public page to scrape with the preset. Omitting it reports the preset as `not_configured`.",
      })
      .optional(),
    invariants: canaryInvariantsSchema.optional(),
  })
  .describe(
    "Canary for the preset named by this key. A preset with no canary is reported as `not_configured` rather than probed.",
  );

/**
 * What `preset-canaries.schema.json` documents: the `$schema` pointer plus one
 * canary entry per preset name.
 */
export const canariesFileSchema = z
  .object({
    $schema: z
      .string()
      .describe("Path to this schema, for editor completion. The canary loader ignores it.")
      .optional(),
  })
  .catchall(canaryEntrySchema);

/**
 * What checkPresets() validates at load: any JSON object keyed by preset name.
 * Entry shapes are deliberately not parse-enforced — check-presets has always
 * degraded a malformed entry to a per-preset `not_configured` or operational
 * result instead of refusing to run, so the entry structure above is editor
 * documentation of the same contract, not a load gate.
 */
export const canariesValuesSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Corpus sample metadata — meta.json under test/corpus/ and captured overlays
// ---------------------------------------------------------------------------

/** A sample declaring any other version is rejected rather than replayed. */
export const CORPUS_META_VERSION = 1;

/**
 * Names accepted by `failure.type`, mirrored by FAILURE_TYPES in src/corpus.ts
 * (which maps them onto error classes); the generator refuses to emit if the
 * two ever disagree.
 */
export const CORPUS_FAILURE_TYPE_NAMES = [
  "AgentscrapeAuthError",
  "AgentscrapeError",
  "AgentscrapeUpstreamDownError",
  "PresetConfigError",
  "PresetDriftError",
  "PresetOutputError",
  "PresetSelectionError",
  "Error",
  "TypeError",
  "RangeError",
  "ValueError",
  "RuntimeError",
] as const;

/**
 * Present with any value: loadMeta has always demanded these keys exist while
 * judging their values only later (byName lookup, replay). The meta carries
 * the documented type for editors without tightening the parse.
 */
const presentWhateverTheValue = (meta: Record<string, unknown>) =>
  z.custom<unknown>((value) => value !== undefined).meta(meta);

/**
 * The deeper `failure`, `assertions`, and `category_pages` structures document
 * the replay-time contract (verifyFailure and runSample enforce them per
 * sample); loadMeta deliberately does not judge them, so they ride as meta
 * annotations on permissive fields rather than parse types.
 */
export const corpusMetaSchema = z.looseObject({
  version: z
    .literal(CORPUS_META_VERSION)
    .describe(
      "Sample contract version. A sample declaring any other version is rejected rather than replayed.",
    ),
  preset: presentWhateverTheValue({
    type: "string",
    description:
      "Preset that captured the sample. It must match the corpus directory the sample lives in.",
  }),
  mode: z
    .enum(PRESET_MODES)
    .describe("Extraction mode to replay. It must match the preset's mode in the registry."),
  url: presentWhateverTheValue({
    type: "string",
    description: "Redacted URL the sample was captured from, replayed as the request URL.",
  }),
  expect: z
    .enum(["success", "failure"])
    .describe(
      "Whether replay must succeed and match the recorded output, or must raise the recorded failure.",
    ),
  structured: z
    .unknown()
    .meta({
      description:
        "Structured payload the content-mode handler must return, compared as deeply equal. Absent means the payload is not asserted.",
    })
    .optional(),
  links: z
    .unknown()
    .meta({
      type: "array",
      description:
        "Links the `links` or `nav-links` replay must return, compared as deeply equal. Required for a successful sample in either mode.",
    })
    .optional(),
  failure: z
    .unknown()
    .meta({
      type: "object",
      description: "Failure a sample with `expect: failure` must raise.",
      properties: {
        type: {
          type: "string",
          enum: [...CORPUS_FAILURE_TYPE_NAMES],
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
    })
    .optional(),
  assertions: z
    .unknown()
    .meta({
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
    })
    .optional(),
  category_pages: z
    .unknown()
    .meta({
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
    })
    .optional(),
});

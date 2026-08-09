#!/usr/bin/env bun
// Emits the three config/*.schema.json files from the zod schemas in
// src/config-schemas.ts — the same schemas the loaders validate with, so the
// published files cannot drift from what the CLI accepts. Regenerate with
// `bun run generate:schemas`; test/schemas.test.ts fails when a checked-in
// file drifts from this source.
//
// Every rewrite below is assert-then-rewrite: it demands the exact vacuous
// zod emission it flattens and throws otherwise, so a real constraint can
// never be silently erased to keep the published bytes stable.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ANCHORED_PATTERN,
  CORPUS_FAILURE_TYPE_NAMES,
  canariesFileSchema,
  corpusMetaSchema,
  presetFileSchema,
} from "../src/config-schemas";
import { FAILURE_TYPES } from "../src/corpus";

const DRAFT = "http://json-schema.org/draft-07/schema#";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The "input" io mode is deliberate: these schemas describe what a human may
 * write on disk, where every optional field is omittable. The default "output"
 * mode would mark defaulted fields required. `unrepresentable: "any"` admits
 * the z.custom presence-only fields of the corpus meta schema, whose emitted
 * node is entirely their meta annotation.
 */
function emit(schema: z.ZodType, options: { unrepresentable?: "any" } = {}): Schema {
  const generated = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    ...options,
  }) as Schema;
  if (generated.$schema !== DRAFT)
    throw new Error(`zod emitted an unexpected dialect: ${String(generated.$schema)}`);
  return generated;
}

function properties(node: unknown, name: string): Schema {
  if (!isObject(node)) throw new Error(`schema node "${name}" is not an object`);
  const props = node.properties;
  if (!isObject(props)) throw new Error(`schema node "${name}" has no properties`);
  return props;
}

/**
 * The preset loader tolerates null wherever a string is expected (problems()
 * has always let it through), so those fields parse as string-or-null; the
 * published schema keeps its historical claim of plain strings. Refuses to
 * flatten anything but that exact union — `mode` keeps its enum members.
 */
function flattenNullTolerant(props: Schema, field: string): void {
  const node = props[field];
  const complaint = `preset field "${field}" is no longer the string-or-null union`;
  if (!isObject(node) || !Array.isArray(node.anyOf) || node.anyOf.length !== 2)
    throw new Error(complaint);
  const [text, nullBranch] = node.anyOf as [unknown, unknown];
  if (!isObject(text) || !isObject(nullBranch)) throw new Error(complaint);
  if (nullBranch.type !== "null" || Object.keys(nullBranch).length !== 1)
    throw new Error(complaint);
  const { anyOf: _branches, ...annotations } = node;
  if (text.type === "string" && Object.keys(text).length === 1) {
    props[field] = { type: "string", ...annotations };
    return;
  }
  if (text.type === "string" && Array.isArray(text.enum) && Object.keys(text).length === 2) {
    props[field] = { type: "string", enum: text.enum, ...annotations };
    return;
  }
  throw new Error(complaint);
}

/** Openness: zod says `additionalProperties: {}`, the published files say `true`. */
function openTrue(node: Schema, name: string): void {
  const additional = node.additionalProperties;
  const open =
    additional === true || (isObject(additional) && Object.keys(additional).length === 0);
  if (!open) throw new Error(`"${name}" additionalProperties grew a real constraint; keep it`);
  node.additionalProperties = true;
}

/** z.int() emits a vacuous MAX_SAFE_INTEGER ceiling; the published schema never had one. */
function dropVacuousIntegerCeiling(props: Schema, name: string, field: string): void {
  const node = props[field];
  if (!isObject(node) || node.type !== "integer")
    throw new Error(`"${name}.${field}" is no longer an integer schema`);
  const { maximum, ...rest } = node;
  if (maximum !== Number.MAX_SAFE_INTEGER)
    throw new Error(`"${name}.${field}" maximum is a real constraint; keep it`);
  props[field] = rest;
}

/** Cosmetic: the published nodes put description right after type. */
function hoistDescription(node: Schema, name: string): Schema {
  const { type, description, ...rest } = node;
  if (typeof description !== "string") throw new Error(`schema node "${name}" has no description`);
  return { type, description, ...rest };
}

/** The schema is the config surface's documentation; every key must carry it. */
function assertDocumented(props: Schema, section: string): void {
  for (const [key, value] of Object.entries(props)) {
    const description = isObject(value) ? value.description : undefined;
    if (typeof description !== "string" || description.length === 0)
      throw new Error(`schema property "${section}${key}" has no description`);
  }
}

function presetJsonSchema(): Schema {
  const generated = emit(presetFileSchema);
  const props = properties(generated, "preset");
  for (const field of [
    "name",
    "summary",
    "domain",
    "mode",
    "browser_profile",
    "handler",
    "schema",
    "selector",
    "toggle_selector",
    "section_selector",
    "category_selector",
  ])
    flattenNullTolerant(props, field);
  const patterns = props.url_patterns;
  if (
    !isObject(patterns) ||
    !isObject(patterns.items) ||
    patterns.items.pattern !== ANCHORED_PATTERN
  )
    throw new Error("preset url_patterns no longer documents anchored string items");
  if (generated.additionalProperties !== false)
    throw new Error("the preset schema is no longer strict");
  if (!Array.isArray(generated.required) || !Array.isArray(generated.allOf))
    throw new Error("the preset schema lost its required list or mode conditionals");
  assertDocumented(props, "");
  return {
    $schema: DRAFT,
    title: "Agentscrape preset",
    description:
      "A preset in `config/presets/` or a project's `scrapers/` directory: the routing rule and extraction strategy for one kind of page.",
    type: "object",
    required: generated.required,
    additionalProperties: false,
    properties: props,
    allOf: generated.allOf,
  };
}

function canariesJsonSchema(): Schema {
  const generated = emit(canariesFileSchema);
  const props = properties(generated, "canaries");
  const entry = generated.additionalProperties;
  if (!isObject(entry) || entry.type !== "object")
    throw new Error("the canary entry is no longer an object schema");
  const entryProps = properties(entry, "canary entry");
  const invariants = entryProps.invariants;
  if (!isObject(invariants)) throw new Error("the canary invariants node is missing");
  const invariantProps = properties(invariants, "canary invariants");
  for (const field of ["min_markdown_chars", "min_rounds", "min_citations"])
    dropVacuousIntegerCeiling(invariantProps, "invariants", field);
  openTrue(invariants, "canary invariants");
  entryProps.invariants = hoistDescription(invariants, "canary invariants");
  openTrue(entry, "canary entry");
  const publishedEntry = hoistDescription(entry, "canary entry");
  assertDocumented(props, "");
  assertDocumented(entryProps, "entry.");
  assertDocumented(invariantProps, "entry.invariants.");
  return {
    $schema: DRAFT,
    title: "Agentscrape preset canaries",
    description:
      "Public URLs and semantic invariants for `agentscrape check-presets --live`. A canary URL is published with the repository, so it must be a durable public resource rather than a page the operator happens to have open. Presets with nothing that qualifies carry no canary; check-presets only probes what is listed here.",
    type: "object",
    properties: props,
    additionalProperties: publishedEntry,
  };
}

function corpusMetaJsonSchema(): Schema {
  if (JSON.stringify(Object.keys(FAILURE_TYPES)) !== JSON.stringify([...CORPUS_FAILURE_TYPE_NAMES]))
    throw new Error(
      "FAILURE_TYPES and CORPUS_FAILURE_TYPE_NAMES disagree; realign src/corpus.ts with src/config-schemas.ts",
    );
  const generated = emit(corpusMetaSchema, { unrepresentable: "any" });
  const props = properties(generated, "corpus meta");
  const version = props.version;
  if (!isObject(version) || version.type !== "number" || version.const !== 1)
    throw new Error("the corpus meta version is no longer the literal 1");
  const { type: _numeric, ...bareConst } = version;
  props.version = bareConst;
  openTrue(generated, "corpus meta");
  if (!Array.isArray(generated.required))
    throw new Error("the corpus meta schema lost its required list");
  assertDocumented(props, "");
  return {
    $schema: DRAFT,
    title: "Agentscrape corpus sample metadata",
    description:
      "The `meta.json` beside a captured sample under `test/corpus/`: what the sample was captured from and what replaying it must produce.",
    type: "object",
    required: generated.required,
    additionalProperties: true,
    properties: props,
  };
}

export function buildSchemas(): Record<string, Record<string, unknown>> {
  return {
    "preset.schema.json": presetJsonSchema(),
    "preset-canaries.schema.json": canariesJsonSchema(),
    "corpus-meta.schema.json": corpusMetaJsonSchema(),
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

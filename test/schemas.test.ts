import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchemas } from "../scripts/generate-schemas.ts";

const config = join(import.meta.dir, "../config");

describe("generated JSON schemas", () => {
  test("every schema under config/ matches the generator", () => {
    const schemas = buildSchemas();
    expect(Object.keys(schemas)).toEqual([
      "preset.schema.json",
      "preset-canaries.schema.json",
      "corpus-meta.schema.json",
    ]);
    for (const [name, schema] of Object.entries(schemas)) {
      const checkedIn = JSON.parse(readFileSync(join(config, name), "utf8"));
      expect(checkedIn, `${name} is stale; run bun run generate:schemas`).toEqual(schema);
    }
  });
  test("the shipped config files point at their schema", () => {
    const preset = JSON.parse(readFileSync(join(config, "presets/x-tweet.json"), "utf8"));
    expect(preset.$schema).toBe("../preset.schema.json");
    const canaries = JSON.parse(readFileSync(join(config, "preset-canaries.json"), "utf8"));
    expect(canaries.$schema).toBe("./preset-canaries.schema.json");
  });
});

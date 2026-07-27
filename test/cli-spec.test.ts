import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_SPEC,
  type CliSpec,
  deepFreeze,
  jsonHelp,
  parseArgs,
  parseGlobalOption,
  renderHumanHelp,
  renderJsonHelp,
  validateCliSpec,
} from "../src/cli-spec";
import { AgentscrapeUsageError } from "../src/errors";
import { AGENTSCRAPE_VERSION } from "../src/version";

const visibleInventory = [
  ["fetch-markdown", "Fetch a document and emit Markdown or structured output"],
  ["fetch-links", "Extract navigation links or an account timeline"],
  ["discover-feed", "Discover live or recorded RSS, Atom, or archive entries"],
  ["list-presets", "List extraction presets"],
  ["show-preset", "Show a preset contract"],
  ["validate-preset", "Validate a preset contract"],
  ["capture-corpus", "Capture a versioned content sample"],
  ["test-corpus", "Replay the mode-aware corpus offline"],
  ["check-presets", "Run configured public canaries"],
  ["convert-html", "Convert HTML from a file, directory, or stdin"],
  ["open-session", "Pre-warm a browser session"],
  ["close-session", "Close a browser session"],
  ["process-queue", "Process standalone artifact jobs"],
  ["reconcile-queue", "Inventory or reconcile frozen queue records"],
  ["doctor", "Inspect offline runtime readiness and optional capabilities"],
] as const;

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const nested of Object.values(value)) expectDeepFrozen(nested, seen);
}

function mutableSpec(): any {
  return structuredClone(CLI_SPEC);
}

function expectInvalid(change: (spec: any) => void, message: string): void {
  const spec = mutableSpec();
  change(spec);
  expect(() => validateCliSpec(spec as CliSpec)).toThrow(message);
}

function renderedOptionNames(text: string, heading: "Options:" | "Global options:"): string[] {
  const section = text.split(`${heading}\n`)[1];
  if (!section) throw new Error(`missing ${heading}`);
  return section
    .trimEnd()
    .split("\n")
    .map((line) => line.match(/--[a-z][a-z0-9-]*/)?.[0])
    .filter((name): name is string => name !== undefined);
}

function optionValues(option: (typeof CLI_SPEC.commands)[number]["options"][number]): string[] {
  if (option.kind === "flag") return [];
  if (option.long === "--format") return ["json"];
  if (option.choices) return [option.choices[0]!];
  return option.valueLabels.map((_, index) => `value-${index + 1}`);
}

describe("CLI syntax specification", () => {
  test("uses the package version authority without local production literals", () => {
    expect(CLI_SPEC.version).toBe(AGENTSCRAPE_VERSION);
    for (const file of ["cli-spec.ts", "envelope.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      expect(source, file).not.toMatch(/["']0\.1\.0["']/);
    }
  });

  test("has the exact visible inventory and a hidden-compatible help command", () => {
    expect(CLI_SPEC.commands.map(({ name, summary }) => [name, summary])).toEqual(
      visibleInventory.map(([name, summary]) => [name, summary]),
    );
    expect(CLI_SPEC.hiddenCommands.map(({ name }) => name)).toEqual(["help"]);

    const rootJson = jsonHelp() as {
      commands: Array<{ name: string; description: string }>;
    };
    expect(rootJson.commands.map(({ name, description }) => [name, description])).toEqual(
      visibleInventory.map(([name, description]) => [name, description]),
    );
    expect(rootJson.commands.some(({ name }) => name === "help")).toBeFalse();

    const rootHuman = renderHumanHelp();
    const commandSection = rootHuman.split("Commands:\n")[1]!.split("\n\nGlobal options:")[0]!;
    for (const [name, summary] of visibleInventory) {
      expect(commandSection).toContain(name);
      expect(commandSection).toContain(summary);
    }
    expect(commandSection.split("\n").some((line) => /^\s+help(?:\s|$)/.test(line))).toBeFalse();
  });

  test("is recursively frozen and validates deterministic programmer errors", () => {
    expect(() => validateCliSpec(structuredClone(CLI_SPEC) as CliSpec)).not.toThrow();
    expectDeepFrozen(CLI_SPEC);
    const frozen = deepFreeze({ nested: { values: [1, 2] } });
    expectDeepFrozen(frozen);

    expectInvalid((spec) => {
      spec.commands[1].name = spec.commands[0].name;
    }, "command 'fetch-markdown' collides");
    expectInvalid((spec) => {
      spec.commands[0].options[1].long = spec.commands[0].options[0].long;
    }, "option spelling '--selector' collides");
    expectInvalid((spec) => {
      spec.commands[0].options[0].long = "selector";
    }, "invalid long option 'selector'");
    expectInvalid((spec) => {
      spec.commands[0].options[0].aliases = ["-long"];
    }, "invalid short option '-long'");
    expectInvalid((spec) => {
      spec.commands[0].options.find((option: any) => option.long === "--generic").choices = ["yes"];
    }, "flag --generic must not define choices");
    expectInvalid((spec) => {
      const page = spec.commands
        .find((command: any) => command.name === "discover-feed")
        .options.find((option: any) => option.long === "--page");
      page.valueLabels = ["URL"];
    }, "must contain exactly 2 labels");
    expectInvalid((spec) => {
      spec.commands[0].positionals[0].required = false;
      spec.commands[0].positionals[1].required = true;
    }, "required positionals cannot follow optional positionals");
    expectInvalid((spec) => {
      spec.commands[0].positionals[1].name = "url";
    }, "duplicate positional 'url'");
    expectInvalid((spec) => {
      spec.commands[0].positionals[0].repeatable = true;
    }, "a repeatable positional must be last");
  });

  test("human and JSON inventories match every spec scope in stable order", () => {
    const root = jsonHelp() as { arguments: Array<{ name: string }> };
    expect(root.arguments.map(({ name }) => name)).toEqual(
      CLI_SPEC.globalOptions.map(({ long }) => long),
    );
    expect(renderedOptionNames(renderHumanHelp(), "Global options:")).toEqual(
      CLI_SPEC.globalOptions.map(({ long }) => long),
    );

    for (const command of [...CLI_SPEC.commands, ...CLI_SPEC.hiddenCommands]) {
      const rendered = renderHumanHelp(command.name);
      const machine = jsonHelp(command.name) as {
        arguments: Array<{ name: string; positional?: true }>;
      };
      expect(machine.arguments.map(({ name }) => name)).toEqual([
        ...command.positionals.map(({ name }) => name),
        ...command.options.map(({ long }) => long),
      ]);
      expect(renderedOptionNames(rendered, "Options:")).toEqual(
        command.options.map(({ long }) => long),
      );
      expect(rendered).toStartWith(`Usage: ${CLI_SPEC.name} ${command.name}`);
      for (const positional of command.positionals)
        expect(rendered).toContain(positional.displayName);
    }
  });

  test("every declared command option gets spec-driven acceptance and arity", () => {
    for (const command of [...CLI_SPEC.commands, ...CLI_SPEC.hiddenCommands]) {
      expect(() => parseArgs(command.name, ["--not-declared"])).toThrow(AgentscrapeUsageError);
      for (const option of command.options) {
        const values = optionValues(option);
        const parsed = parseArgs(command.name, [option.long, ...values]);
        if (option.kind === "flag") {
          expect(parsed.flags.has(option.long), `${command.name} ${option.long}`).toBeTrue();
          expect(() => parseArgs(command.name, [`${option.long}=value`])).toThrow(
            `${option.long} does not take a value`,
          );
        } else {
          expect(parsed.values.get(option.long), `${command.name} ${option.long}`).toEqual(values);
          expect(() => parseArgs(command.name, [option.long, ...values.slice(0, -1)])).toThrow(
            `${option.long} requires ${option.valueCount} value`,
          );
          const attached = parseArgs(command.name, [
            `${option.long}=${values[0]}`,
            ...values.slice(1),
          ]);
          expect(attached.values.get(option.long)).toEqual(values);
          const repeatedValues =
            option.long === "--format" ? ["yaml"] : values.map((item) => `${item}-again`);
          const repeated = parseArgs(command.name, [
            option.long,
            ...values,
            option.long,
            ...repeatedValues,
          ]);
          expect(repeated.values.get(option.long)).toEqual([...values, ...repeatedValues]);
        }
        for (const alias of option.aliases ?? []) {
          const aliased = parseArgs(command.name, [alias, ...values]);
          if (option.kind === "flag") expect(aliased.flags.has(option.long)).toBeTrue();
          else expect(aliased.values.get(option.long)).toEqual(values);
        }
      }
    }
  });

  test("global option names, aliases, attached values, and arity come from the spec", () => {
    for (const option of CLI_SPEC.globalOptions) {
      const values = optionValues(option as (typeof CLI_SPEC.commands)[number]["options"][number]);
      const parsed = parseGlobalOption([option.long, ...values], 0);
      expect(parsed.name).toBe(option.long);
      expect(parsed.items).toEqual(values);
      if (option.kind === "flag") {
        expect(() => parseGlobalOption([`${option.long}=value`], 0)).toThrow(
          `${option.long} does not take a value`,
        );
      } else {
        expect(() => parseGlobalOption([option.long], 0)).toThrow(
          `${option.long} requires a value`,
        );
        expect(parseGlobalOption([`${option.long}=${values[0]}`], 0).items).toEqual(values);
      }
      for (const alias of option.aliases ?? []) {
        expect(parseGlobalOption([alias, ...values], 0)).toMatchObject({ name: option.long });
      }
    }
    expect(() => parseGlobalOption(["--not-declared"], 0)).toThrow("unknown option");
  });

  test("parser preserves ordering, tail, attached arity-two, and repeated-value semantics", () => {
    const parsed = parseArgs("discover-feed", [
      "before",
      "--etag=one=two",
      "middle",
      "--page=https://example.com/2",
      "page-2.xml",
      "--etag",
      "last",
      "--",
      "--not-an-option",
      "after",
    ]);
    expect(parsed.positionals).toEqual(["before", "middle", "--not-an-option", "after"]);
    expect(parsed.values.get("--etag")).toEqual(["one=two", "last"]);
    expect(parsed.values.get("--etag")?.at(-1)).toBe("last");
    expect(parsed.values.get("--page")).toEqual(["https://example.com/2", "page-2.xml"]);

    for (const command of ["discover-feed", "check-presets", "reconcile-queue"])
      expect(() => parseArgs(command, ["--format", "human"])).not.toThrow();
    expect(() => parseArgs("fetch-markdown", ["--format", "xml"])).toThrow(
      "--format must be json, yaml, or human",
    );
  });

  test("JSON help has correct machine metadata and one exact stable golden", () => {
    const markdown = jsonHelp("fetch-markdown") as { arguments: Array<Record<string, unknown>> };
    expect(markdown.arguments.find(({ name }) => name === "--media")).toMatchObject({
      type: "text",
      choices: ["light", "dark"],
    });
    for (const name of ["--generic", "--envelope", "--allow-private-network", "--retain-artifacts"])
      expect(markdown.arguments.find((argument) => argument.name === name)).toMatchObject({
        type: "flag",
      });

    const feed = jsonHelp("discover-feed") as { arguments: Array<Record<string, unknown>> };
    expect(feed.arguments.find(({ name }) => name === "--source-url")).toMatchObject({
      type: "text",
      required: true,
    });
    expect(feed.arguments.find(({ name }) => name === "--page")).toEqual({
      name: "--page",
      type: "text",
      required: false,
      description: "Recorded pagination page; requires FILE",
      value_count: 2,
      repeatable: true,
    });

    const expected = {
      name: "check-presets",
      description: "Run configured public canaries",
      arguments: [
        {
          name: "--live",
          type: "flag",
          required: true,
          description: "Acknowledge live canary execution",
        },
        {
          name: "--preset",
          type: "text",
          required: false,
          description: "Select a preset",
          repeatable: true,
        },
        {
          name: "--allow-private-network",
          type: "flag",
          required: false,
          description: "Allow unrestricted browser/private network egress",
        },
        {
          name: "--format",
          type: "text",
          required: false,
          description: "Select output",
          choices: ["json", "yaml"],
          default: "json",
        },
        {
          name: "--help",
          type: "flag",
          required: false,
          description: "Show help",
          aliases: ["-h"],
        },
        {
          name: "--help-json",
          type: "flag",
          required: false,
          description: "Show machine-readable JSON help",
        },
      ],
    };
    expect(jsonHelp("check-presets")).toEqual(expected);
    expect(renderJsonHelp("check-presets")).toBe(JSON.stringify(expected, null, 2));

    const doctorExpected = {
      name: "doctor",
      description: "Inspect offline runtime readiness and optional capabilities",
      arguments: [
        {
          name: "--format",
          type: "text",
          required: false,
          description: "Select output",
          choices: ["human", "json"],
          default: "human",
        },
        {
          name: "--help",
          type: "flag",
          required: false,
          description: "Show help",
          aliases: ["-h"],
        },
        {
          name: "--help-json",
          type: "flag",
          required: false,
          description: "Show machine-readable JSON help",
        },
      ],
    };
    expect(jsonHelp("doctor")).toEqual(doctorExpected);
    expect(renderJsonHelp("doctor")).toBe(JSON.stringify(doctorExpected, null, 2));
    expect(renderHumanHelp("doctor")).toStartWith("Usage: agentscrape doctor [OPTIONS]");
    expect(Object.keys(jsonHelp())).toEqual(["name", "description", "arguments", "commands"]);
  });
});

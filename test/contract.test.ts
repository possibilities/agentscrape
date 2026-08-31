import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLI_SPEC } from "../src/cli-spec";
import {
  type AgentContract,
  allCommandSpecs,
  buildContract,
  type ContractCommand,
  contractEnvelope,
  renderAgentHelp,
} from "../src/contract";
import { AGENTSCRAPE_VERSION } from "../src/version";

/**
 * This repository owns its conformance to the fleet agent contract. The
 * normative shape is agentstart/config/agent-contract/schema.json, executed by
 * agentstart/scripts/validate-agent-contract.ts; the assertions here are the
 * rules whose breakage would be invisible until that fleet check ran, so a
 * broken contract fails in this suite first.
 */

const CONTRACT_KEYS = [
  "contract_version",
  "meta",
  "guidance",
  "concepts",
  "global_arguments",
  "commands",
];
const COMMAND_KEYS = [
  "name",
  "summary",
  "audience",
  "mutates",
  "guidance",
  "arguments",
  "subcommands",
  "stdin",
  "constraints",
];
const ARGUMENT_KEYS = [
  "name",
  "type",
  "description",
  "format",
  "direction",
  "required",
  "positional",
  "repeatable",
  "choices",
  "default",
  "aliases",
];
const ARGUMENT_TYPES = ["string", "boolean", "integer", "number"];
const AUDIENCES = ["agent", "operator", "internal"];

const contract = buildContract();

function leaves(commands: readonly ContractCommand[] = contract.commands): ContractCommand[] {
  return commands.flatMap((command) =>
    "subcommands" in command
      ? leaves((command as { subcommands: ContractCommand[] }).subcommands)
      : [command],
  );
}

describe("fleet agent contract", () => {
  test("guide --json emits a version-1 contract inside the CLI envelope", async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src/cli.ts"), "guide", "--json"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schema_version: number;
      ok: boolean;
      error: null;
      data: AgentContract;
    };
    expect(parsed).toMatchObject({ schema_version: 1, ok: true, error: null });
    expect(parsed.data).toEqual(contract as never);
    expect(contractEnvelope()).toEqual(parsed as never);
    expect(contract.contract_version).toBe(1);
    expect(contract.meta).toEqual({
      name: "agentscrape",
      version: AGENTSCRAPE_VERSION,
      purpose: expect.any(String),
      audience: "agent",
    });
    // An agent-facing CLI owes the conceptual layer.
    expect(contract.guidance.length).toBeGreaterThan(0);
    expect(Object.keys(contract.concepts)).toContain("output_contract");
    expect(Object.keys(contract.concepts)).toContain("error_codes");
    expect(Object.keys(contract)).toEqual(CONTRACT_KEYS);
  });

  test("declares every command the CLI dispatches, hidden ones included", () => {
    // Omission is never how a command is hidden: a missing command is
    // indistinguishable from an oversight, so audience carries the exposure.
    expect(contract.commands.map(({ name }) => name)).toEqual(
      allCommandSpecs().map(({ name }) => name),
    );
    expect(contract.commands.map(({ name }) => name)).toContain("help");
    expect(contract.commands.find(({ name }) => name === "process-queue")?.audience).toBe(
      "internal",
    );
    for (const command of leaves()) expect(AUDIENCES).toContain(command.audience);
  });

  test("read_only_commands is exactly the non-mutating leaves", () => {
    const declared = (contract.concepts as { read_only_commands: string[] }).read_only_commands;
    expect([...declared].sort()).toEqual(
      leaves()
        .filter((command) => !command.mutates)
        .map((command) => command.name)
        .sort(),
    );
    for (const name of declared)
      expect(leaves().some((command) => command.name === name)).toBeTrue();
  });

  test("every leaf carries a mutation verdict and well-formed arguments", () => {
    for (const command of leaves()) {
      expect(Object.keys(command).every((key) => COMMAND_KEYS.includes(key))).toBeTrue();
      expect(typeof command.mutates).toBe("boolean");
      expect(Array.isArray(command.arguments)).toBeTrue();
      const names = new Set<string>();
      for (const argument of command.arguments) {
        const where = `${command.name} ${argument.name}`;
        expect(
          Object.keys(argument).every((key) => ARGUMENT_KEYS.includes(key)),
          where,
        ).toBeTrue();
        expect(ARGUMENT_TYPES, where).toContain(argument.type);
        expect(argument.description.length, where).toBeGreaterThan(0);
        // A flag wears its dashes and a positional does not; the slip produces
        // an argument nobody can pass.
        expect(argument.name.startsWith("-"), where).toBe(argument.positional !== true);
        if (argument.direction !== undefined) expect(argument.format, where).toBe("path");
        expect(names.has(argument.name), where).toBeFalse();
        names.add(argument.name);
      }
      for (const constraint of command.constraints ?? []) {
        expect(constraint.arguments.length).toBeGreaterThanOrEqual(2);
        for (const name of constraint.arguments) expect(names.has(name), name).toBeTrue();
      }
      // An out-of-process caller has no pipe.
      if (command.audience === "agent") expect(command.stdin?.required).not.toBe(true);
    }
  });

  test("states the facts a type cannot carry", () => {
    const find = (name: string) => leaves().find((command) => command.name === name)!;
    const destination = find("fetch-markdown").arguments.find(({ name }) => name === "dest");
    expect(destination).toMatchObject({ format: "path", direction: "out", positional: true });
    expect(find("fetch-markdown").constraints).toContainEqual(
      expect.objectContaining({
        kind: "conflicts",
        arguments: ["--envelope", "--retain-artifacts"],
      }),
    );
    expect(find("convert-html").stdin).toMatchObject({ accepts: "text", required: false });
    expect(
      find("discover-feed").arguments.find(({ name }) => name === "--source-url"),
    ).toMatchObject({ format: "url", required: true });
    // --help-json reports every value option as "text"; the contract reports scalars.
    expect(
      find("discover-feed").arguments.find(({ name }) => name === "--timeout-seconds"),
    ).toMatchObject({ type: "number" });
    expect(
      find("fetch-markdown").arguments.find(({ name }) => name === "--max-relations"),
    ).toMatchObject({ type: "integer" });
  });

  test("global arguments are declared once, never repeated per command", () => {
    const globals = contract.global_arguments.map(({ name }) => name);
    expect(globals).toEqual(CLI_SPEC.globalOptions.map(({ long }) => long));
    for (const command of leaves())
      for (const name of ["--help", "--help-json"])
        expect(
          command.arguments.some((argument) => argument.name === name),
          command.name,
        ).toBeFalse();
    // A command that genuinely selects an output format keeps its own --format.
    expect(
      leaves()
        .find((command) => command.name === "doctor")!
        .arguments.find(({ name }) => name === "--format"),
    ).toMatchObject({ choices: ["human", "json"], default: "human" });
    expect(
      leaves()
        .find((command) => command.name === "fetch-links")!
        .arguments.some(({ name }) => name === "--format"),
    ).toBeFalse();
  });

  test("--agent-help is a render of the contract, not a second authorship", () => {
    const rendered = renderAgentHelp();
    expect(rendered).toContain(contract.meta.version);
    expect(rendered).toContain(contract.guidance);
    for (const command of contract.commands) {
      expect(rendered).toContain(command.summary);
      if (command.audience === "agent" && command.guidance)
        // Prose survives the wrap, so compare on a distinctive fragment.
        expect(rendered.replace(/\s+/g, " ")).toContain(command.guidance.split(". ")[0]!);
    }
    for (const [code, meaning] of Object.entries(
      (contract.concepts as { output_contract: { exit_codes: Record<string, string> } })
        .output_contract.exit_codes,
    )) {
      expect(rendered).toContain(code);
      expect(rendered).toContain(meaning);
    }
  });
});

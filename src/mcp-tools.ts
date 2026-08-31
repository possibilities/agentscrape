/**
 * The contract → MCP mapping, whole, in one file.
 *
 * agentstart/config/agent-contract/MCP.md is the normative specification and
 * this module implements exactly it: which commands become tools, how names and
 * input schemas are built, how each constraint maps, how the annotations are
 * derived, what the server's instructions carry, and how a tool call becomes an
 * invocation. Nothing here decides which commands an agent may call — the
 * contract already answered that in `audience`, and a mapper that second-guessed
 * it would have moved the decision back to the consumer.
 *
 * Six sibling CLIs carry the same mapping, so it is deliberately dull. The
 * agentscrape-specific judgments are the two annotation lists the contract
 * cannot state, and the two-value `--page`, and they are marked where they
 * appear.
 *
 * Nothing in here imports the MCP SDK: the mapping is a description of tools,
 * and `mcp-server.ts` is what hands that description to a server.
 */

import { z } from "zod";
import type { AgentContract, ContractArgument, ContractCommand } from "./contract";

/** The half of `guide --json` this mapping reads, named so it can be read. */
export interface ContractDocument extends AgentContract {
  readonly concepts: {
    readonly output_contract: {
      readonly envelope: Record<string, string>;
      readonly exit_codes: Record<string, string>;
    };
    readonly error_codes: readonly { code: string; meaning: string; recovery?: string }[];
    readonly agent_defaults: readonly string[];
  } & Record<string, unknown>;
}

/** The four hints MCP carries. Declared here rather than imported so this file
 * stays SDK-free; the shape is `ToolAnnotations` and is checked structurally. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface AgentTool {
  /** The command's name, never prefixed with the CLI's: the host already
   * namespaces by server. Agentscrape's commands are flat, so a name is one
   * segment; a sibling with groups joins the full path with `_`. */
  readonly name: string;
  readonly path: readonly string[];
  readonly title: string;
  readonly description: string;
  /** Advertised as JSON Schema and used to validate the call. */
  readonly input: z.ZodObject<Record<string, z.ZodType>>;
  readonly annotations: ToolAnnotations;
  /** Exactly the arguments the schema above exposes — the command's own plus
   * any `call` global. Held so invoking reads the same set the schema
   * advertised. */
  readonly arguments: readonly ContractArgument[];
  readonly command: ContractCommand;
}

// --- Which commands become tools ---

/**
 * Exactly the commands whose `audience` is `agent`: not `operator`, which is
 * human-driven, and not `internal`, which is nonsense to call — `mcp` itself
 * included. Agentscrape declares every command it dispatches, hidden ones
 * included, so this filter is the only thing standing between the corpus,
 * canary, preset-authoring, and session tooling and a model's tool list.
 */
function agentCommands(document: ContractDocument): readonly ContractCommand[] {
  return document.commands.filter((command) => command.audience === "agent");
}

// --- Input schema ---

/**
 * `--selector` → `selector`, `url` → `url`. A flag and a positional differing
 * only by the dashes would collide; the contract's own conformance test already
 * refuses a duplicate argument name within a command, and the dispatcher looks
 * each argument back up by its contract name, so nothing depends on this
 * spelling beyond being typeable.
 */
function propertyName(name: string): string {
  return name.replace(/^--/, "");
}

/** MCP.md: an `out` path is a destination the command writes, and the caller
 * did not choose the working directory a relative one resolves against. */
const OUT_PATH_NOTE =
  "The command WRITES this path — it is never read. A relative path resolves against a working directory this caller did not choose, so prefer an absolute one, and an existing file at that path is overwritten.";

/** MCP.md: a `ref` stays a string and says what resolves. Agentscrape declares
 * no `ref` today; the note is here so the day one appears it is described
 * rather than silently shipped as a bare string. */
const REF_NOTE = "Accepts a name or an unambiguous phrase; an id is not required.";

/** A URL argument is web input, and everything downstream of it is untrusted. */
const URL_NOTE = "An absolute http(s) URL.";

/**
 * Said even when an authored description already says it. The mapping has to
 * GUARANTEE the caller is told how a csv argument is spelled; a mapper that
 * first checks whether the prose says it is one that silently stops saying it
 * the day the prose is reworded. Agentscrape declares no csv argument today.
 */
function csvNote(argument: ContractArgument): string {
  return argument.format === "ref"
    ? "Comma-joined into one string, each entry a reference"
    : "Comma-joined into one string";
}

/**
 * The two-value options MCP.md has no vocabulary for: agentscrape's `--page`
 * takes a URL and the recorded file for it, so one entry is a pair rather than
 * a scalar. The contract carries the arity as `x_value_count`; without it the
 * mapping would have to guess from prose.
 */
function pairs(argument: ContractArgument): boolean {
  return argument.x_value_count === 2;
}

/** The contract's descriptions are phrases, not sentences — "CSS selector",
 * "Document URL to fetch" — so anything appended to one needs the stop the
 * author did not write. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;
}

function propertyDescription(argument: ContractArgument): string {
  const parts = [argument.description];
  if (argument.format === "ref") parts.push(REF_NOTE);
  if (argument.format === "url") parts.push(URL_NOTE);
  if (argument.csv === true) parts.push(csvNote(argument));
  if (argument.format === "path" && argument.direction === "out") parts.push(OUT_PATH_NOTE);
  if (pairs(argument)) parts.push("Each entry is the two values, in the order named above.");
  return parts.map(sentence).join(" ");
}

/**
 * The contract's four scalars, verbatim. `choices` becomes an enum — agentscrape
 * has no non-string choice list, and a numeric one would need its own branch
 * rather than a coercion that quietly changed the type.
 *
 * A `minimum` or `maximum` is the bound the CLI's own parser enforces, so a
 * caller is refused here rather than after a round trip. Where the bound depends
 * on another argument — `--max-pages` is 1..100 recorded and 1..10 live — the
 * contract carries the widest one and the description carries the rest, which is
 * the only place a value-conditioned rule can live.
 */
function scalar(argument: ContractArgument): z.ZodType {
  if (argument.type === "boolean") return z.boolean();
  if (argument.choices !== undefined) return z.enum(argument.choices as [string, ...string[]]);
  if (argument.type === "string") return z.string();
  let numeric = argument.type === "integer" ? z.number().int() : z.number();
  if (argument.minimum !== undefined) numeric = numeric.min(argument.minimum);
  if (argument.maximum !== undefined) numeric = numeric.max(argument.maximum);
  return numeric;
}

function property(argument: ContractArgument): z.ZodType {
  const one = pairs(argument) ? z.tuple([z.string(), z.string()]) : scalar(argument);
  // `repeatable` without `csv` is an array of the scalar; `repeatable` AND `csv`
  // is also an array, and is comma-joined when invoked. A `csv` argument that is
  // not repeatable stays the single string it already is.
  const base = argument.repeatable === true ? z.array(one) : one;
  const described = base.describe(propertyDescription(argument));
  // A default makes the property optional in the input schema on its own, which
  // is why it is checked before `required`.
  if (argument.default !== undefined) return described.default(argument.default as never);
  return argument.required === true ? described : z.optional(described);
}

/**
 * A command's own arguments, plus the globals whose `role` is `call`.
 *
 * Everything else is suppressed: `output-format` and `meta` are concerns the
 * caller has already fixed. In agentscrape that suppresses all six globals — the
 * compatibility `--format` no command reads, and the five that ask the binary to
 * describe itself instead of doing anything.
 */
function callArguments(
  document: ContractDocument,
  command: ContractCommand,
): readonly ContractArgument[] {
  const globals = document.global_arguments.filter(
    (argument) => (argument.role ?? "call") === "call",
  );
  return [...command.arguments, ...globals];
}

// --- Constraints ---

/**
 * Expressed in the schema where JSON Schema can, and in the description ALWAYS.
 * A schema-only rule is invisible in most host UIs, and a caller that cannot see
 * a rule breaks it.
 *
 * Zod cannot express a cross-field rule, so the schema keywords are injected
 * through its metadata, which the SDK's converter merges into the emitted JSON
 * Schema. They are advisory either way: the command itself is the enforcement,
 * and duplicating its checks here would be the second authorship this contract
 * exists to delete.
 */
interface MappedConstraints {
  keywords: Record<string, unknown>;
  sentences: string[];
}

/** `oneOf`/`anyOf` of single-property `required` shapes, per MCP.md. */
function eitherOf(members: readonly string[]): { required: string[] }[] {
  return members.map((member) => ({ required: [member] }));
}

function listed(members: readonly string[]): string {
  if (members.length < 3) return members.join(" and ");
  return `${members.slice(0, -1).join(", ")}, and ${members.at(-1)}`;
}

/**
 * The constraint in the CLI's own words when it wrote one, with the arguments
 * spelled as the properties this schema advertises rather than as flags. A
 * constraint without a description still gets a sentence: silence is how a rule
 * becomes invisible.
 */
function constraintSentence(constraint: NonNullable<ContractCommand["constraints"]>[number]) {
  const members = constraint.arguments.map(propertyName);
  const authored = constraint.description
    ? ` ${constraint.description.replace(/--([a-z][a-z0-9-]*)/g, "$1")}`
    : "";
  if (constraint.kind === "one_of")
    return `${constraint.required ? "Give exactly one of" : "Give at most one of"} ${listed(members)}.${authored}`;
  if (constraint.kind === "at_least_one")
    return `Give at least one of ${listed(members)}.${authored}`;
  if (constraint.kind === "conflicts") return `Do not combine ${listed(members)}.${authored}`;
  // Every argument but the last depends on the last: one dependant is the
  // contract's own shape, several is the grouping above.
  return `${listed(members.slice(0, -1))} ${members.length > 2 ? "each require" : "requires"} ${members.at(-1)}.${authored}`;
}

/**
 * `requires` constraints that name the same second argument and say the same
 * thing, spoken once. Agentscrape declares nine of them on `discover-feed` —
 * every archive selector is inert without `--archive-entry-selector` — and nine
 * near-identical paragraphs in a tool description is how a caller learns to skip
 * the description. The rule is unchanged; only the repetition is.
 */
function grouped(
  constraints: NonNullable<ContractCommand["constraints"]>,
): NonNullable<ContractCommand["constraints"]> {
  const out: {
    kind: "one_of" | "at_least_one" | "conflicts" | "requires";
    arguments: string[];
    required?: boolean;
    description?: string;
  }[] = [];
  for (const constraint of constraints) {
    const previous = out.at(-1);
    if (
      constraint.kind === "requires" &&
      constraint.arguments.length === 2 &&
      previous?.kind === "requires" &&
      previous.arguments.at(-1) === constraint.arguments[1] &&
      previous.description === constraint.description
    ) {
      previous.arguments.splice(-1, 0, constraint.arguments[0]!);
      continue;
    }
    out.push({
      kind: constraint.kind,
      arguments: [...constraint.arguments],
      ...(constraint.required !== undefined ? { required: constraint.required } : {}),
      ...(constraint.description !== undefined ? { description: constraint.description } : {}),
    });
  }
  return out;
}

function mapConstraints(command: ContractCommand): MappedConstraints {
  const keywords: Record<string, unknown> = {};
  const sentences: string[] = [];
  for (const constraint of grouped(command.constraints ?? [])) {
    sentences.push(constraintSentence(constraint));
    const members = constraint.arguments.map(propertyName);
    switch (constraint.kind) {
      case "one_of":
        // Nothing in JSON Schema says "at most one" without `not`, which is
        // legal and unreadable in practice; there the sentence is the whole
        // mapping.
        if (constraint.required === true) keywords.oneOf = eitherOf(members);
        break;
      case "at_least_one":
        keywords.anyOf = eitherOf(members);
        break;
      case "requires": {
        const target = members.at(-1)!;
        const dependants = Object.fromEntries(
          members.slice(0, -1).map((member) => [member, [target]]),
        );
        keywords.dependentRequired = {
          ...((keywords.dependentRequired as Record<string, string[]>) ?? {}),
          ...dependants,
        };
        break;
      }
      case "conflicts":
        // Expressible as `not`/`allOf` and unreadable as either; described only.
        break;
    }
  }
  return { keywords, sentences };
}

// --- Annotations ---

/**
 * Commands whose repeat call is NOT a no-op. Agentscrape has none: every agent
 * command either reads, or writes a named destination whose second write lands
 * the same bytes. A capture that appended would be listed here.
 */
const APPENDING: ReadonlySet<string> = new Set<string>();

/**
 * Commands that reach the network. Unlike the fleet's local tools this is most
 * of agentscrape: fetching a URL is the whole product. `convert-html` and
 * `list-presets`, `show-preset`, and `guide` are the offline ones — a URL never
 * enters them.
 */
const NETWORK: ReadonlySet<string> = new Set(["fetch-markdown", "fetch-links", "discover-feed"]);

/**
 * The two lists above, exported for the test that pins them against the
 * contract: a list naming a command nobody has is a list that has rotted, and
 * an annotation is the one place where nothing else would notice.
 */
export const ANNOTATION_EXCEPTIONS: {
  readonly appending: ReadonlySet<string>;
  readonly network: ReadonlySet<string>;
} = { appending: APPENDING, network: NETWORK };

/** Verbs that remove or overwrite. MCP.md derives `destructiveHint` from
 * `mutates` plus the verb, and the verb is the one thing it cannot read off a
 * field. Agentscrape removes nothing; it overwrites, which the `out` path below
 * catches. */
const REMOVING_VERBS = new Set(["rm", "remove", "delete", "destroy", "gc", "prune", "purge"]);

function annotations(command: ContractCommand): ToolAnnotations {
  const writesOut = command.arguments.some(
    (argument) => argument.format === "path" && argument.direction === "out",
  );
  return {
    readOnlyHint: command.mutates === false,
    destructiveHint: command.mutates === true && (REMOVING_VERBS.has(command.name) || writesOut),
    idempotentHint: !APPENDING.has(command.name),
    openWorldHint: NETWORK.has(command.name),
  };
}

// --- Description ---

function toolDescription(
  document: ContractDocument,
  command: ContractCommand,
  sentences: readonly string[],
): string {
  const parts: string[] = [];
  // MCP.md: a blocking command says so in the FIRST sentence, because a host
  // with a request timeout has no other way to know. No agent-audience
  // agentscrape command is declared blocking — `mcp` is, and it is internal —
  // but a live fetch is slow enough that the sentence would matter the day one
  // is. Nothing here spends money or quota: agentscrape uses no paid API.
  if (command.blocking === true) {
    parts.push("Blocks: this waits on something outside the CLI and may not return promptly.");
  }
  parts.push(`${command.summary}.`);
  parts.push(`Runs \`${document.meta.name} ${command.name}\` in this process.`);
  if (command.stdin !== undefined && command.stdin.required !== true) {
    // An out-of-process caller has no pipe, so a command that would otherwise
    // read stdin must be told what to pass instead.
    parts.push(
      `This CLI reads stdin here (${command.stdin.description.replace(/\.$/, "")}) and an MCP caller has no pipe, so give the arguments that select a source instead.`,
    );
  }
  parts.push(...sentences);
  if (command.guidance !== undefined) parts.push(command.guidance);
  return parts.join("\n\n");
}

// --- The surface ---

export function agentTools(document: ContractDocument): AgentTool[] {
  return agentCommands(document).map((command) => {
    const exposed = callArguments(document, command);
    const shape: Record<string, z.ZodType> = {};
    for (const argument of exposed) shape[propertyName(argument.name)] = property(argument);
    const { keywords, sentences } = mapConstraints(command);
    return {
      name: command.name,
      path: [command.name],
      title: command.summary,
      description: toolDescription(document, command, sentences),
      input: z.object(shape).meta(keywords),
      annotations: annotations(command),
      arguments: exposed,
      command,
    };
  });
}

/**
 * The server's `instructions`: the contract's `guidance`, then what `concepts`
 * says a caller must know — the output contract, the error codes with their
 * recovery, and `agent_defaults`. This is the half of the contract a tool schema
 * cannot carry, and dropping it ships a surface that works and is used wrongly.
 *
 * Agentscrape's standing rules — denied browser egress, operator-owned sessions,
 * untrusted output — are in `guidance`, so they arrive with it rather than being
 * restated here. Exit codes are the one part of the output contract left out:
 * there is no process to exit here, and a refusal arrives as a tool error.
 */
export function serverInstructions(document: ContractDocument): string {
  const envelope = Object.entries(document.concepts.output_contract.envelope)
    .map(([field, meaning]) => `  ${field}: ${meaning}`)
    .join("\n");
  const errors = document.concepts.error_codes
    .map((entry) =>
      entry.recovery === undefined
        ? `  ${entry.code} — ${entry.meaning}`
        : `  ${entry.code} — ${entry.meaning} → ${entry.recovery}`,
    )
    .join("\n");
  const defaults = document.concepts.agent_defaults.map((line) => `  ${line}`).join("\n");
  return `${document.guidance}

Every tool returns what ${document.meta.name} itself writes to stdout, as text:
${envelope}

A refusal comes back as a tool error whose first line is the failure code, then
the message, then the recovery when there is one. The recovery line is the
difference between a caller that retries correctly and one that retries
identically, so read it before calling again.

Failure codes
${errors}

Opening moves
${defaults}
`;
}

// --- Invoking ---

/**
 * A tool call, as this CLI's own dispatcher takes it.
 *
 * Agentscrape's dispatcher is argv: `main` reads a command name and hands the
 * rest to the command's own `parseArgs`, and there is no lower-level entry to
 * reach — unlike AgentBoard, whose handlers take an already-parsed flag object.
 * So this builds the argument vector structurally, as an array of exact strings
 * that is passed to `main` in this process. Nothing is quoted, nothing goes
 * through a shell, and no string is ever parsed back apart.
 */
export function argvFor(tool: AgentTool, args: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const argument of tool.arguments) {
    const value = args[propertyName(argument.name)];
    if (value === undefined) continue;
    if (argument.positional === true) {
      positionals.push(String(value));
      continue;
    }
    // An absent boolean flag and one passed as false are the same call.
    if (argument.type === "boolean") {
      if (value === true) flags.push(argument.name);
      continue;
    }
    // `csv` is one comma-joined value however many entries it carries, which is
    // the whole difference between it and a repeated flag.
    if (argument.csv === true) {
      flags.push(argument.name);
      flags.push(Array.isArray(value) ? value.map(String).join(",") : String(value));
      continue;
    }
    for (const item of argument.repeatable === true ? (value as unknown[]) : [value]) {
      flags.push(argument.name);
      if (pairs(argument)) flags.push(...(item as [string, string]));
      else flags.push(String(item));
    }
  }
  // Positionals last: an option's values are consumed by position after its
  // flag, so a positional wedged between two of them would be read as one.
  return [tool.name, ...flags, ...positionals];
}

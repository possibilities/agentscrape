import { AgentscrapeUsageError } from "./errors";
import { AGENTSCRAPE_VERSION } from "./version";

export type LongOptionName = `--${string}`;
export type ShortOptionName = `-${string}`;

/**
 * The fleet agent contract's vocabulary, declared here beside the syntax it
 * refines. `src/contract.ts` renders these judgments into `guide --json`; they
 * are authored once, in the same object literal as the command they describe,
 * so a new command cannot ship without an audience and a mutation verdict.
 */
export type ArgumentFormat = "path" | "url" | "duration" | "ref" | "json";
export type ArgumentDirection = "in" | "out";
export type CommandAudience = "agent" | "operator" | "internal";
export type ContractScalar = "string" | "integer" | "number";
/**
 * What kind of knob an argument is, in the fleet contract's vocabulary. Only a
 * `call` argument is a parameter a caller chooses; everything else is output
 * shape, store selection, or meta, which a consumer building a call surface has
 * already fixed. Agentscrape declares it on the global options, where the
 * distinction decides what the MCP surface may ask a model to pick.
 */
export type ArgumentRole = "call" | "output-format" | "store-selection" | "meta";
export const COMMAND_AUDIENCES: readonly CommandAudience[] = ["agent", "operator", "internal"];
const ARGUMENT_FORMATS: readonly ArgumentFormat[] = ["path", "url", "duration", "ref", "json"];
const CONTRACT_SCALARS: readonly ContractScalar[] = ["string", "integer", "number"];
// The contract's four kinds, all of them. Agentscrape authors three today;
// `at_least_one` is the one that states "give me one of these" the way round
// `one_of` cannot, and a spec that omitted it would refuse the day a command
// needs it rather than the day someone widened this list.
const CONSTRAINT_KINDS = ["one_of", "at_least_one", "conflicts", "requires"] as const;
const ARGUMENT_ROLES: readonly ArgumentRole[] = [
  "call",
  "output-format",
  "store-selection",
  "meta",
];

interface OptionBase {
  readonly long: LongOptionName;
  readonly aliases?: readonly ShortOptionName[];
  readonly required: boolean;
  readonly description: string;
  readonly inventory?: true;
  /** Declared once in the contract's global_arguments instead of per command. */
  readonly global?: true;
  readonly format?: ArgumentFormat;
  readonly direction?: ArgumentDirection;
  /** `call` when unstated, which is what the contract reports. */
  readonly role?: ArgumentRole;
}

export interface FlagOptionSpec extends OptionBase {
  readonly kind: "flag";
  readonly valueCount?: never;
  readonly valueLabels?: never;
  readonly repeatable?: never;
  readonly choices?: never;
  readonly default?: never;
  readonly valueType?: never;
}

export interface ValueOptionSpec extends OptionBase {
  readonly kind: "value";
  readonly valueCount: 1 | 2;
  readonly valueLabels: readonly [string] | readonly [string, string];
  readonly repeatable?: true;
  readonly choices?: readonly string[];
  readonly default?: string | number;
  /** Contract scalar; `string` when unstated, which is what --help-json reports. */
  readonly valueType?: ContractScalar;
  /**
   * The bound the parser already enforces, said where a consumer can read it.
   * `numberOption` refuses an out-of-range value at the terminal; a generated
   * call surface that could not see the same number would let a caller spend a
   * whole round trip discovering it.
   */
  readonly minimum?: number;
  readonly maximum?: number;
  /** The option takes one comma-joined string rather than repeating. Composes
   * with `repeatable`; agentscrape declares no such option today. */
  readonly csv?: true;
}

export type OptionSpec = FlagOptionSpec | ValueOptionSpec;

export interface PositionalSpec {
  readonly name: string;
  readonly displayName: string;
  readonly type: "text";
  readonly required: boolean;
  readonly description: string;
  readonly repeatable?: true;
  readonly format?: ArgumentFormat;
  readonly direction?: ArgumentDirection;
}

export interface StdinSpec {
  readonly accepts: "text" | "json";
  readonly required?: boolean;
  readonly description: string;
}

export interface ConstraintSpec {
  readonly kind: (typeof CONSTRAINT_KINDS)[number];
  readonly arguments: readonly string[];
  readonly required?: boolean;
  readonly description?: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly audience: CommandAudience;
  /** Whether a successful call can change durable state: disk, network, or another process. */
  readonly mutates: boolean;
  /** The command waits on something outside itself and may not return promptly. */
  readonly blocking?: true;
  readonly guidance?: string;
  readonly paragraphs: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  readonly options: readonly OptionSpec[];
  readonly stdin?: StdinSpec;
  readonly constraints?: readonly ConstraintSpec[];
}

export interface CliSpec {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly globalOptions: readonly OptionSpec[];
  readonly commands: readonly CommandSpec[];
  readonly hiddenCommands: readonly CommandSpec[];
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ReadonlyOptionSpec = DeepReadonly<OptionSpec>;
export type ReadonlyCommandSpec = DeepReadonly<CommandSpec>;
export type ReadonlyCliSpec = DeepReadonly<CliSpec>;

interface FlagSettings {
  readonly aliases?: readonly ShortOptionName[];
  readonly required?: boolean;
  readonly inventory?: true;
  readonly global?: true;
  readonly role?: ArgumentRole;
}

interface ValueSettings {
  readonly aliases?: readonly ShortOptionName[];
  readonly required?: boolean;
  readonly repeatable?: true;
  readonly choices?: readonly string[];
  readonly default?: string | number;
  readonly valueType?: ContractScalar;
  readonly format?: ArgumentFormat;
  readonly direction?: ArgumentDirection;
  readonly global?: true;
  readonly role?: ArgumentRole;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly csv?: true;
}

interface PositionalSettings {
  readonly format?: ArgumentFormat;
  readonly direction?: ArgumentDirection;
}

function flag(
  long: LongOptionName,
  description: string,
  settings: FlagSettings = {},
): FlagOptionSpec {
  return {
    long,
    kind: "flag",
    required: settings.required ?? false,
    description,
    ...(settings.aliases ? { aliases: settings.aliases } : {}),
    ...(settings.inventory ? { inventory: true as const } : {}),
    ...(settings.global ? { global: true as const } : {}),
    ...(settings.role ? { role: settings.role } : {}),
  };
}

function value(
  long: LongOptionName,
  valueLabels: readonly [string] | readonly [string, string],
  description: string,
  settings: ValueSettings = {},
): ValueOptionSpec {
  return {
    long,
    kind: "value",
    required: settings.required ?? false,
    description,
    valueCount: valueLabels.length as 1 | 2,
    valueLabels,
    ...(settings.aliases ? { aliases: settings.aliases } : {}),
    ...(settings.repeatable ? { repeatable: true as const } : {}),
    ...(settings.choices ? { choices: settings.choices } : {}),
    ...(settings.default !== undefined ? { default: settings.default } : {}),
    ...(settings.valueType ? { valueType: settings.valueType } : {}),
    ...(settings.format ? { format: settings.format } : {}),
    ...(settings.direction ? { direction: settings.direction } : {}),
    ...(settings.global ? { global: true as const } : {}),
    ...(settings.role ? { role: settings.role } : {}),
    ...(settings.minimum !== undefined ? { minimum: settings.minimum } : {}),
    ...(settings.maximum !== undefined ? { maximum: settings.maximum } : {}),
    ...(settings.csv ? { csv: true as const } : {}),
  };
}

function positional(
  name: string,
  displayName: string,
  required: boolean,
  description: string,
  settings: PositionalSettings = {},
): PositionalSpec {
  return {
    name,
    displayName,
    type: "text",
    required,
    description,
    ...(settings.format ? { format: settings.format } : {}),
    ...(settings.direction ? { direction: settings.direction } : {}),
  };
}

/** `requires` constraints for the archive selectors that only work with an entry selector. */
function archiveRequires(names: readonly string[]): readonly ConstraintSpec[] {
  return names.map((name) => ({
    kind: "requires" as const,
    arguments: [name, "--archive-entry-selector"],
    description: "Archive discovery is configured only when an entry selector is given.",
  }));
}

const GENERIC_FORMAT_CHOICES = ["json", "yaml", "human"] as const;

function formatOption(
  description = "Compatibility option (no-op)",
  choices: readonly string[] = GENERIC_FORMAT_CHOICES,
  defaultValue?: string,
  role?: ArgumentRole,
): ValueOptionSpec {
  return value("--format", ["FORMAT"], description, {
    choices,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(role ? { role } : {}),
  });
}

/**
 * The compatibility --format every command accepts and no command reads. It is
 * global in the contract's sense; a command that genuinely selects an output
 * format passes its own narrowed formatOption() instead.
 */
function genericFormatOption(): ValueOptionSpec {
  return value("--format", ["FORMAT"], "Compatibility option (no-op)", {
    choices: GENERIC_FORMAT_CHOICES,
    global: true,
  });
}

function commandOptions(
  actual: readonly OptionSpec[] = [],
  format: ValueOptionSpec = genericFormatOption(),
): readonly OptionSpec[] {
  return [
    ...actual,
    format,
    flag("--help", "Show help", { aliases: ["-h"], global: true }),
    flag("--help-json", "Show machine-readable JSON help", { global: true }),
  ];
}

const rawCliSpec = {
  name: "agentscrape",
  version: AGENTSCRAPE_VERSION,
  description: "Fetch and extract web content through an agent-friendly Bun CLI",
  // Not one global is a call knob: the compatibility --format is output shape
  // and the rest describe the CLI rather than parameterize a run. A consumer
  // building a call surface exposes only `call`, which is why every one of them
  // carries its role explicitly instead of defaulting into a tool schema.
  globalOptions: [
    formatOption("Compatibility output preference", undefined, undefined, "output-format"),
    flag("--help", "Show help", { aliases: ["-h"], role: "meta" }),
    flag("--version", "Show version", { aliases: ["-v"], role: "meta" }),
    flag("--help-json", "Show machine-readable JSON help", { role: "meta" }),
    flag("--agent-help", "Show concise guidance for agents", { role: "meta" }),
    flag("--agent-teaser", "Show the command inventory for agents", { role: "meta" }),
  ],
  commands: [
    {
      name: "fetch-markdown",
      summary: "Fetch a document and emit Markdown or structured output",
      audience: "agent",
      mutates: true,
      guidance:
        "The default verb: you have a URL and you want what is on it. Routing is automatic — a matching preset, GitHub or a Gist through gh, a direct .md over bounded HTTP, else generic browser extraction. DEST is written, never read, so pointing it at an existing file overwrites that file. Markdown is the default serialization; --envelope reports failure as a classified value instead of stderr diagnostics.",
      paragraphs: [],
      positionals: [
        positional("url", "URL", true, "Document URL to fetch", { format: "url" }),
        positional("dest", "DEST", false, "Optional output destination", {
          format: "path",
          direction: "out",
        }),
      ],
      options: commandOptions([
        value("--selector", ["CSS"], "CSS selector", { default: "auto main/article/body" }),
        value("--media", ["MODE"], "Emulated color scheme", {
          choices: ["light", "dark"],
        }),
        value("--session", ["NAME"], "Reuse a named browser session"),
        flag("--allow-private-network", "Allow private direct and unrestricted browser egress"),
        value("--preset", ["NAME"], "Select a content preset"),
        flag("--generic", "Force generic extraction on a claimed domain"),
        flag(
          "--retain-artifacts",
          "Retain sensitive HTML/screenshot diagnostics (Markdown DEST only for HTML)",
        ),
        flag("--json", "Select JSON output"),
        flag("--yaml", "Select YAML output"),
        flag("--markdown", "Select Markdown output"),
        flag("--envelope", "Emit a schema-v1 extraction envelope (incompatible with retention)"),
        value("--max-content-bytes", ["INTEGER"], "Envelope content limit (integer >= 1)", {
          default: 1_000_000,
          valueType: "integer",
          minimum: 1,
        }),
        value("--max-relations", ["INTEGER"], "Envelope relation limit (integer >= 0)", {
          default: 256,
          valueType: "integer",
          minimum: 0,
        }),
      ]),
      constraints: [
        {
          kind: "one_of",
          arguments: ["--json", "--yaml", "--markdown", "--envelope"],
          description: "At most one output selection; Markdown is the default.",
        },
        {
          kind: "conflicts",
          arguments: ["--envelope", "--retain-artifacts"],
          description: "Envelope output refuses diagnostic retention.",
        },
      ],
    },
    {
      name: "fetch-links",
      summary: "Extract navigation links or an account timeline",
      audience: "agent",
      mutates: false,
      guidance:
        "Two jobs behind one verb: a page's navigation links, and an X account timeline, where --limit, --max-scrolls, --since-id, --include-replies, and --include-reposts apply. Output is YAML unless another format is selected, and it goes to stdout — there is no destination argument.",
      paragraphs: [],
      positionals: [
        positional("url", "URL", true, "Page or account URL to fetch", { format: "url" }),
      ],
      options: commandOptions([
        value("--preset", ["NAME"], "Select a links preset"),
        value("--section-selector", ["CSS"], "Section/navigation selector"),
        value("--category-selector", ["CSS"], "Category selector for two-level navigation"),
        value("--toggle-selector", ["CSS"], "Toggle/tab selector"),
        value("--limit", ["INTEGER"], "Positive X timeline item limit", {
          valueType: "integer",
          minimum: 1,
        }),
        value("--max-scrolls", ["INTEGER"], "Positive X timeline scroll limit", {
          valueType: "integer",
          minimum: 1,
        }),
        value("--since-id", ["ID"], "Numeric X status cursor"),
        flag("--include-replies", "Include X replies"),
        flag("--include-reposts", "Include X reposts"),
        value("--media", ["MODE"], "Emulated color scheme", {
          choices: ["light", "dark"],
        }),
        value("--session", ["NAME"], "Reuse a named browser session"),
        flag("--allow-private-network", "Allow unrestricted browser/private network egress"),
        flag("--json", "Select JSON output (default output is YAML)"),
        flag("--yaml", "Select YAML output (default)"),
        flag("--markdown", "Select Markdown output"),
      ]),
      constraints: [
        {
          kind: "one_of",
          arguments: ["--json", "--yaml", "--markdown"],
          description: "At most one output selection; YAML is the default.",
        },
      ],
    },
    {
      name: "discover-feed",
      summary: "Discover live or recorded RSS, Atom, or archive entries",
      audience: "agent",
      mutates: false,
      guidance:
        "With no FILE the source and its pagination pages are fetched live. One FILE selects recorded mode, where --page URL FILE supplies further recorded pages and nothing touches the network. Archive discovery is configured only when --archive-entry-selector is given; every other --archive-* option is inert without it. The result is always a schema-v1 discovery document, and a discovery failure is reported in its failure field with exit code 1.",
      paragraphs: [
        "With no FILE, Agentscrape fetches the source and pagination pages directly. One FILE preserves network-free recorded-response parsing.",
      ],
      positionals: [
        positional("file", "FILE", false, "Recorded initial response file", {
          format: "path",
          direction: "in",
        }),
      ],
      options: commandOptions(
        [
          value("--source-url", ["URL"], "Requested feed, homepage, or archive URL", {
            required: true,
            format: "url",
          }),
          value("--source-kind", ["KIND"], "Source interpretation", {
            choices: ["auto", "feed", "archive"],
            default: "auto",
          }),
          value("--page", ["URL", "FILE"], "Recorded pagination page; requires FILE", {
            repeatable: true,
          }),
          value("--etag", ["VALUE"], "Conditional ETag, or recorded initial-page validator"),
          value("--last-modified", ["VALUE"], "Conditional Last-Modified, or recorded validator"),
          value("--validator-url", ["URL"], "Exact live response URL bound to validators", {
            format: "url",
          }),
          value("--since", ["DATE"], "Retain entries at or after DATE"),
          value(
            "--max-response-bytes",
            ["INTEGER"],
            "Per-response byte limit from 1 through 20000000",
            { default: 2_000_000, valueType: "integer", minimum: 1, maximum: 20_000_000 },
          ),
          // 100 is the parser's own ceiling. The live ceiling is 10, and it
          // depends on whether FILE was given, which no per-argument bound can
          // say — the description carries that half.
          value("--max-pages", ["INTEGER"], "Recorded 1..100; live 1..10", {
            default: 10,
            valueType: "integer",
            minimum: 1,
            maximum: 100,
          }),
          value("--max-items", ["INTEGER"], "Entry limit from 1 through 10000", {
            default: 1000,
            valueType: "integer",
            minimum: 1,
            maximum: 10_000,
          }),
          value("--timeout-seconds", ["FLOAT"], "Overall timeout from 0.001 through 300 seconds", {
            default: 10,
            valueType: "number",
            minimum: 0.001,
            maximum: 300,
          }),
          value("--archive-start-url", ["URL"], "Optional configured archive start URL", {
            format: "url",
          }),
          value("--archive-entry-selector", ["CSS"], "Required for archive discovery"),
          value("--archive-link-selector", ["CSS"], "Archive entry link selector"),
          value("--archive-date-selector", ["CSS"], "Archive publication date selector"),
          value("--archive-date-attribute", ["NAME"], "Archive date attribute"),
          value("--archive-updated-selector", ["CSS"], "Archive update date selector"),
          value("--archive-next-selector", ["CSS"], "Archive pagination selector"),
          value("--archive-id-attribute", ["NAME"], "Archive stable ID attribute"),
          value("--archive-title-selector", ["CSS"], "Archive title selector"),
          value("--archive-tombstone-selector", ["CSS"], "Archive tombstone selector"),
        ],
        formatOption("Select output", ["json", "yaml"], "json"),
      ),
      constraints: [
        {
          kind: "requires",
          arguments: ["--page", "file"],
          description:
            "--page takes two values, a URL and the recorded file for it, and works only in recorded mode.",
        },
        {
          kind: "conflicts",
          arguments: ["--validator-url", "file"],
          description: "--validator-url is live-mode only.",
        },
        ...archiveRequires([
          "--archive-start-url",
          "--archive-link-selector",
          "--archive-date-selector",
          "--archive-date-attribute",
          "--archive-updated-selector",
          "--archive-next-selector",
          "--archive-id-attribute",
          "--archive-title-selector",
          "--archive-tombstone-selector",
        ]),
      ],
    },
    {
      name: "list-presets",
      summary: "List extraction presets",
      audience: "agent",
      mutates: false,
      guidance:
        "What provider-structured routes exist, by mode. A preset that declares a domain claims the whole host: a URL on that host matching no preset fails rather than falling back to generic extraction.",
      paragraphs: [],
      positionals: [],
      options: commandOptions(),
    },
    {
      name: "show-preset",
      summary: "Show a preset contract",
      audience: "agent",
      mutates: false,
      guidance: "The selectors, URL patterns, and output schema one preset promises.",
      paragraphs: [],
      positionals: [positional("name", "NAME", true, "Preset name")],
      options: commandOptions(),
    },
    {
      name: "validate-preset",
      summary: "Validate a preset contract",
      audience: "operator",
      mutates: false,
      guidance: "Preset authoring: checks one preset file against the shipped schema.",
      paragraphs: [],
      positionals: [
        positional("name_or_path", "NAME_OR_PATH", true, "Preset name or JSON file path"),
      ],
      options: commandOptions(),
    },
    {
      name: "capture-corpus",
      summary: "Capture a versioned content sample",
      audience: "operator",
      mutates: true,
      guidance:
        "Preset development: fetches a page and writes a versioned sample into the corpus. Captured evidence is never hand-edited afterwards.",
      paragraphs: [],
      positionals: [positional("url", "URL", true, "Document URL to capture", { format: "url" })],
      options: commandOptions([
        value("--preset", ["NAME"], "Select a content preset"),
        value("--expect-failure", ["TYPE"], "Capture an expected typed failure"),
        flag("--allow-private-network", "Allow unrestricted browser/private network egress"),
      ]),
    },
    {
      name: "test-corpus",
      summary: "Replay the mode-aware corpus offline",
      audience: "operator",
      mutates: false,
      guidance: "Preset development: replays captured samples with no network.",
      paragraphs: [],
      positionals: [],
      options: commandOptions([
        value("--preset", ["NAME"], "Replay only samples for one preset"),
        value(
          "--expect-failure",
          ["TYPE"],
          "Compatibility option accepted but ignored during replay",
        ),
      ]),
    },
    {
      name: "check-presets",
      summary: "Run configured public canaries",
      audience: "operator",
      // Live canaries drive real browser sessions, so local session state can
      // change; docs/contracts.md records the same verdict.
      mutates: true,
      guidance:
        "Preset maintenance against the live public internet. --live is required because there is no other mode, it spends real provider traffic, and it can change local browser session state; never run it from an agent session or a test.",
      paragraphs: [],
      positionals: [],
      options: commandOptions(
        [
          flag("--live", "Acknowledge live canary execution", {
            required: true,
            inventory: true,
          }),
          value("--preset", ["NAME"], "Select a preset", { repeatable: true }),
          flag("--allow-private-network", "Allow unrestricted browser/private network egress"),
        ],
        formatOption("Select output", ["json", "yaml"], "json"),
      ),
    },
    {
      name: "convert-html",
      summary: "Convert HTML from a file, directory, or stdin",
      audience: "agent",
      mutates: true,
      guidance:
        "Local HTML you already have, converted to Markdown with no network. One FILE, or HTML on stdin, prints to stdout; --dir writes a .md beside every HTML file it converts, which is the mutating path.",
      paragraphs: [],
      positionals: [
        positional("file", "FILE", false, "HTML input file; stdin when omitted", {
          format: "path",
          direction: "in",
        }),
      ],
      options: commandOptions([
        value("--dir", ["DIRECTORY"], "Recursively convert a directory", {
          format: "path",
          direction: "in",
        }),
      ]),
      stdin: {
        accepts: "text",
        required: false,
        description: "HTML to convert, read when neither FILE nor --dir is given.",
      },
      constraints: [
        {
          kind: "conflicts",
          arguments: ["--dir", "file"],
          description: "--dir converts a tree in place and ignores a FILE.",
        },
      ],
    },
    {
      name: "open-session",
      summary: "Pre-warm a browser session",
      audience: "operator",
      mutates: true,
      guidance:
        "Browser sessions are established by the operator; Agentscrape never signs in itself. Once one exists, an agent selects it with --session NAME or AGENTSCRAPE_BROWSER_SESSION.",
      paragraphs: [],
      positionals: [positional("name", "NAME", true, "Browser session name")],
      options: commandOptions(),
    },
    {
      name: "close-session",
      summary: "Close a browser session",
      audience: "operator",
      mutates: true,
      guidance: "Ends an operator-established browser session.",
      paragraphs: [],
      positionals: [positional("name", "NAME", true, "Browser session name")],
      options: commandOptions(),
    },
    {
      name: "process-queue",
      summary: "Process standalone artifact jobs",
      audience: "internal",
      mutates: true,
      guidance:
        "Service machinery: drains the standalone artifact queue under supervision, not from a session.",
      paragraphs: [],
      positionals: [],
      options: commandOptions(),
    },
    {
      name: "mcp",
      summary: "Serve this CLI's agent commands over MCP on stdio",
      audience: "internal",
      mutates: true,
      blocking: true,
      guidance:
        "Serves until the host closes stdio, so it is started by a host's MCP configuration rather than called from a session. The tools are generated from this contract — exactly the agent-audience commands — and every call dispatches in this process, with nothing spawned.",
      paragraphs: [],
      positionals: [],
      options: commandOptions(),
    },
    {
      name: "doctor",
      summary: "Inspect offline runtime readiness and optional capabilities",
      audience: "operator",
      mutates: false,
      guidance:
        "Reports the runtime and which optional capabilities (agent-browser, gh, pandoc) are present. Read it when a route fails with upstream_unavailable.",
      paragraphs: [],
      positionals: [],
      options: commandOptions([], formatOption("Select output", ["human", "json"], "human")),
    },
    {
      name: "guide",
      summary: "Print the fleet agent contract for this CLI",
      audience: "agent",
      mutates: false,
      guidance:
        "--json emits the machine-readable contract every agent* CLI publishes: purpose, routing guidance, concepts, error codes, and every command with its audience, mutation verdict, and typed arguments. Without --json it prints the same document as the runbook --agent-help shows.",
      paragraphs: [],
      positionals: [],
      options: commandOptions([flag("--json", "Emit the machine-readable agent contract")]),
    },
  ],
  hiddenCommands: [
    {
      name: "help",
      summary: "Show root or command help",
      audience: "internal",
      mutates: false,
      guidance: "The bare-word spelling of --help; a caller with argv should pass --help instead.",
      paragraphs: [],
      positionals: [positional("command", "COMMAND", false, "Command to describe")],
      options: commandOptions(),
    },
  ],
} satisfies CliSpec;

function specError(path: string, message: string): never {
  throw new Error(`Invalid CLI spec at ${path}: ${message}`);
}

/**
 * The contract refinements a caller reads as promises: a format that names a
 * closed vocabulary, and a direction that only means anything on a path. A
 * direction on a non-path is silently ignored downstream, which is the kind of
 * miss the contract exists to prevent.
 */
function validateContractRefinement(
  argument: { format?: unknown; direction?: unknown; valueType?: unknown },
  path: string,
): void {
  if (
    argument.format !== undefined &&
    !ARGUMENT_FORMATS.includes(argument.format as ArgumentFormat)
  )
    specError(`${path}.format`, `invalid format '${String(argument.format)}'`);
  if (argument.direction !== undefined) {
    if (argument.direction !== "in" && argument.direction !== "out")
      specError(`${path}.direction`, "must be in or out");
    if (argument.format !== "path")
      specError(`${path}.direction`, "applies only to a path argument");
  }
  if (
    argument.valueType !== undefined &&
    !CONTRACT_SCALARS.includes(argument.valueType as ContractScalar)
  )
    specError(`${path}.valueType`, `invalid contract type '${String(argument.valueType)}'`);
}

function validateOptions(options: readonly OptionSpec[], scope: string): void {
  const spellings = new Map<string, string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index] as OptionSpec & Record<string, unknown>;
    const path = `${scope}.options[${index}]`;
    if (!/^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(option.long))
      specError(`${path}.long`, `invalid long option '${option.long}'`);
    if (typeof option.required !== "boolean") specError(`${path}.required`, "must be a boolean");
    if (typeof option.description !== "string" || option.description.length === 0)
      specError(`${path}.description`, "must be non-empty");
    const names = [option.long, ...(option.aliases ?? [])];
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex]!;
      if (nameIndex > 0 && !/^-[A-Za-z0-9]$/.test(name))
        specError(`${path}.aliases[${nameIndex - 1}]`, `invalid short option '${name}'`);
      const previous = spellings.get(name);
      if (previous) specError(path, `option spelling '${name}' collides with ${previous}`);
      spellings.set(name, path);
    }
    if (option.inventory && option.kind !== "flag")
      specError(`${path}.inventory`, "inventory options must be flags");
    if (option.role !== undefined && !ARGUMENT_ROLES.includes(option.role as ArgumentRole))
      specError(`${path}.role`, `invalid role '${String(option.role)}'`);
    validateContractRefinement(option, path);
    if (option.kind === "flag") {
      for (const property of ["valueCount", "valueLabels", "choices", "default"])
        if (property in option) specError(path, `flag ${option.long} must not define ${property}`);
      if ("repeatable" in option) specError(path, `flag ${option.long} must not define repeatable`);
      continue;
    }
    if (option.valueCount !== 1 && option.valueCount !== 2)
      specError(`${path}.valueCount`, "must be 1 or 2");
    if (!Array.isArray(option.valueLabels) || option.valueLabels.length !== option.valueCount)
      specError(`${path}.valueLabels`, `must contain exactly ${option.valueCount} labels`);
    for (let labelIndex = 0; labelIndex < option.valueLabels.length; labelIndex += 1) {
      const label = option.valueLabels[labelIndex];
      if (typeof label !== "string" || label.length === 0)
        specError(`${path}.valueLabels[${labelIndex}]`, "must be non-empty");
    }
    if (option.repeatable !== undefined && option.repeatable !== true)
      specError(`${path}.repeatable`, "must be true when present");
    if (option.csv !== undefined && option.csv !== true)
      specError(`${path}.csv`, "must be true when present");
    // A bound belongs to a number. Declaring one on a string would publish a
    // rule the parser does not enforce, which is the exact drift this spec
    // exists to prevent — the same reason the bounds are authored here at all
    // rather than only in the description prose.
    for (const bound of ["minimum", "maximum"] as const) {
      const bounded = option[bound];
      if (bounded === undefined) continue;
      if (typeof bounded !== "number" || !Number.isFinite(bounded))
        specError(`${path}.${bound}`, "must be a finite number");
      if (option.valueType !== "integer" && option.valueType !== "number")
        specError(`${path}.${bound}`, "applies only to an integer or number option");
    }
    const minimum = option.minimum as number | undefined;
    const maximum = option.maximum as number | undefined;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      specError(`${path}.maximum`, "must not be below minimum");
    if (option.choices !== undefined) {
      if (option.valueCount !== 1)
        specError(`${path}.choices`, "are valid only for one-value options");
      if (!Array.isArray(option.choices) || option.choices.length === 0)
        specError(`${path}.choices`, "must be a non-empty array");
      const choices = new Set<string>();
      for (let choiceIndex = 0; choiceIndex < option.choices.length; choiceIndex += 1) {
        const choice = option.choices[choiceIndex];
        if (typeof choice !== "string" || choice.length === 0)
          specError(`${path}.choices[${choiceIndex}]`, "must be non-empty");
        if (choices.has(choice))
          specError(`${path}.choices[${choiceIndex}]`, `duplicate choice '${choice}'`);
        choices.add(choice);
      }
      if (option.default !== undefined && !choices.has(String(option.default)))
        specError(`${path}.default`, "must be one of the declared choices");
    }
    if (option.valueCount === 2 && option.default !== undefined)
      specError(`${path}.default`, "two-value options cannot have a default");
    if (option.required && option.default !== undefined)
      specError(`${path}.default`, "required options cannot have a default");
  }
}

function validateCommand(command: CommandSpec, path: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(command.name))
    specError(`${path}.name`, `invalid command name '${command.name}'`);
  if (typeof command.summary !== "string" || command.summary.length === 0)
    specError(`${path}.summary`, "must be non-empty");
  if (!COMMAND_AUDIENCES.includes(command.audience))
    specError(`${path}.audience`, `invalid audience '${String(command.audience)}'`);
  if (typeof command.mutates !== "boolean") specError(`${path}.mutates`, "must be a boolean");
  if (command.blocking !== undefined && command.blocking !== true)
    specError(`${path}.blocking`, "must be true when present");
  if (command.guidance !== undefined && command.guidance.length === 0)
    specError(`${path}.guidance`, "must be non-empty when present");
  for (let index = 0; index < command.paragraphs.length; index += 1)
    if (!command.paragraphs[index]) specError(`${path}.paragraphs[${index}]`, "must be non-empty");
  const names = new Set<string>();
  let optionalSeen = false;
  for (let index = 0; index < command.positionals.length; index += 1) {
    const positionalSpec = command.positionals[index] as PositionalSpec & Record<string, unknown>;
    const positionalPath = `${path}.positionals[${index}]`;
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(positionalSpec.name))
      specError(`${positionalPath}.name`, `invalid positional name '${positionalSpec.name}'`);
    if (names.has(positionalSpec.name))
      specError(`${positionalPath}.name`, `duplicate positional '${positionalSpec.name}'`);
    names.add(positionalSpec.name);
    if (!/^[A-Z][A-Z0-9_]*$/.test(positionalSpec.displayName))
      specError(`${positionalPath}.displayName`, "must be an uppercase usage label");
    if (positionalSpec.type !== "text") specError(`${positionalPath}.type`, "must be text");
    if (typeof positionalSpec.required !== "boolean")
      specError(`${positionalPath}.required`, "must be a boolean");
    if (typeof positionalSpec.description !== "string")
      specError(`${positionalPath}.description`, "must be a string");
    if (optionalSeen && positionalSpec.required)
      specError(positionalPath, "required positionals cannot follow optional positionals");
    if (!positionalSpec.required) optionalSeen = true;
    if (positionalSpec.repeatable !== undefined && positionalSpec.repeatable !== true)
      specError(`${positionalPath}.repeatable`, "must be true when present");
    if (positionalSpec.repeatable && index !== command.positionals.length - 1)
      specError(positionalPath, "a repeatable positional must be last");
    validateContractRefinement(positionalSpec, positionalPath);
  }
  validateOptions(command.options, path);
  validateStdin(command, path);
  validateConstraints(command, path, names);
}

function validateStdin(command: CommandSpec, path: string): void {
  const stdin = command.stdin;
  if (stdin === undefined) return;
  if (stdin.accepts !== "text" && stdin.accepts !== "json")
    specError(`${path}.stdin.accepts`, "must be text or json");
  if (typeof stdin.description !== "string" || stdin.description.length === 0)
    specError(`${path}.stdin.description`, "must be non-empty");
  if (stdin.required !== undefined && typeof stdin.required !== "boolean")
    specError(`${path}.stdin.required`, "must be a boolean when present");
  // An out-of-process caller has no pipe, so a required stdin makes an agent
  // verb unreachable; accept the same content through an argument as well.
  if (stdin.required === true && command.audience === "agent")
    specError(`${path}.stdin.required`, "an agent command cannot require standard input");
}

function validateConstraints(
  command: CommandSpec,
  path: string,
  positionalNames: ReadonlySet<string>,
): void {
  const constraints = command.constraints ?? [];
  const declared = new Set<string>([
    ...positionalNames,
    ...command.options.map((option) => option.long),
  ]);
  for (let index = 0; index < constraints.length; index += 1) {
    const constraint = constraints[index]!;
    const constraintPath = `${path}.constraints[${index}]`;
    if (!CONSTRAINT_KINDS.includes(constraint.kind))
      specError(`${constraintPath}.kind`, `invalid constraint kind '${String(constraint.kind)}'`);
    if (!Array.isArray(constraint.arguments) || constraint.arguments.length < 2)
      specError(`${constraintPath}.arguments`, "must relate at least two arguments");
    // A constraint naming an argument the command does not accept is a silent
    // no-op, which is worse than an error.
    for (const name of constraint.arguments)
      if (!declared.has(name))
        specError(`${constraintPath}.arguments`, `names undeclared argument '${name}'`);
    if (constraint.required !== undefined && constraint.kind !== "one_of")
      specError(`${constraintPath}.required`, "applies only to one_of");
  }
}

export function validateCliSpec(spec: CliSpec): void {
  if (typeof spec.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(spec.name))
    specError("root.name", "must be a lowercase CLI name");
  if (typeof spec.version !== "string" || spec.version.length === 0)
    specError("root.version", "must be non-empty");
  if (typeof spec.description !== "string" || spec.description.length === 0)
    specError("root.description", "must be non-empty");
  validateOptions(spec.globalOptions, "root.global");
  const names = new Map<string, string>();
  const groups: ReadonlyArray<readonly [string, readonly CommandSpec[]]> = [
    ["commands", spec.commands],
    ["hiddenCommands", spec.hiddenCommands],
  ];
  for (const [groupName, commands] of groups) {
    for (let index = 0; index < commands.length; index += 1) {
      const path = `root.${groupName}[${index}]`;
      const command = commands[index]!;
      const previous = names.get(command.name);
      if (previous)
        specError(`${path}.name`, `command '${command.name}' collides with ${previous}`);
      names.set(command.name, path);
      validateCommand(command, path);
    }
  }
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

validateCliSpec(rawCliSpec);
export const CLI_SPEC: ReadonlyCliSpec = deepFreeze(rawCliSpec);

export function findVisibleCommandSpec(name: string): ReadonlyCommandSpec | undefined {
  return CLI_SPEC.commands.find((command) => command.name === name);
}

export function findCommandSpec(name: string): ReadonlyCommandSpec | undefined {
  return (
    findVisibleCommandSpec(name) ?? CLI_SPEC.hiddenCommands.find((command) => command.name === name)
  );
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

interface ParsedOption {
  readonly name: string;
  readonly items: readonly string[];
  readonly nextIndex: number;
}

export interface ParsedGlobalOption extends ParsedOption {}

function optionLookup(options: readonly ReadonlyOptionSpec[]): Map<string, ReadonlyOptionSpec> {
  const result = new Map<string, ReadonlyOptionSpec>();
  for (const option of options) {
    result.set(option.long, option);
    for (const alias of option.aliases ?? []) result.set(alias, option);
  }
  return result;
}

function splitOptionToken(token: string): { rawName: string; attached?: string } {
  const separator = token.indexOf("=");
  return separator < 0
    ? { rawName: token }
    : { rawName: token.slice(0, separator), attached: token.slice(separator + 1) };
}

function parseOptionAt(
  args: readonly string[],
  index: number,
  options: readonly ReadonlyOptionSpec[],
  singularArticle: boolean,
): ParsedOption {
  const token = args[index]!;
  const { rawName, attached } = splitOptionToken(token);
  const option = optionLookup(options).get(rawName);
  if (!option) throw new AgentscrapeUsageError(`unknown option '${rawName}'`);
  if (option.kind === "flag") {
    if (attached !== undefined)
      throw new AgentscrapeUsageError(`${option.long} does not take a value`);
    return { name: option.long, items: [], nextIndex: index + 1 };
  }
  const items: string[] = [];
  if (attached !== undefined) items.push(attached);
  let nextIndex = index + 1;
  while (items.length < option.valueCount) {
    const item = args[nextIndex];
    if (item === undefined) {
      const requirement =
        singularArticle && option.valueCount === 1
          ? "a value"
          : `${option.valueCount} value${option.valueCount === 1 ? "" : "s"}`;
      throw new AgentscrapeUsageError(`${option.long} requires ${requirement}`);
    }
    items.push(item);
    nextIndex += 1;
  }
  return { name: option.long, items, nextIndex };
}

function listChoices(choices: readonly string[]): string {
  if (choices.length === 1) return choices[0]!;
  if (choices.length === 2) return `${choices[0]} or ${choices[1]}`;
  return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}

function validateGenericFormat(items: readonly string[]): void {
  if (items.length === 0) return;
  const option = CLI_SPEC.globalOptions.find((candidate) => candidate.long === "--format");
  const choices = option?.kind === "value" ? option.choices : undefined;
  if (!choices) throw new Error("Invalid CLI spec at root.global: --format must define choices");
  for (const item of items)
    if (!choices.includes(item.toLowerCase()))
      throw new AgentscrapeUsageError(`--format must be ${listChoices(choices)}`);
}

export function parseArgs(command: string, args: readonly string[]): ParsedArgs {
  const commandSpec = findCommandSpec(command);
  if (!commandSpec) throw new AgentscrapeUsageError(`unknown command '${command}'`);
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      index += 1;
      continue;
    }
    const parsed = parseOptionAt(args, index, commandSpec.options, false);
    if (parsed.items.length === 0) flags.add(parsed.name);
    else values.set(parsed.name, [...(values.get(parsed.name) ?? []), ...parsed.items]);
    index = parsed.nextIndex;
  }
  validateGenericFormat(values.get("--format") ?? []);
  return { positionals, values, flags };
}

export function parseGlobalOption(argv: readonly string[], index: number): ParsedGlobalOption {
  const token = argv[index];
  if (token === undefined || !token.startsWith("-"))
    throw new Error(`parseGlobalOption expected an option at index ${index}`);
  const parsed = parseOptionAt(argv, index, CLI_SPEC.globalOptions, true);
  if (parsed.name === "--format") validateGenericFormat(parsed.items);
  return parsed;
}

function optionSyntax(option: ReadonlyOptionSpec, includeAliases = true): string {
  const names = [...(includeAliases ? (option.aliases ?? []) : []), option.long].join(", ");
  if (option.kind === "flag") return names;
  const values = option.choices?.join("|") ?? option.valueLabels.join(" ");
  return `${names} ${values}`;
}

function positionalSyntax(positionalSpec: DeepReadonly<PositionalSpec>): string {
  const label = positionalSpec.repeatable
    ? `${positionalSpec.displayName}...`
    : positionalSpec.displayName;
  return positionalSpec.required ? label : `[${label}]`;
}

function optionDescription(option: ReadonlyOptionSpec): string {
  const details = [
    option.default !== undefined ? `default: ${option.default}` : undefined,
    option.required ? "required" : undefined,
    option.kind === "value" && option.repeatable ? "repeatable" : undefined,
  ].filter((item): item is string => item !== undefined);
  return details.length ? `${option.description} (${details.join("; ")})` : option.description;
}

function optionRows(options: readonly ReadonlyOptionSpec[]): string {
  const rows = options.map((option) => [optionSyntax(option), optionDescription(option)] as const);
  const width = Math.max(...rows.map(([syntax]) => syntax.length));
  return rows
    .map(([syntax, description]) => `  ${syntax.padEnd(width)}  ${description}`)
    .join("\n");
}

function commandUsage(command: ReadonlyCommandSpec): string {
  const positionals = command.positionals.map(positionalSyntax);
  const requiredOptions = command.options
    .filter((option) => option.required)
    .map((option) => optionSyntax(option, false));
  return [CLI_SPEC.name, command.name, ...positionals, ...requiredOptions, "[OPTIONS]"].join(" ");
}

function inventoryUsage(command: ReadonlyCommandSpec): string {
  const positionals = command.positionals.map(positionalSyntax);
  const inventoryOptions = command.options
    .filter((option) => option.inventory)
    .map((option) => optionSyntax(option, false));
  return [command.name, ...positionals, ...inventoryOptions].join(" ");
}

export function renderHumanHelp(commandName?: string): string {
  if (commandName !== undefined) {
    const command = findCommandSpec(commandName);
    if (!command) throw new AgentscrapeUsageError(`unknown command '${commandName}'`);
    const paragraphs = command.paragraphs.length ? `\n\n${command.paragraphs.join("\n\n")}` : "";
    return `Usage: ${commandUsage(command)}${paragraphs}\n\nOptions:\n${optionRows(command.options)}\n`;
  }
  const format = CLI_SPEC.globalOptions.find((option) => option.long === "--format");
  if (!format) throw new Error("Invalid CLI spec at root.global: missing --format");
  const commands = CLI_SPEC.commands
    .map((command) => `  ${inventoryUsage(command).padEnd(35)} ${command.summary}`)
    .join("\n");
  return `${CLI_SPEC.name} — ${CLI_SPEC.description}\n\nUsage: ${CLI_SPEC.name} [${optionSyntax(format, false)}] COMMAND [OPTIONS]\n\nCommands:\n${commands}\n\nGlobal options:\n${optionRows(CLI_SPEC.globalOptions)}\n\nRun ${CLI_SPEC.name} --agent-help for the agent runbook.\n`;
}

export interface JsonArgument {
  readonly name: string;
  readonly type: "flag" | "text";
  readonly required: boolean;
  readonly description: string;
  readonly positional?: true;
  readonly aliases?: readonly string[];
  readonly value_count?: 2;
  readonly repeatable?: true;
  readonly choices?: readonly string[];
  readonly default?: string | number;
}

function positionalJson(positionalSpec: DeepReadonly<PositionalSpec>): JsonArgument {
  return {
    name: positionalSpec.name,
    type: positionalSpec.type,
    required: positionalSpec.required,
    description: positionalSpec.description,
    positional: true,
    ...(positionalSpec.repeatable ? { repeatable: true as const } : {}),
  };
}

function optionJson(option: ReadonlyOptionSpec): JsonArgument {
  return {
    name: option.long,
    type: option.kind === "flag" ? "flag" : "text",
    required: option.required,
    description: option.description,
    ...(option.aliases ? { aliases: [...option.aliases] } : {}),
    ...(option.kind === "value" && option.valueCount === 2 ? { value_count: 2 as const } : {}),
    ...(option.kind === "value" && option.repeatable ? { repeatable: true as const } : {}),
    ...(option.kind === "value" && option.choices ? { choices: [...option.choices] } : {}),
    ...(option.kind === "value" && option.default !== undefined ? { default: option.default } : {}),
  };
}

export function jsonHelp(commandName?: string): Record<string, unknown> {
  if (commandName !== undefined) {
    const command = findCommandSpec(commandName);
    if (!command) throw new AgentscrapeUsageError(`unknown command '${commandName}'`);
    return {
      name: command.name,
      description: command.summary,
      arguments: [...command.positionals.map(positionalJson), ...command.options.map(optionJson)],
    };
  }
  return {
    name: CLI_SPEC.name,
    description: CLI_SPEC.description,
    arguments: CLI_SPEC.globalOptions.map(optionJson),
    commands: CLI_SPEC.commands.map((command) => ({
      name: command.name,
      description: command.summary,
    })),
  };
}

export function renderJsonHelp(commandName?: string): string {
  return JSON.stringify(jsonHelp(commandName), null, 2);
}

export function renderAgentTeaser(): string {
  return `${CLI_SPEC.description}\n\n${CLI_SPEC.commands
    .map((command) => `  ${inventoryUsage(command).padEnd(35)} ${command.summary}`)
    .join("\n")}\n\nRun ${CLI_SPEC.name} COMMAND --help for argument details.`;
}

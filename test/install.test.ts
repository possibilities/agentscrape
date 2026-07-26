import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sourceRoot = join(import.meta.dir, "..");
let root = sourceRoot;
const temporary: string[] = [];
const suiteTemporary: string[] = [];
let suiteCheckoutParent = "";
let suiteProductionTemplate = "";
let suitePreviousCheckout = "";
const suiteSnapshotTemplates: Array<{ kind: "current" | "previous"; sha: string; root: string }> =
  [];
const suiteFastSnapshotTemplates: Array<{
  kind: "current" | "previous";
  sha: string;
  root: string;
}> = [];

function configuredAgentbuildsCheckout(): string | null {
  const configured = process.env.AGENTSCRAPE_AGENTBUILDS_ROOT;
  if (!configured || process.platform !== "darwin") return null;
  try {
    const exact = realpathSync(configured);
    const top = Bun.spawnSync(["git", "-C", exact, "rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0 || new TextDecoder().decode(top.stdout).trim() !== exact) return null;
    if (!existsSync(join(exact, ".venv/bin/python"))) return null;
    return exact;
  } catch {
    return null;
  }
}

const agentbuildsRoot = configuredAgentbuildsCheckout();
const agentbuildsIntegrationTest = agentbuildsRoot ? test : test.skip;

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const path of suiteTemporary.splice(0)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
  if (suiteCheckoutParent) {
    makeWritable(suiteCheckoutParent);
    rmSync(suiteCheckoutParent, { recursive: true, force: true });
  }
});

function temp(prefix: string, persistent = false): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  (persistent ? suiteTemporary : temporary).push(path);
  return path;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

async function command(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const phaseFiles = [
  "scripts/install.sh",
  "scripts/runtime-snapshot.ts",
  "src/corpus.ts",
  "test/install.test.ts",
  "test/corpus.test.ts",
  "test/core.test.ts",
  "README.md",
  "docs/migration/standalone.md",
] as const;

async function committedPhaseCheckout(): Promise<string> {
  const parent = temp("agentscrape-phase-checkout-");
  const checkout = join(parent, "agentscrape");
  const cloned = await command(["git", "clone", "--quiet", "--shared", root, checkout]);
  expect(cloned.code).toBe(0);
  for (const relative of phaseFiles) {
    const destination = join(checkout, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, relative), destination);
  }
  const committed = await command(
    [
      "git",
      "-C",
      checkout,
      "-c",
      "user.name=Agentscrape Test",
      "-c",
      "user.email=agentscrape-test@example.invalid",
      "add",
      "--all",
    ],
    { cwd: checkout },
  );
  expect(committed.code).toBe(0);
  const commit = await command(
    [
      "git",
      "-C",
      checkout,
      "-c",
      "user.name=Agentscrape Test",
      "-c",
      "user.email=agentscrape-test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "phase fixture",
    ],
    { cwd: checkout },
  );
  expect(commit.code).toBe(0);
  return realpathSync(checkout);
}

async function previousCheckout(persistent = false): Promise<string> {
  const parent = temp("agentscrape-prior-checkout-", persistent);
  const checkout = join(parent, "agentscrape");
  const cloned = await command([
    "git",
    "clone",
    "--quiet",
    "--shared",
    suitePreviousCheckout,
    checkout,
  ]);
  expect(cloned.code).toBe(0);
  const remote = await command([
    "git",
    "-C",
    checkout,
    "remote",
    "set-url",
    "origin",
    "https://github.com/possibilities/agentscrape.git/",
  ]);
  expect(remote.code).toBe(0);
  return realpathSync(checkout);
}

function copyTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
}

function preseedSuiteSnapshots(
  home: string,
  includePrevious: boolean,
  fullSnapshots: boolean,
): void {
  const templates = (fullSnapshots ? suiteSnapshotTemplates : suiteFastSnapshotTemplates).filter(
    (template) => template.kind === "current" || includePrevious,
  );
  if (!templates.length) return;
  const local = join(home, ".local");
  const stateParent = join(local, "state");
  const state = join(stateParent, "agentscrape");
  const runtime = join(state, "runtime");
  for (const path of [local, stateParent, state, runtime]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const template of templates) copyTree(template.root, join(runtime, template.sha));
}

function installEnv(
  overrides: Record<string, string | undefined> = {},
  options: {
    preseedSnapshots?: boolean;
    preseedPreviousSnapshot?: boolean;
    fastSnapshotVerification?: boolean;
    fullSnapshots?: boolean;
    persistent?: boolean;
  } = {},
) {
  const home = temp("agentscrape-install-home-", options.persistent);
  const tools = temp("agentscrape-install-tools-", options.persistent);
  const state = temp("agentscrape-install-launchctl-", options.persistent);
  const bunLog = join(state, "bun.log");
  const plutilLog = join(state, "plutil.log");
  const launchctlLog = join(state, "launchctl.log");
  const serviceState = join(state, "service.env");

  mkdirSync(tools, { recursive: true });
  writeExecutable(
    join(tools, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-e" && "\${2:-}" == *fsyncSync* ]]; then
  printf 'fsync-event %s %s\n' "\${3:-}" "\${4:-}" >>"$AGENTSCRAPE_FAKE_BUN_LOG"
  if [[ -n "\${FAKE_BUN_FSYNC_FAIL_PATH:-}" && "\${4:-}" == "$FAKE_BUN_FSYNC_FAIL_PATH" ]]; then
    exit 74
  fi
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [[ $# -eq 4 && "\${1:-}" == "-e" && "\${2:-}" == *fstatSync* ]]; then
  printf 'fstat-event %s\n' "\${4:-}" >>"$AGENTSCRAPE_FAKE_BUN_LOG"
  cmp -s "/dev/fd/\${3:-}" "\${4:-}"
  exit $?
fi
printf '%s\n' "$*" >>"$AGENTSCRAPE_FAKE_BUN_LOG"
if [[ "\${1:-}" == "install" && -n "\${FAKE_BUN_INSTALL_DELAY:-}" ]]; then
  sleep "$FAKE_BUN_INSTALL_DELAY"
fi
if [[ "\${2:-}" == "verify" && "\${AGENTSCRAPE_FAKE_FAST_SNAPSHOT_VERIFY:-0}" == "1" &&
  ":$AGENTSCRAPE_FAKE_FAST_SNAPSHOT_SHAS:" == *":\${4:-}:"* ]]; then
  exit 0
fi
if [[ $# -eq 5 && "\${1:-}" == "install" && "\${2:-}" == "--frozen-lockfile" &&
  "\${3:-}" == "--production" && "\${4:-}" == "--ignore-scripts" &&
  "\${5:-}" == "--backend=copyfile" ]]; then
  [[ -d "$AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE/node_modules" && ! -e node_modules ]]
  case "$(uname -s)" in
    Darwin)
      /bin/cp -cR "$AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE/node_modules" node_modules
      ;;
    Linux)
      if ! /bin/cp --reflink=auto -R "$AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE/node_modules" node_modules 2>/dev/null; then
        /bin/cp -R "$AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE/node_modules" node_modules
      fi
      ;;
    *)
      /bin/cp -R "$AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE/node_modules" node_modules
      ;;
  esac
  if [[ -n "\${FAKE_BUN_INSTALL_EXIT_AFTER_COPY:-}" ]]; then
    exit "$FAKE_BUN_INSTALL_EXIT_AFTER_COPY"
  fi
  exit 0
fi
if [[ "\${2:-}" == "publish" && -n "\${FAKE_BUN_PUBLISH_RACE_TARGET:-}" &&
  "\${4:-}" == "$FAKE_BUN_PUBLISH_RACE_TARGET" &&
  ! -e "\${AGENTSCRAPE_FAKE_BUN_LOG}.publish-raced" ]]; then
  mkdir "$FAKE_BUN_PUBLISH_RACE_TARGET"
  printf 'foreign target\n' >"$FAKE_BUN_PUBLISH_RACE_TARGET/foreign.txt"
  : >"\${AGENTSCRAPE_FAKE_BUN_LOG}.publish-raced"
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  writeExecutable(
    join(tools, "plutil"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$AGENTSCRAPE_FAKE_PLUTIL_LOG"
[[ "\${1:-}" == "-lint" ]] || exit 1
[[ -f "\${2:-}" ]] || exit 1
grep -q '<plist version="1.0">' "$2"
`,
  );
  writeExecutable(
    join(tools, "launchctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$AGENTSCRAPE_FAKE_LAUNCHCTL_LOG"
state_file="$AGENTSCRAPE_FAKE_LAUNCHCTL_STATE"
fail_once_file="\${AGENTSCRAPE_FAKE_LAUNCHCTL_STATE}.bootstrap-failed-once"
extract() {
  local file="$1" key="$2"
  awk -v key="$2" '
    $0 ~ "<key>" key "</key>" {
      while (getline) {
        if ($0 ~ /<string>/) {
          gsub(/^.*<string>|<\\/string>.*$/, "")
          print
          exit
        }
      }
    }
  ' "$1"
}
case "\${1:-}" in
  bootstrap)
    [[ $# -eq 3 ]] || exit 1
    # Real launchctl does not accept bootstrapping the same loaded label again.
    [[ ! -f "$state_file" ]] || exit 37
    if [[ -n "\${FAKE_LAUNCHCTL_REMOVE_PATH_ON_BOOTSTRAP:-}" &&
      ! -e "\${AGENTSCRAPE_FAKE_LAUNCHCTL_STATE}.removed-path-once" ]]; then
      /bin/rm -rf "$FAKE_LAUNCHCTL_REMOVE_PATH_ON_BOOTSTRAP"
      : >"\${AGENTSCRAPE_FAKE_LAUNCHCTL_STATE}.removed-path-once"
    fi
    if [[ "\${FAKE_LAUNCHCTL_FAIL_BOOTSTRAP_ONCE:-0}" == "1" && ! -e "$fail_once_file" ]]; then
      : >"$fail_once_file"
      exit 1
    fi
    plist="$3"
    label="$(extract "$plist" Label)"
    program="$(extract "$plist" ProgramArguments)"
    path_value="$(extract "$plist" PATH)"
    {
      printf 'domain=%s\n' "$2"
      printf 'label=%s\n' "$label"
      printf 'program=%s\n' "$program"
      printf 'path=%s\n' "$path_value"
      printf 'plist=%s\n' "$plist"
    } >"$state_file"
    ;;
  print)
    [[ $# -eq 2 ]] || exit 1
    if [[ "\${FAKE_LAUNCHCTL_FAIL_PRINT:-0}" == "1" ]]; then
      printf 'transient launchctl failure\n' >&2
      exit 75
    fi
    if [[ ! -f "$state_file" ]]; then
      target="\${2#gui/}"
      uid="\${target%%/*}"
      label="\${target#*/}"
      printf 'Bad request.\n' >&2
      printf 'Could not find service "%s" in domain for user gui: %s\n' "$label" "$uid" >&2
      exit 113
    fi
    source "$state_file"
    [[ "$2" == "$domain/$label" ]] || exit 1
    if [[ "\${FAKE_LAUNCHCTL_FOREIGN_PRINT:-0}" == "1" ]]; then
      printf 'program = /tmp/foreign-agentscrape\n'
      printf 'path = /tmp/foreign-agentscrape.process-queue.plist\n'
      printf 'environment = { PATH => /tmp/foreign-bin }\n'
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_FORGED_PRINT:-0}" == "1" ]]; then
      printf 'program = %s-forged\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = { PATH => %s }\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_WRONG_PATH_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = { PATH => %s:/tmp/forged }\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_WRONG_PLIST_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s-forged\n' "$plist"
      printf 'environment = { PATH => %s }\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_DUPLICATE_PROGRAM_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = { PATH => %s }\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_DUPLICATE_PATH_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = { PATH => %s }\n' "$path"
      printf 'environment = { PATH => %s }\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_BASH_ENV_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = {\n  PATH => %s\n  BASH_ENV => /tmp/foreign\n}\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_NODE_OPTIONS_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = {\n  PATH => %s\n  NODE_OPTIONS => --require=/tmp/foreign\n}\n' "$path"
      exit 0
    fi
    if [[ "\${FAKE_LAUNCHCTL_DUPLICATE_UNKNOWN_PRINT:-0}" == "1" ]]; then
      printf 'program = %s\n' "$program"
      printf 'path = %s\n' "$plist"
      printf 'environment = {\n  PATH => %s\n  FOREIGN => one\n  FOREIGN => two\n}\n' "$path"
      exit 0
    fi
    printf 'service = %s\n' "$domain/$label"
    printf 'program = %s\n' "$program"
    printf 'path = %s\n' "$plist"
    printf 'default environment = {\n'
    printf '  PATH => /usr/bin:/bin:/usr/sbin:/sbin\n'
    printf '}\n'
    printf 'environment = {\n'
    printf '  PATH => %s\n' "$path"
    printf '}\n'
    ;;
  bootout)
    [[ $# -eq 2 ]] || exit 1
    if [[ "\${FAKE_LAUNCHCTL_FAIL_BOOTOUT:-0}" == "1" ]]; then
      printf 'transient bootout failure\n' >&2
      exit 75
    fi
    if [[ ! -f "$state_file" ]]; then
      exit 0
    fi
    source "$state_file"
    [[ "$2" == "$domain/$label" ]] || exit 1
    rm -f "$state_file"
    ;;
  *)
    echo "unsupported fake launchctl command: \${1:-}" >&2
    exit 1
    ;;
esac
`,
  );

  const preseedSnapshots = options.preseedSnapshots !== false;
  const fullSnapshots =
    options.fullSnapshots === true || options.fastSnapshotVerification === false;
  if (preseedSnapshots)
    preseedSuiteSnapshots(home, options.preseedPreviousSnapshot === true, fullSnapshots);

  const env: Record<string, string | undefined> = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGENTSCRAPE_FAKE_BUN_LOG: bunLog,
    AGENTSCRAPE_FAKE_PLUTIL_LOG: plutilLog,
    AGENTSCRAPE_FAKE_LAUNCHCTL_LOG: launchctlLog,
    AGENTSCRAPE_FAKE_LAUNCHCTL_STATE: serviceState,
    AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE: suiteProductionTemplate,
    AGENTSCRAPE_FAKE_FAST_SNAPSHOT_VERIFY:
      preseedSnapshots && options.fastSnapshotVerification !== false ? "1" : "0",
    AGENTSCRAPE_FAKE_FAST_SNAPSHOT_SHAS: suiteSnapshotTemplates
      .map((template) => template.sha)
      .join(":"),
    ...overrides,
  };

  return { home, tools, state, bunLog, plutilLog, launchctlLog, serviceState, env };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function seedCheckoutInstallation(
  fixture: ReturnType<typeof installEnv>,
  checkout: string,
  format: "current" | "legacy" = "current",
): Promise<void> {
  const shaResult = await command([
    "git",
    "-C",
    checkout,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  expect(shaResult.code, shaResult.stderr).toBe(0);
  const sha = shaResult.stdout.trim();
  const commandPath = join(fixture.home, ".local/bin/agentscrape");
  const service = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
  const state = join(fixture.home, ".local/state/agentscrape");
  const share = join(fixture.home, ".local/share/agentscrape");
  for (const directory of [
    dirname(commandPath),
    dirname(service),
    state,
    share,
    join(share, "queue"),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const canonicalState = realpathSync(state);
  const canonicalShare = realpathSync(share);
  const source = join(checkout, "src/cli.ts");
  const bun = join(fixture.tools, "bun");
  const queue = join(canonicalShare, "queue");
  const log = join(canonicalState, "process-queue.log");
  const servicePath = `${dirname(bun)}:${dirname(commandPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  writeFileSync(
    commandPath,
    `#!/usr/bin/env bash\nset -euo pipefail\n# agentscrape-installer-owned: agentscrape.command.v1\n# label: agentscrape.process-queue\n# source-root: ${checkout}\n# source-sha: ${sha}\n# bun: ${bun}\nexport AGENTSCRAPE_DATA_HOME=${shellQuote(canonicalShare)}\nexec ${shellQuote(bun)} ${shellQuote(source)} "$@"\n`,
  );
  chmodSync(commandPath, 0o755);
  const plist = text(join(checkout, "plist/agentscrape.process-queue.plist"))
    .replace(/\n$/, "")
    .replaceAll("__AGENTSCRAPE_PROGRAM__", xmlEscape(commandPath))
    .replaceAll("__AGENTSCRAPE_PATH__", xmlEscape(servicePath))
    .replaceAll("__AGENTSCRAPE_QUEUE__", xmlEscape(queue))
    .replaceAll("__AGENTSCRAPE_LOG__", xmlEscape(log));
  writeFileSync(service, plist);
  chmodSync(service, 0o600);
  const receiptLines = [
    "marker=agentscrape-installer-owned: agentscrape.install-receipt.v1",
    "label=agentscrape.process-queue",
    `root=${checkout}`,
    `source=${source}`,
    `bun=${bun}`,
    `command=${commandPath}`,
    `service=${service}`,
    ...(format === "current"
      ? [`share=${canonicalShare}`, `queue=${queue}`, `log=${log}`, `path=${servicePath}`]
      : []),
    `sha=${sha}`,
  ];
  writeFileSync(join(canonicalState, "install-receipt"), `${receiptLines.join("\n")}\n`);
  writeFileSync(join(canonicalState, "deployed-sha"), `${sha}\n`);
  writeFileSync(log, "");
  for (const path of [
    join(canonicalState, "install-receipt"),
    join(canonicalState, "deployed-sha"),
    log,
  ])
    chmodSync(path, 0o600);
  const loaded = await command(
    [join(fixture.tools, "launchctl"), "bootstrap", `gui/${process.getuid?.() ?? 0}`, service],
    { env: fixture.env },
  );
  expect(loaded.code, loaded.stderr).toBe(0);
}

beforeAll(async () => {
  suiteCheckoutParent = mkdtempSync(join(tmpdir(), "agentscrape-suite-checkout-"));
  const checkout = join(suiteCheckoutParent, "agentscrape");
  const cloned = await command(["git", "clone", "--quiet", "--shared", sourceRoot, checkout]);
  expect(cloned.code).toBe(0);
  for (const relative of phaseFiles) {
    const destination = join(checkout, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(sourceRoot, relative), destination);
  }
  const landed = await command(
    [
      "git",
      "-C",
      checkout,
      "-c",
      "user.name=Agentscrape Test",
      "-c",
      "user.email=agentscrape-test@example.invalid",
      "add",
      "--all",
    ],
    { cwd: checkout },
  );
  expect(landed.code).toBe(0);
  const committed = await command(
    [
      "git",
      "-C",
      checkout,
      "-c",
      "user.name=Agentscrape Test",
      "-c",
      "user.email=agentscrape-test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "land installer phase fixture",
    ],
    { cwd: checkout },
  );
  expect(committed.code).toBe(0);
  root = realpathSync(checkout);

  suitePreviousCheckout = join(suiteCheckoutParent, "previous-checkout");
  const previousClone = await command([
    "git",
    "clone",
    "--quiet",
    "--shared",
    root,
    suitePreviousCheckout,
  ]);
  expect(previousClone.code, previousClone.stderr).toBe(0);
  const previousRemote = await command([
    "git",
    "-C",
    suitePreviousCheckout,
    "remote",
    "set-url",
    "origin",
    "https://github.com/possibilities/agentscrape.git/",
  ]);
  expect(previousRemote.code, previousRemote.stderr).toBe(0);
  suitePreviousCheckout = realpathSync(suitePreviousCheckout);

  const currentCommit = await command([
    "git",
    "-C",
    root,
    "-c",
    "user.name=Agentscrape Test",
    "-c",
    "user.email=agentscrape-test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "advance current authority beyond legacy fixture",
  ]);
  expect(currentCommit.code, currentCommit.stderr).toBe(0);

  // Production dependency resolution is intentionally paid once for the whole installer suite.
  // Every fake install below copies/reflinks this sealed tree into a fresh snapshot with distinct
  // regular-file inodes, while preserving the installer's exact production-only invocation.
  suiteProductionTemplate = join(suiteCheckoutParent, "production-template");
  mkdirSync(suiteProductionTemplate, { mode: 0o700 });
  cpSync(join(root, "package.json"), join(suiteProductionTemplate, "package.json"));
  cpSync(join(root, "bun.lock"), join(suiteProductionTemplate, "bun.lock"));
  const productionInstall = await command(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--production",
      "--ignore-scripts",
      "--backend=copyfile",
    ],
    { cwd: suiteProductionTemplate },
  );
  expect(productionInstall.code, productionInstall.stderr).toBe(0);
  expect(existsSync(join(suiteProductionTemplate, "node_modules", "typescript"))).toBeFalse();
  const seal = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) seal(join(path, name));
      chmodSync(path, 0o500);
    } else {
      chmodSync(path, info.mode & 0o111 ? 0o500 : 0o400);
    }
  };
  seal(suiteProductionTemplate);

  const buildSnapshotTemplate = async (checkoutRoot: string, name: string): Promise<void> => {
    const sha = (
      await command(["git", "-C", checkoutRoot, "rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    const tree = (
      await command(["git", "-C", checkoutRoot, "rev-parse", "--verify", `${sha}^{tree}`])
    ).stdout.trim();
    const stage = join(suiteCheckoutParent, `snapshot-${name}`);
    mkdirSync(stage, { mode: 0o700 });
    const archived = await command(
      [
        "bash",
        "-c",
        'set -o pipefail; git -C "$1" archive "$2" | tar -x -C "$3"',
        "agentscrape-snapshot-archive",
        checkoutRoot,
        sha,
        stage,
      ],
      { cwd: suiteCheckoutParent },
    );
    expect(archived.code, archived.stderr).toBe(0);
    copyTree(join(suiteProductionTemplate, "node_modules"), join(stage, "node_modules"));
    const prepared = await command(
      [
        process.execPath,
        join(stage, "scripts/runtime-snapshot.ts"),
        "prepare",
        stage,
        sha,
        tree,
        Bun.version,
      ],
      { cwd: stage },
    );
    expect(prepared.code, prepared.stderr).toBe(0);
    const kind = name as "current" | "previous";
    suiteSnapshotTemplates.push({ kind, sha, root: stage });

    // Most installer tests deliberately fake the authenticated verifier. They need only the
    // sealed plist template used to render public bytes, not a 26 MB / 3,200-entry runtime copy
    // in every disposable HOME. Tests that inspect, corrupt, or execute a snapshot opt into full.
    const fastStage = join(suiteCheckoutParent, `snapshot-fast-${name}`);
    mkdirSync(join(fastStage, "plist"), { recursive: true, mode: 0o700 });
    mkdirSync(join(fastStage, "scripts"), { recursive: true, mode: 0o700 });
    cpSync(
      join(stage, "plist/agentscrape.process-queue.plist"),
      join(fastStage, "plist/agentscrape.process-queue.plist"),
    );
    cpSync(
      join(stage, "scripts/runtime-snapshot.ts"),
      join(fastStage, "scripts/runtime-snapshot.ts"),
    );
    cpSync(
      join(stage, ".agentscrape-runtime-manifest.json"),
      join(fastStage, ".agentscrape-runtime-manifest.json"),
    );
    chmodSync(join(fastStage, "plist/agentscrape.process-queue.plist"), 0o400);
    chmodSync(join(fastStage, "scripts/runtime-snapshot.ts"), 0o400);
    chmodSync(join(fastStage, ".agentscrape-runtime-manifest.json"), 0o400);
    chmodSync(join(fastStage, "plist"), 0o500);
    chmodSync(join(fastStage, "scripts"), 0o500);
    chmodSync(fastStage, 0o500);
    suiteFastSnapshotTemplates.push({ kind, sha, root: fastStage });
  };
  await buildSnapshotTemplate(root, "current");
  await buildSnapshotTemplate(suitePreviousCheckout, "previous");
});

describe("installer", () => {
  test("shell syntax and ShellCheck parse", async () => {
    const syntax = await command(["bash", "-n", "scripts/install.sh"]);
    expect(syntax.code, syntax.stderr).toBe(0);
    const shellcheck = await command(["shellcheck", "scripts/install.sh"]);
    expect(shellcheck.code, shellcheck.stderr).toBe(0);
  });

  test("installs one complete sealed snapshot and is idempotent", async () => {
    const fixture = installEnv({}, { preseedSnapshots: false });
    const first = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(first.code, first.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const shaPath = join(state, "deployed-sha");
    const receiptPath = join(state, "install-receipt");
    const sha = text(shaPath).trim();
    const runtime = join(realpathSync(state), "runtime", sha);
    const manifest = JSON.parse(text(join(runtime, ".agentscrape-runtime-manifest.json")));
    expect(manifest).toMatchObject({
      kind: "agentscrape-runtime-snapshot",
      sha,
      install_argv: [
        "install",
        "--frozen-lockfile",
        "--production",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
    });
    expect(
      manifest.entries.some(
        (entry: { path: string }) => entry.path === "scripts/runtime-snapshot.ts",
      ),
    ).toBeTrue();
    expect(
      manifest.entries.some(
        (entry: { path: string }) => entry.path === "node_modules/cheerio/package.json",
      ),
    ).toBeTrue();
    expect(text(receiptPath).trimEnd().split("\n")).toHaveLength(12);
    expect(text(commandPath)).toContain(`/runtime/${sha}`);
    expect(text(plistPath)).toContain("agentscrape.process-queue");
    expect(text(fixture.bunLog)).toContain(
      "install --frozen-lockfile --production --ignore-scripts --backend=copyfile",
    );
    const identities = [commandPath, plistPath, receiptPath, shaPath, runtime].map(
      (path) => statSync(path).ino,
    );
    const second = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(second.code, second.stderr).toBe(0);
    expect(
      [commandPath, plistPath, receiptPath, shaPath, runtime].map((path) => statSync(path).ino),
    ).toEqual(identities);
  });

  test("archives exact HEAD and installed command survives checkout deletion", async () => {
    const checkout = await committedPhaseCheckout();
    const committedCli = text(join(checkout, "src/cli.ts"));
    writeFileSync(join(checkout, "src/cli.ts"), `${committedCli}\nthrow new Error("dirty");\n`);
    writeFileSync(join(checkout, "config/presets/dirty.yaml"), "dirty: true\n");
    const fixture = installEnv({}, { preseedSnapshots: false });
    const installed = await command(["bash", join(checkout, "scripts/install.sh")], {
      cwd: checkout,
      env: fixture.env,
    });
    expect(installed.code, installed.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const runtime = join(realpathSync(state), "runtime", text(join(state, "deployed-sha")).trim());
    expect(text(join(runtime, "src/cli.ts"))).toBe(committedCli);
    expect(existsSync(join(runtime, "config/presets/dirty.yaml"))).toBeFalse();
    makeWritable(checkout);
    rmSync(checkout, { recursive: true, force: true });
    const runnable = await command([join(fixture.home, ".local/bin/agentscrape"), "--help"], {
      env: fixture.env,
    });
    expect(runnable.code, runnable.stderr).toBe(0);
  });

  test("authenticates helper from Git and ignores dirty helper bytes", async () => {
    const checkout = await committedPhaseCheckout();
    writeFileSync(
      join(checkout, "scripts/runtime-snapshot.ts"),
      '#!/usr/bin/env bun\nconsole.error("dirty helper executed"); process.exit(91);\n',
    );
    const fixture = installEnv({}, { preseedSnapshots: false });
    const installed = await command(["bash", join(checkout, "scripts/install.sh")], {
      cwd: checkout,
      env: fixture.env,
    });
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stderr).not.toContain("dirty helper executed");
  });

  test("native no-replace preserves collisions", async () => {
    const helperRoot = await committedPhaseCheckout();
    const helper = join(helperRoot, "scripts/runtime-snapshot.ts");
    const parent = temp("agentscrape-native-publish-");
    const stage = join(parent, "stage");
    const target = join(parent, "target");
    mkdirSync(stage);
    mkdirSync(target);
    writeFileSync(join(target, "foreign"), "foreign\n");
    const collision = await command([process.execPath, helper, "publish", stage, target]);
    expect(collision.code).toBe(17);
    expect(text(join(target, "foreign"))).toBe("foreign\n");

    const fixture = installEnv();
    const raced = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_TEST_COLLIDE: "command" },
    });
    expect(raced.code).not.toBe(0);
    expect(text(join(fixture.home, ".local/bin/agentscrape"))).toBe("foreign");
    expect(existsSync(join(fixture.home, ".local/state/agentscrape/deployed-sha"))).toBeFalse();
  });

  test("rejects nonzero production install after dependency copy", async () => {
    const fixture = installEnv(
      { FAKE_BUN_INSTALL_EXIT_AFTER_COPY: "42" },
      { preseedSnapshots: false },
    );
    const failed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("failed to prepare sealed runtime snapshot");
    expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeFalse();
  });

  test("pins data home in wrapper and plist", async () => {
    const fixture = installEnv({}, { fullSnapshots: true });
    const share = join(fixture.home, "custom-data");
    const installed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_SHARE_DIR: share },
    });
    expect(installed.code, installed.stderr).toBe(0);
    expect(text(join(fixture.home, ".local/bin/agentscrape"))).toContain(share);
    expect(
      text(join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist")),
    ).toContain(join(share, "queue"));
  });

  test("migrates an authorized checkout receipt", async () => {
    const fixture = installEnv({}, { preseedPreviousSnapshot: true });
    const prior = await previousCheckout();
    await seedCheckoutInstallation(fixture, prior);
    const migrated = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(migrated.code, migrated.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const sha = text(join(state, "deployed-sha")).trim();
    expect(text(join(state, "install-receipt"))).toContain(
      `root=${realpathSync(state)}/runtime/${sha}`,
    );
  });

  test("migration catchable failure restores normalized snapshot-backed prior state", async () => {
    const fixture = installEnv({}, { preseedPreviousSnapshot: true, fullSnapshots: true });
    const prior = await previousCheckout();
    await seedCheckoutInstallation(fixture, prior);
    const priorSha = text(join(fixture.home, ".local/state/agentscrape/deployed-sha")).trim();
    const failed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_TEST_FAILPOINT: "after-command" },
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("restored previous owned state");
    const state = realpathSync(join(fixture.home, ".local/state/agentscrape"));
    expect(text(join(state, "install-receipt"))).toContain(`root=${state}/runtime/${priorSha}`);
    expect(text(join(fixture.home, ".local/bin/agentscrape"))).toContain(
      `# source-root: ${state}/runtime/${priorSha}`,
    );
  });

  test("refuses malformed, foreign, and interrupted mixed states", async () => {
    const foreign = installEnv();
    mkdirSync(join(foreign.home, ".local/bin"), { recursive: true });
    writeExecutable(join(foreign.home, ".local/bin/agentscrape"), "#!/bin/sh\necho foreign\n");
    const refusedForeign = await command(["bash", "scripts/install.sh"], { env: foreign.env });
    expect(refusedForeign.code).not.toBe(0);
    expect(refusedForeign.stderr).toContain("mixed install state");

    const malformed = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: malformed.env });
    expect(installed.code, installed.stderr).toBe(0);
    writeFileSync(join(malformed.home, ".local/state/agentscrape/install-receipt"), "forged\n");
    const refusedMalformed = await command(["bash", "scripts/install.sh"], { env: malformed.env });
    expect(refusedMalformed.code).not.toBe(0);
    expect(refusedMalformed.stderr).toContain("malformed");

    const interrupted = installEnv();
    const complete = await command(["bash", "scripts/install.sh"], { env: interrupted.env });
    expect(complete.code, complete.stderr).toBe(0);
    rmSync(join(interrupted.home, "Library/LaunchAgents/agentscrape.process-queue.plist"));
    const refusedInterrupted = await command(["bash", "scripts/install.sh"], {
      env: interrupted.env,
    });
    expect(refusedInterrupted.code).not.toBe(0);
    expect(refusedInterrupted.stderr).toContain("interrupted mixed install state");
  });

  test("representative catchable failure rolls back", async () => {
    const fixture = installEnv();
    const failed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_TEST_FAILPOINT: "after-receipt" },
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("restored previous owned state");
    for (const path of [
      join(fixture.home, ".local/bin/agentscrape"),
      join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist"),
      join(fixture.home, ".local/state/agentscrape/install-receipt"),
      join(fixture.home, ".local/state/agentscrape/deployed-sha"),
    ])
      expect(existsSync(path)).toBeFalse();
  });

  test("C rolls back on catchable failure and rolls forward on retry", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code, installed.stderr).toBe(0);
    const deployed = join(fixture.home, ".local/state/agentscrape/deployed-sha");
    rmSync(deployed);
    const failed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_TEST_FAILPOINT: "before-deployed-fsync" },
    });
    expect(failed.code).not.toBe(0);
    expect(existsSync(deployed)).toBeFalse();
    const retried = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(retried.code, retried.stderr).toBe(0);
    expect(existsSync(deployed)).toBeTrue();
  });

  test("HOME lock rejects concurrent install and uninstall", async () => {
    const fixture = installEnv({ FAKE_BUN_INSTALL_DELAY: "1.2" }, { preseedSnapshots: false });
    const first = Bun.spawn(["bash", "scripts/install.sh"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...fixture.env },
    });
    const lock = join(fixture.home, ".local/state/.agentscrape-installer/install.lock");
    for (let i = 0; i < 250 && !existsSync(lock); i += 1) await Bun.sleep(20);
    expect(existsSync(lock)).toBeTrue();
    for (const argv of [
      ["bash", "scripts/install.sh"],
      ["bash", "scripts/install.sh", "--uninstall"],
    ]) {
      const competing = await command(argv, { env: fixture.env });
      expect(competing.code).not.toBe(0);
      expect(competing.stderr).toContain("active");
    }
    expect(await first.exited).toBe(0);
    await new Response(first.stdout).text();
    await new Response(first.stderr).text();
  });

  test("strict launchctl identity and errors fail closed", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code, installed.stderr).toBe(0);
    for (const overrides of [
      { FAKE_LAUNCHCTL_FAIL_PRINT: "1" },
      { FAKE_LAUNCHCTL_FOREIGN_PRINT: "1" },
      { FAKE_LAUNCHCTL_WRONG_PATH_PRINT: "1" },
      { FAKE_LAUNCHCTL_BASH_ENV_PRINT: "1" },
    ]) {
      const refused = await command(["bash", "scripts/install.sh", "--uninstall"], {
        env: { ...fixture.env, ...overrides },
      });
      expect(refused.code).not.toBe(0);
      expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeTrue();
    }
  });

  test("uninstall validates exact ownership, retains snapshots, and is idempotent", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code, installed.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const runtime = join(realpathSync(state), "runtime");
    const roots = readdirSync(runtime);
    const failed = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: { ...fixture.env, FAKE_LAUNCHCTL_FAIL_BOOTOUT: "1" },
    });
    expect(failed.code).not.toBe(0);
    expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeTrue();
    const removed = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeFalse();
    expect(readdirSync(runtime)).toEqual(roots);
    const again = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(again.code, again.stderr).toBe(0);
  });

  test("uninstalls exact current and legacy checkout receipts but refuses a foreign checkout", async () => {
    for (const format of ["current", "legacy"] as const) {
      const fixture = installEnv();
      const prior = await previousCheckout();
      await seedCheckoutInstallation(fixture, prior, format);
      const receipt = join(fixture.home, ".local/state/agentscrape/install-receipt");
      expect(text(receipt).trimEnd().split("\n")).toHaveLength(format === "current" ? 12 : 8);

      if (format === "current") {
        const foreign = await command(["bash", "scripts/install.sh", "--uninstall"], {
          env: fixture.env,
        });
        expect(foreign.code).not.toBe(0);
        expect(foreign.stderr).toContain("does not belong to this checkout");
      }

      cpSync(join(root, "scripts/install.sh"), join(prior, "scripts/install.sh"));
      chmodSync(join(prior, "scripts/install.sh"), 0o755);
      const removed = await command(["bash", join(prior, "scripts/install.sh"), "--uninstall"], {
        cwd: prior,
        env: fixture.env,
      });
      expect(removed.code, removed.stderr).toBe(0);
      expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeFalse();
    }
  });

  test("sealed snapshot uninstalls after its source checkout is deleted", async () => {
    const checkout = await committedPhaseCheckout();
    const fixture = installEnv({}, { preseedSnapshots: false });
    const installed = await command(["bash", join(checkout, "scripts/install.sh")], {
      cwd: checkout,
      env: fixture.env,
    });
    expect(installed.code, installed.stderr).toBe(0);
    const state = realpathSync(join(fixture.home, ".local/state/agentscrape"));
    const sha = text(join(state, "deployed-sha")).trim();
    const snapshot = join(state, "runtime", sha);
    makeWritable(checkout);
    rmSync(checkout, { recursive: true, force: true });

    const removed = await command(["bash", join(snapshot, "scripts/install.sh"), "--uninstall"], {
      env: fixture.env,
    });
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeFalse();
    expect(
      existsSync(join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist")),
    ).toBeFalse();
    expect(existsSync(join(state, "deployed-sha"))).toBeFalse();
    expect(existsSync(join(state, "install-receipt"))).toBeFalse();
    expect(existsSync(snapshot)).toBeTrue();
  });

  test("snapshot uninstall rejects malformed helper and manifest before helper execution", async () => {
    const fixture = installEnv({}, { fullSnapshots: true, fastSnapshotVerification: false });
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code, installed.stderr).toBe(0);
    const state = realpathSync(join(fixture.home, ".local/state/agentscrape"));
    const sha = text(join(state, "deployed-sha")).trim();
    const snapshot = join(state, "runtime", sha);
    const helper = join(snapshot, "scripts/runtime-snapshot.ts");
    const manifest = join(snapshot, ".agentscrape-runtime-manifest.json");
    const helperEntry = JSON.parse(text(manifest)).entries.find(
      (entry: { path: string }) => entry.path === "scripts/runtime-snapshot.ts",
    ) as { mode: "0400" | "0500" };
    const marker = join(fixture.state, "malicious-helper-ran");
    chmodSync(snapshot, 0o700);
    chmodSync(join(snapshot, "scripts"), 0o700);
    chmodSync(helper, 0o600);
    writeFileSync(
      helper,
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "ran");\n`,
    );
    chmodSync(helper, Number.parseInt(helperEntry.mode, 8));
    chmodSync(join(snapshot, "scripts"), 0o500);
    chmodSync(snapshot, 0o500);

    const badHelper = await command(["bash", join(snapshot, "scripts/install.sh"), "--uninstall"], {
      env: fixture.env,
    });
    expect(badHelper.code).not.toBe(0);
    expect(existsSync(marker)).toBeFalse();
    expect(existsSync(join(fixture.home, ".local/bin/agentscrape"))).toBeTrue();

    chmodSync(snapshot, 0o700);
    chmodSync(manifest, 0o600);
    writeFileSync(manifest, "{}\n");
    chmodSync(manifest, 0o400);
    chmodSync(snapshot, 0o500);
    const badManifest = await command(
      ["bash", join(snapshot, "scripts/install.sh"), "--uninstall"],
      { env: fixture.env },
    );
    expect(badManifest.code).not.toBe(0);
    expect(existsSync(marker)).toBeFalse();
  });

  agentbuildsIntegrationTest(
    agentbuildsRoot
      ? "snapshot receipt integrates with pinned Agentbuilds inspector"
      : "Agentbuilds integration (skipped: configured checkout unavailable)",
    async () => {
      const agentbuilds = agentbuildsRoot!;
      const fixture = installEnv({}, { preseedSnapshots: false, fullSnapshots: true });
      fixture.env.HOME = realpathSync(fixture.home);
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, installed.stderr).toBe(0);
      const sha = text(join(fixture.home, ".local/state/agentscrape/deployed-sha")).trim();
      const tree = (await command(["git", "-C", root, "rev-parse", `${sha}^{tree}`])).stdout.trim();
      const checkouts = temp("agentscrape-agentbuilds-checkouts-");
      const checkout = join(checkouts, "agentscrape", sha);
      mkdirSync(join(checkout, "src"), { recursive: true });
      cpSync(join(root, "src/cli.ts"), join(checkout, "src/cli.ts"));
      const script = [
        "import os",
        "from pathlib import Path",
        "from system.github.installed import InstalledShaInspector",
        "from system.github.targets import load_targets",
        "root=Path(os.environ['CHECKOUTS']); sha=os.environ['SHA']; tree=os.environ['TREE']",
        "class I:",
        " def validate_identity(self,*a): return root/'agentscrape'/sha",
        " def verify_deployable(self,*a): pass",
        " def tree_identity(self,*a): return tree",
        "target=next(x for x in load_targets() if x.slug=='agentscrape')",
        "print(InstalledShaInspector(root,I(),home=Path(os.environ['HOME'])).installed_sha(target))",
      ].join("\n");
      const inspected = await command([join(agentbuilds, ".venv/bin/python"), "-c", script], {
        cwd: agentbuilds,
        env: { HOME: fixture.env.HOME, CHECKOUTS: checkouts, SHA: sha, TREE: tree },
      });
      expect(inspected.code, inspected.stderr).toBe(0);
      expect(inspected.stdout.trim()).toBe(sha);
    },
  );
});

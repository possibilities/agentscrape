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
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const sourceRoot = join(import.meta.dir, "..");
let root = sourceRoot;
const temporary: string[] = [];
const suiteTemporary: string[] = [];
let suiteCheckoutParent = "";
let suiteProductionTemplate = "";
let suitePreviousCheckout = "";
const suiteSnapshotTemplates: Array<{ kind: "current"; sha: string; root: string }> = [];
const suiteFastSnapshotTemplates: Array<{ kind: "current"; sha: string; root: string }> = [];

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
  "config/preset.schema.json",
  "config/preset-canaries.schema.json",
  "config/corpus-meta.schema.json",
  "src/api.ts",
  "src/corpus.ts",
  "src/envelope.ts",
  "test/install.test.ts",
  "test/corpus.test.ts",
  "test/core.test.ts",
  "README.md",
  "docs/contracts.md",
] as const;

function normalizeCopiedSymlinks(path: string, root: string, copiedFrom?: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    let target = readlinkSync(path);
    if (isAbsolute(target)) {
      let mapped: string | undefined;
      if (target === root || target.startsWith(`${root}${sep}`)) mapped = target;
      else if (copiedFrom && (target === copiedFrom || target.startsWith(`${copiedFrom}${sep}`)))
        mapped = join(root, relative(copiedFrom, target));
      if (mapped) target = relative(dirname(path), mapped);
    }
    unlinkSync(path);
    symlinkSync(target, path);
    return;
  }
  if (!info.isDirectory()) return;
  const mode = info.mode & 0o777;
  if (!(mode & 0o200)) chmodSync(path, mode | 0o200);
  for (const name of readdirSync(path)) normalizeCopiedSymlinks(join(path, name), root, copiedFrom);
  if (!(mode & 0o200)) chmodSync(path, mode);
}

function restoreCopiedDirectoryModes(source: string, destination: string): void {
  const info = lstatSync(source);
  if (!info.isDirectory()) return;
  for (const name of readdirSync(source))
    restoreCopiedDirectoryModes(join(source, name), join(destination, name));
  chmodSync(destination, info.mode & 0o777);
}

function copyTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  // Node may preserve hard-linked or source-absolute symlinks on Linux. Recreate each link so the
  // fixture matches a fresh production install and Agentbuilds' contained nlink=1 contract.
  normalizeCopiedSymlinks(destination, destination, source);
  restoreCopiedDirectoryModes(source, destination);
}

function preseedSuiteSnapshots(home: string, fullSnapshots: boolean): void {
  const templates = fullSnapshots ? suiteSnapshotTemplates : suiteFastSnapshotTemplates;
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
  const preseedSnapshots = options.preseedSnapshots !== false;
  const fullSnapshots =
    options.fullSnapshots === true || options.fastSnapshotVerification === false;
  if (preseedSnapshots) preseedSuiteSnapshots(home, fullSnapshots);

  const env: Record<string, string | undefined> = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    // launchd domains are per-user, not per-HOME. Without this every uninstall
    // in this suite would boot out the operator's real agentscrape.process-queue,
    // which is exactly what happened when the fake launchctl was removed.
    AGENTSCRAPE_INSTALL_LAUNCHCTL: "none",
    AGENTSCRAPE_FAKE_BUN_LOG: bunLog,
    AGENTSCRAPE_FAKE_PLUTIL_LOG: plutilLog,
    AGENTSCRAPE_FAKE_PRODUCTION_TEMPLATE: suiteProductionTemplate,
    AGENTSCRAPE_FAKE_FAST_SNAPSHOT_VERIFY:
      preseedSnapshots && options.fastSnapshotVerification !== false ? "1" : "0",
    AGENTSCRAPE_FAKE_FAST_SNAPSHOT_SHAS: suiteSnapshotTemplates
      .map((template) => template.sha)
      .join(":"),
    ...overrides,
  };

  return { home, tools, state, bunLog, plutilLog, env };
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
  // The checkout-backed predecessor predates immutable runtime snapshots. Its commit remains an
  // ancestor of the current fixture, but it deliberately has no runtime helper to authenticate.
  rmSync(join(checkout, "scripts/runtime-snapshot.ts"));
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
      "land helperless checkout predecessor",
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

  cpSync(
    join(sourceRoot, "scripts/runtime-snapshot.ts"),
    join(root, "scripts/runtime-snapshot.ts"),
  );
  const currentAdd = await command(["git", "-C", root, "add", "scripts/runtime-snapshot.ts"]);
  expect(currentAdd.code, currentAdd.stderr).toBe(0);
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
    "-m",
    "introduce runtime snapshot helper",
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
  normalizeCopiedSymlinks(suiteProductionTemplate, suiteProductionTemplate);
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
    const kind = "current" as const;
    suiteSnapshotTemplates.push({ kind, sha, root: stage });

    // Most installer tests deliberately fake the authenticated verifier. They need only the
    // sealed helper and manifest, not a 26 MB / 3,200-entry runtime copy in every disposable
    // HOME. Tests that inspect, corrupt, or execute a snapshot opt into full.
    const fastStage = join(suiteCheckoutParent, `snapshot-fast-${name}`);
    mkdirSync(join(fastStage, "scripts"), { recursive: true, mode: 0o700 });
    cpSync(
      join(stage, "scripts/runtime-snapshot.ts"),
      join(fastStage, "scripts/runtime-snapshot.ts"),
    );
    cpSync(
      join(stage, ".agentscrape-runtime-manifest.json"),
      join(fastStage, ".agentscrape-runtime-manifest.json"),
    );
    chmodSync(join(fastStage, "scripts/runtime-snapshot.ts"), 0o400);
    chmodSync(join(fastStage, ".agentscrape-runtime-manifest.json"), 0o400);
    chmodSync(join(fastStage, "scripts"), 0o500);
    chmodSync(fastStage, 0o500);
    suiteFastSnapshotTemplates.push({ kind, sha, root: fastStage });
  };
  await buildSnapshotTemplate(root, "current");
});

describe("installer", () => {
  test("installs one complete sealed snapshot and is idempotent", async () => {
    const fixture = installEnv({}, { preseedSnapshots: false });
    const first = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(first.code, first.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const commandPath = join(fixture.home, ".local/bin/agentscrape");
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
    expect(text(receiptPath).trimEnd().split("\n")).toHaveLength(9);
    expect(text(commandPath)).toContain(`/runtime/${sha}`);
    expect(text(fixture.bunLog)).toContain(
      "install --frozen-lockfile --production --ignore-scripts --backend=copyfile",
    );
    const identities = [commandPath, receiptPath, shaPath, runtime].map(
      (path) => statSync(path).ino,
    );
    const second = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(second.code, second.stderr).toBe(0);
    expect([commandPath, receiptPath, shaPath, runtime].map((path) => statSync(path).ino)).toEqual(
      identities,
    );
  });

  test("uninstall validates exact ownership, retains snapshots, and is idempotent", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code, installed.stderr).toBe(0);
    const state = join(fixture.home, ".local/state/agentscrape");
    const runtime = join(realpathSync(state), "runtime");
    const roots = readdirSync(runtime);
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
});

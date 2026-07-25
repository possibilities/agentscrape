import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
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

async function previousCheckout(): Promise<string> {
  const parent = temp("agentscrape-prior-checkout-");
  const checkout = join(parent, "agentscrape");
  const cloned = await command(["git", "clone", "--quiet", "--no-hardlinks", root, checkout]);
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

function installEnv(overrides: Record<string, string | undefined> = {}) {
  const home = temp("agentscrape-install-home-");
  const tools = temp("agentscrape-install-tools-");
  const state = temp("agentscrape-install-launchctl-");
  const bunLog = join(state, "bun.log");
  const plutilLog = join(state, "plutil.log");
  const launchctlLog = join(state, "launchctl.log");
  const serviceState = join(state, "service.env");

  mkdirSync(tools, { recursive: true });
  writeExecutable(
    join(tools, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$AGENTSCRAPE_FAKE_BUN_LOG"
if [[ "\${1:-}" == "install" && "\${2:-}" == "--frozen-lockfile" ]]; then
  exit 0
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
    [[ -f "$state_file" ]] || exit 1
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

  const env: Record<string, string | undefined> = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGENTSCRAPE_FAKE_BUN_LOG: bunLog,
    AGENTSCRAPE_FAKE_PLUTIL_LOG: plutilLog,
    AGENTSCRAPE_FAKE_LAUNCHCTL_LOG: launchctlLog,
    AGENTSCRAPE_FAKE_LAUNCHCTL_STATE: serviceState,
    ...overrides,
  };

  return { home, tools, state, bunLog, plutilLog, launchctlLog, serviceState, env };
}

describe("installer", () => {
  test("shell syntax parses", async () => {
    const result = await command(["bash", "-n", "scripts/install.sh"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("install renders owned files, lints the plist, and is idempotent", async () => {
    const fixture = installEnv();
    const first = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("installed");

    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const stateDir = join(fixture.home, ".local/state/agentscrape");
    const shareDir = join(fixture.home, ".local/share/agentscrape");
    const expectedPath = `${fixture.tools}:${join(fixture.home, ".local/bin")}:${"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`;

    expect(existsSync(commandPath)).toBeTrue();
    expect(lstatSync(commandPath).isSymbolicLink()).toBeFalse();
    expect(statSync(commandPath).mode & 0o111).not.toBe(0);
    expect(text(commandPath)).toContain("agentscrape-installer-owned: agentscrape.command.v1");
    expect(text(commandPath)).toContain(join(root, "src/cli.ts"));

    expect(existsSync(plistPath)).toBeTrue();
    expect(lstatSync(plistPath).isSymbolicLink()).toBeFalse();
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(text(plistPath)).toContain("agentscrape.process-queue");
    expect(text(plistPath)).toContain(expectedPath);
    expect(text(plistPath)).toContain(join(fixture.home, ".local/share/agentscrape/queue"));

    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(shareDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "process-queue.log")).mode & 0o777).toBe(0o600);

    expect(text(fixture.bunLog)).toContain("install --frozen-lockfile");
    expect(text(fixture.plutilLog)).toContain("-lint");
    expect(text(fixture.launchctlLog)).toContain(
      `bootstrap gui/${process.getuid?.() ?? 0} ${plistPath}`,
    );

    const firstCommandSnapshot = join(fixture.state, "agentscrape-command.snapshot");
    const firstPlistSnapshot = join(fixture.state, "agentscrape-plist.snapshot");
    const deployedShaPath = join(stateDir, "deployed-sha");
    const firstDeployedInode = statSync(deployedShaPath).ino;
    writeFileSync(firstCommandSnapshot, text(commandPath));
    writeFileSync(firstPlistSnapshot, text(plistPath));

    const second = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(second.code).toBe(0);
    expect(statSync(deployedShaPath).ino).not.toBe(firstDeployedInode);

    const commandDiff = await command(["diff", "-u", firstCommandSnapshot, commandPath]);
    const plistDiff = await command(["diff", "-u", firstPlistSnapshot, plistPath]);
    expect(commandDiff.code).toBe(0);
    expect(plistDiff.code).toBe(0);
  });

  test("pins the installed queue root across wrapper, plist, and CLI runtime", async () => {
    for (const scenario of [
      {
        label: "AGENTSCRAPE_INSTALL_SHARE_DIR override",
        installEnv: (fixture: ReturnType<typeof installEnv>) => ({
          AGENTSCRAPE_INSTALL_SHARE_DIR: join(fixture.home, "custom-share-root"),
        }),
        expectedShareDir: (fixture: ReturnType<typeof installEnv>) =>
          realpathSync(join(fixture.home, "custom-share-root")),
      },
      {
        label: "XDG_DATA_HOME fallback",
        installEnv: (fixture: ReturnType<typeof installEnv>) => ({
          XDG_DATA_HOME: join(fixture.home, "xdg-data-home"),
        }),
        expectedShareDir: (fixture: ReturnType<typeof installEnv>) =>
          realpathSync(join(fixture.home, "xdg-data-home", "agentscrape")),
      },
    ]) {
      const fixture = installEnv();
      const installOverrides = scenario.installEnv(fixture);
      const installed = await command(["bash", "scripts/install.sh"], {
        env: { ...fixture.env, ...installOverrides },
      });
      expect(installed.code).toBe(0);

      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const shareDir = scenario.expectedShareDir(fixture);
      const queueDir = join(shareDir, "queue");
      writeFileSync(
        join(queueDir, "runtime-check.yaml"),
        ["url: https://example.com/runtime", "destination: /tmp/runtime.md", ""].join("\n"),
      );

      const wrapper = text(commandPath);
      expect(wrapper).toContain("export AGENTSCRAPE_DATA_HOME=");
      expect(wrapper).toContain(shareDir);
      expect(text(plistPath)).toContain(`<string>${queueDir}</string>`);

      const runtime = await command([commandPath, "reconcile-queue", "--format", "json"], {
        env: {
          ...fixture.env,
          ...installOverrides,
          XDG_DATA_HOME: join(fixture.home, "runtime-xdg-data-home"),
        },
      });
      expect(runtime.code).toBe(0);
      expect(JSON.parse(runtime.stdout)).toMatchObject({
        total_records: 1,
        selected_records: 1,
      });
    }
  });

  test("migrates an exact receipt-backed installation from another checkout", async () => {
    const fixture = installEnv();
    const prior = await previousCheckout();
    const installedPrior = await command(["bash", join(prior, "scripts/install.sh")], {
      cwd: prior,
      env: fixture.env,
    });
    expect(installedPrior.code).toBe(0);

    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
    const queuePath = join(fixture.home, ".local/share/agentscrape/queue/preserved.yaml");
    writeFileSync(queuePath, "preserved: true\n");
    expect(text(commandPath)).toContain(`# source-root: ${prior}`);

    const narrowUninstall = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(narrowUninstall.code).not.toBe(0);
    expect(existsSync(commandPath)).toBeTrue();
    expect(text(queuePath)).toBe("preserved: true\n");

    const migrated = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(migrated.code).toBe(0);
    expect(text(commandPath)).toContain(`# source-root: ${realpathSync(root)}`);
    expect(text(receiptPath)).toContain(`root=${realpathSync(root)}`);
    expect(text(queuePath)).toBe("preserved: true\n");
  });

  test("repairs exact first-install artifacts with no receipts after either rename", async () => {
    for (const boundary of ["command-only", "command-and-plist"] as const) {
      const fixture = installEnv();
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, boundary).toBe(0);

      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const stateDir = join(fixture.home, ".local/state/agentscrape");
      const receiptPath = join(stateDir, "install-receipt");
      const deployedShaPath = join(stateDir, "deployed-sha");
      const expectedCommand = text(commandPath);
      const expectedPlist = text(plistPath);

      rmSync(receiptPath);
      rmSync(deployedShaPath);
      rmSync(fixture.serviceState);
      if (boundary === "command-only") rmSync(plistPath);

      const uninstall = await command(["bash", "scripts/install.sh", "--uninstall"], {
        env: fixture.env,
      });
      expect(uninstall.code, boundary).not.toBe(0);
      expect(uninstall.stderr, boundary).toContain("refusing uninstall");
      expect(text(commandPath), boundary).toBe(expectedCommand);
      expect(existsSync(plistPath), boundary).toBe(boundary === "command-and-plist");

      const repaired = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(repaired.code, boundary).toBe(0);
      expect(text(commandPath), boundary).toBe(expectedCommand);
      expect(text(plistPath), boundary).toBe(expectedPlist);
      expect(existsSync(receiptPath), boundary).toBeTrue();
      expect(existsSync(deployedShaPath), boundary).toBeTrue();
    }
  });

  test("refuses near-exact first-install artifacts with no receipts", async () => {
    for (const boundary of ["near-exact-command", "near-exact-plist"] as const) {
      const fixture = installEnv();
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, boundary).toBe(0);

      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const stateDir = join(fixture.home, ".local/state/agentscrape");
      rmSync(join(stateDir, "install-receipt"));
      rmSync(join(stateDir, "deployed-sha"));
      rmSync(fixture.serviceState);

      if (boundary === "near-exact-command") {
        rmSync(plistPath);
        writeFileSync(commandPath, `${text(commandPath)}# near-exact\n`);
      } else {
        writeFileSync(plistPath, `${text(plistPath)}\n<!-- near-exact -->\n`);
      }
      const commandSnapshot = text(commandPath);
      const plistSnapshot = existsSync(plistPath) ? text(plistPath) : undefined;

      const refused = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(refused.code, boundary).not.toBe(0);
      expect(refused.stderr, boundary).toContain("refusing");
      expect(text(commandPath), boundary).toBe(commandSnapshot);
      if (plistSnapshot !== undefined) expect(text(plistPath), boundary).toBe(plistSnapshot);
    }
  });

  test("recovers exact upgrade and final-publication states and rejects near-exact mixes", async () => {
    const fixture = installEnv();
    const prior = await previousCheckout();
    const advancedPrior = await command([
      "git",
      "-C",
      prior,
      "-c",
      "user.name=Agentscrape Test",
      "-c",
      "user.email=agentscrape-test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture previous deployment",
    ]);
    expect(advancedPrior.code).toBe(0);

    const priorTools = join(fixture.state, "prior-tools");
    mkdirSync(priorTools);
    const priorBun = join(priorTools, "bun");
    writeExecutable(priorBun, text(join(fixture.tools, "bun")));
    const installedPrior = await command(["bash", join(prior, "scripts/install.sh")], {
      cwd: prior,
      env: { ...fixture.env, AGENTSCRAPE_INSTALL_BUN: priorBun },
    });
    expect(installedPrior.code).toBe(0);

    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const stateDir = join(fixture.home, ".local/state/agentscrape");
    const receiptPath = join(stateDir, "install-receipt");
    const deployedShaPath = join(stateDir, "deployed-sha");
    const priorCommand = text(commandPath);
    const priorPlist = text(plistPath);
    const priorReceipt = text(receiptPath);
    const priorDeployedSha = text(deployedShaPath);

    const installedCurrent = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installedCurrent.code).toBe(0);
    const currentCommand = text(commandPath);
    const currentPlist = text(plistPath);
    const currentReceipt = text(receiptPath);
    const currentDeployedSha = text(deployedShaPath);
    expect(priorCommand).not.toBe(currentCommand);
    expect(priorPlist).not.toBe(currentPlist);
    expect(priorDeployedSha).not.toBe(currentDeployedSha);
    expect(currentReceipt.trimEnd().split("\n")).toHaveLength(12);

    // B: the command rename completed, but the plist still exactly matches PRIOR.
    writeFileSync(commandPath, currentCommand);
    writeFileSync(plistPath, priorPlist);
    writeFileSync(receiptPath, priorReceipt);
    writeFileSync(deployedShaPath, priorDeployedSha);
    const commandCurrentPlistPrior = await command(["bash", "scripts/install.sh"], {
      env: fixture.env,
    });
    expect(commandCurrentPlistPrior.code).toBe(0);
    expect(text(commandPath)).toBe(currentCommand);
    expect(text(plistPath)).toBe(currentPlist);

    // B: both artifact renames completed, while receipt/deployed still exactly match PRIOR.
    writeFileSync(receiptPath, priorReceipt);
    writeFileSync(deployedShaPath, priorDeployedSha);
    const artifactsCurrentReceiptPrior = await command(["bash", "scripts/install.sh"], {
      env: fixture.env,
    });
    expect(artifactsCurrentReceiptPrior.code).toBe(0);
    expect(text(receiptPath)).toBe(currentReceipt);
    expect(text(deployedShaPath)).toBe(currentDeployedSha);

    // C: readiness and the CURRENT receipt publication completed, but deployed-sha is absent.
    rmSync(deployedShaPath);
    const deployedAbsent = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(deployedAbsent.code).toBe(0);
    expect(text(deployedShaPath)).toBe(currentDeployedSha);

    // C: the same boundary may retain any secure, exact old SHA file.
    writeFileSync(deployedShaPath, priorDeployedSha);
    const deployedOld = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(deployedOld.code).toBe(0);
    expect(text(deployedShaPath)).toBe(currentDeployedSha);

    // Anything near either exact PRIOR or exact CURRENT artifact remains foreign.
    writeFileSync(commandPath, currentCommand);
    writeFileSync(plistPath, `${priorPlist}\n<!-- near-exact -->\n`);
    writeFileSync(receiptPath, priorReceipt);
    writeFileSync(deployedShaPath, priorDeployedSha);
    const nearExactMixed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(nearExactMixed.code).not.toBe(0);
    expect(nearExactMixed.stderr).toContain("LaunchAgent that does not correlate");
    expect(text(commandPath)).toBe(currentCommand);
    expect(text(plistPath)).toBe(`${priorPlist}\n<!-- near-exact -->\n`);
    expect(text(receiptPath)).toBe(priorReceipt);
    expect(text(deployedShaPath)).toBe(priorDeployedSha);
  });

  test("refuses malformed or forged cross-checkout ownership evidence", async () => {
    const scenarios: Array<{
      name: string;
      mutate: (fixture: ReturnType<typeof installEnv>, prior: string) => Promise<void> | void;
    }> = [
      {
        name: "marker-bearing wrapper without a receipt",
        mutate: (fixture) => {
          rmSync(join(fixture.home, ".local/state/agentscrape/install-receipt"));
        },
      },
      {
        name: "wrapper with an extra command",
        mutate: (fixture) => {
          const path = join(fixture.home, ".local/bin/agentscrape");
          writeFileSync(path, `${text(path)}echo forged\n`);
        },
      },
      {
        name: "receipt with an extra field",
        mutate: (fixture) => {
          const path = join(fixture.home, ".local/state/agentscrape/install-receipt");
          writeFileSync(path, `${text(path)}extra=forged\n`);
        },
      },
      {
        name: "receipt inconsistent with its wrapper",
        mutate: (fixture) => {
          const path = join(fixture.home, ".local/state/agentscrape/install-receipt");
          writeFileSync(path, text(path).replace(/^bun=.*$/m, "bun=/usr/bin/false"));
        },
      },
      {
        name: "non-private receipt",
        mutate: (fixture) => {
          chmodSync(join(fixture.home, ".local/state/agentscrape/install-receipt"), 0o644);
        },
      },
      {
        name: "receipt SHA that is not the checkout HEAD",
        mutate: (fixture) => {
          const forgedSha = "0".repeat(40);
          const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
          const commandPath = join(fixture.home, ".local/bin/agentscrape");
          writeFileSync(receiptPath, text(receiptPath).replace(/^sha=.*$/m, `sha=${forgedSha}`));
          writeFileSync(
            commandPath,
            text(commandPath).replace(/^# source-sha: .*$/m, `# source-sha: ${forgedSha}`),
          );
        },
      },
      {
        name: "checkout with the wrong origin",
        mutate: async (_fixture, prior) => {
          const changed = await command([
            "git",
            "-C",
            prior,
            "remote",
            "set-url",
            "origin",
            "https://github.com/possibilities/not-agentscrape.git",
          ]);
          expect(changed.code).toBe(0);
        },
      },
      {
        name: "non-canonical checkout paths",
        mutate: (fixture, prior) => {
          const detour = join(prior, "path-detour");
          mkdirSync(detour);
          const unsafeRoot = `${detour}/..`;
          const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
          const commandPath = join(fixture.home, ".local/bin/agentscrape");
          writeFileSync(
            receiptPath,
            text(receiptPath)
              .replace(`root=${prior}`, `root=${unsafeRoot}`)
              .replace(`source=${prior}/src/cli.ts`, `source=${unsafeRoot}/src/cli.ts`),
          );
          writeFileSync(
            commandPath,
            text(commandPath)
              .replace(`# source-root: ${prior}`, `# source-root: ${unsafeRoot}`)
              .replace(`'${prior}/src/cli.ts'`, `'${unsafeRoot}/src/cli.ts'`),
          );
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = installEnv();
      const prior = await previousCheckout();
      const installedPrior = await command(["bash", join(prior, "scripts/install.sh")], {
        cwd: prior,
        env: fixture.env,
      });
      expect(installedPrior.code, scenario.name).toBe(0);
      await scenario.mutate(fixture, prior);

      const refused = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(refused.code, scenario.name).not.toBe(0);
      expect(refused.stderr, scenario.name).toContain("refusing");
    }
  });

  test("refuses unrelated command and unrelated loaded service", async () => {
    const commandFixture = installEnv();
    const commandPath = join(commandFixture.home, ".local/bin/agentscrape");
    mkdirSync(join(commandFixture.home, ".local/bin"), { recursive: true });
    writeFileSync(commandPath, "#!/usr/bin/env bash\necho foreign\n");
    const unrelatedCommand = await command(["bash", "scripts/install.sh"], {
      env: commandFixture.env,
    });
    expect(unrelatedCommand.code).not.toBe(0);
    expect(unrelatedCommand.stderr).toContain("refusing to overwrite unrelated file");

    const serviceFixture = installEnv();
    writeFileSync(
      serviceFixture.serviceState,
      [
        `domain=gui/${process.getuid?.() ?? 0}`,
        "label=agentscrape.process-queue",
        "program=/tmp/foreign-agentscrape",
        "path=/tmp/foreign-bin",
        "plist=/tmp/foreign-agentscrape.process-queue.plist",
        "",
      ].join("\n"),
    );
    const unrelatedService = await command(["bash", "scripts/install.sh"], {
      env: serviceFixture.env,
    });
    expect(unrelatedService.code).not.toBe(0);
    expect(unrelatedService.stderr).toContain("foreign loaded service");
  });

  test("requires exact plist bytes and anchored loaded program/plist/PATH identities", async () => {
    const plistFixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: plistFixture.env });
    expect(installed.code).toBe(0);
    const plistPath = join(
      plistFixture.home,
      "Library/LaunchAgents/agentscrape.process-queue.plist",
    );
    writeFileSync(plistPath, `${text(plistPath)}\n<!-- forged but marker-bearing -->\n`);
    const forgedPlist = await command(["bash", "scripts/install.sh"], {
      env: plistFixture.env,
    });
    expect(forgedPlist.code).not.toBe(0);
    expect(forgedPlist.stderr).toContain("does not correlate with install receipt");

    for (const override of [
      "FAKE_LAUNCHCTL_FORGED_PRINT",
      "FAKE_LAUNCHCTL_WRONG_PATH_PRINT",
      "FAKE_LAUNCHCTL_WRONG_PLIST_PRINT",
      "FAKE_LAUNCHCTL_DUPLICATE_PROGRAM_PRINT",
      "FAKE_LAUNCHCTL_DUPLICATE_PATH_PRINT",
    ]) {
      const fixture = installEnv();
      const first = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(first.code, override).toBe(0);
      const refused = await command(["bash", "scripts/install.sh"], {
        env: { ...fixture.env, [override]: "1" },
      });
      expect(refused.code, override).not.toBe(0);
      expect(refused.stderr, override).toContain("foreign loaded service");
      expect(existsSync(fixture.serviceState), override).toBeTrue();

      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const uninstallRefused = await command(["bash", "scripts/install.sh", "--uninstall"], {
        env: { ...fixture.env, [override]: "1" },
      });
      expect(uninstallRefused.code, override).not.toBe(0);
      expect(uninstallRefused.stderr, override).toContain("foreign loaded service");
      expect(existsSync(commandPath), override).toBeTrue();
      expect(existsSync(plistPath), override).toBeTrue();
    }
  });

  test("rejects symlinks in every configured path ancestry before creating descendants", async () => {
    const scenarios = [
      "AGENTSCRAPE_INSTALL_BIN_DIR",
      "AGENTSCRAPE_INSTALL_STATE_DIR",
      "AGENTSCRAPE_INSTALL_SHARE_DIR",
      "AGENTSCRAPE_INSTALL_LAUNCH_AGENTS_DIR",
    ] as const;
    for (const variable of scenarios) {
      const fixture = installEnv();
      const carrier = temp("agentscrape-path-carrier-");
      const target = temp("agentscrape-path-target-");
      const link = join(carrier, "linked-ancestor");
      symlinkSync(target, link);
      const configured = join(link, "nested", variable.toLowerCase());
      const refused = await command(["bash", "scripts/install.sh"], {
        env: { ...fixture.env, [variable]: configured },
      });
      expect(refused.code, variable).not.toBe(0);
      expect(refused.stderr, variable).toContain("symlink path component");
      expect(existsSync(join(target, "nested")), variable).toBeFalse();
    }
  });

  test("rejects hard-linked mutable slots before reinstall mutation", async () => {
    const relativeSlots = [
      ".local/state/agentscrape/process-queue.log",
      ".local/state/agentscrape/deployed-sha",
      ".local/state/agentscrape/install-receipt",
      ".local/bin/agentscrape",
      "Library/LaunchAgents/agentscrape.process-queue.plist",
    ];
    for (const relative of relativeSlots) {
      const fixture = installEnv();
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, relative).toBe(0);
      const slot = join(fixture.home, relative);
      const original = text(slot);
      const originalInode = statSync(slot).ino;
      linkSync(slot, `${slot}.hardlink`);

      const refused = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(refused.code, relative).not.toBe(0);
      expect(refused.stderr, relative).toContain("exactly one hard link");
      expect(text(slot), relative).toBe(original);
      expect(statSync(slot).ino, relative).toBe(originalInode);
    }
  });

  test("bootstrap failure restores the prior owned command and service", async () => {
    const fixture = installEnv();
    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
    const deployedShaPath = join(fixture.home, ".local/state/agentscrape/deployed-sha");

    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code).toBe(0);
    const previousCommand = text(commandPath);
    const previousPlist = text(plistPath);
    const previousReceipt = text(receiptPath);
    const previousDeployedSha = text(deployedShaPath);
    const previousDeployedInode = statSync(deployedShaPath).ino;
    const previousReceiptInode = statSync(receiptPath).ino;

    const failed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, FAKE_LAUNCHCTL_FAIL_BOOTSTRAP_ONCE: "1" },
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("restored previous owned state after failure");
    expect(text(commandPath)).toBe(previousCommand);
    expect(text(plistPath)).toBe(previousPlist);
    expect(text(receiptPath)).toBe(previousReceipt);
    expect(text(deployedShaPath)).toBe(previousDeployedSha);
    expect(statSync(deployedShaPath).ino).toBe(previousDeployedInode);
    expect(statSync(receiptPath).ino).toBe(previousReceiptInode);
    expect(statSync(commandPath).mode & 0o777).toBe(0o755);
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(text(fixture.launchctlLog)).toContain("bootout gui/");
    expect(
      text(fixture.launchctlLog).match(/bootstrap gui\//g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);

    const retried = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(retried.code).toBe(0);
  });

  test("a failed final deployed-sha publication leaves the original receipt inode intact", async () => {
    const fixture = installEnv();
    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
    const deployedShaPath = join(fixture.home, ".local/state/agentscrape/deployed-sha");

    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code).toBe(0);
    const previousCommand = text(commandPath);
    const previousPlist = text(plistPath);
    const previousReceipt = text(receiptPath);
    const previousDeployedSha = text(deployedShaPath);
    const previousDeployedInode = statSync(deployedShaPath).ino;

    writeExecutable(
      join(fixture.tools, "mv"),
      `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ "$destination" == */deployed-sha ]]; then
  exit 73
fi
exec /bin/mv "$@"
`,
    );

    const failed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(failed.code).toBe(73);
    expect(failed.stderr).toContain("restored previous owned state after failure");
    expect(text(commandPath)).toBe(previousCommand);
    expect(text(plistPath)).toBe(previousPlist);
    expect(text(receiptPath)).toBe(previousReceipt);
    expect(text(deployedShaPath)).toBe(previousDeployedSha);
    expect(statSync(deployedShaPath).ino).toBe(previousDeployedInode);

    rmSync(join(fixture.tools, "mv"));
    const retried = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(retried.code).toBe(0);
    expect(statSync(deployedShaPath).ino).not.toBe(previousDeployedInode);
  });

  test("the deployed-sha rename is the final completion publication", async () => {
    const fixture = installEnv();
    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
    const deployedShaPath = join(fixture.home, ".local/state/agentscrape/deployed-sha");

    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code).toBe(0);
    const expectedCommand = text(commandPath);
    const expectedPlist = text(plistPath);
    const expectedReceipt = text(receiptPath);
    const expectedDeployedSha = text(deployedShaPath);
    const previousDeployedInode = statSync(deployedShaPath).ino;

    writeExecutable(
      join(fixture.tools, "mv"),
      `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
/bin/mv "$@"
if [[ "$destination" == */deployed-sha ]]; then
  kill -TERM "$PPID"
fi
`,
    );

    const interrupted = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(interrupted.code).toBe(143);
    expect(interrupted.stderr).not.toContain("restored previous owned state after failure");
    expect(text(commandPath)).toBe(expectedCommand);
    expect(text(plistPath)).toBe(expectedPlist);
    expect(text(receiptPath)).toBe(expectedReceipt);
    expect(text(deployedShaPath)).toBe(expectedDeployedSha);
    expect(statSync(deployedShaPath).ino).not.toBe(previousDeployedInode);
    expect(existsSync(fixture.serviceState)).toBeTrue();
  });

  test("uninstall rejects malformed or uncorroborated receipts without partial deletion", async () => {
    const scenarios: Array<{
      name: string;
      mutate: (fixture: ReturnType<typeof installEnv>) => void;
    }> = [
      {
        name: "missing install receipt",
        mutate: (fixture) => {
          rmSync(join(fixture.home, ".local/state/agentscrape/install-receipt"));
        },
      },
      {
        name: "malformed install receipt",
        mutate: (fixture) => {
          const receipt = join(fixture.home, ".local/state/agentscrape/install-receipt");
          writeFileSync(receipt, `${text(receipt)}forged=true\n`);
        },
      },
      {
        name: "command not correlated with install receipt",
        mutate: (fixture) => {
          const commandPath = join(fixture.home, ".local/bin/agentscrape");
          writeFileSync(commandPath, `${text(commandPath)}echo forged\n`);
        },
      },
      {
        name: "plist not correlated with install receipt",
        mutate: (fixture) => {
          const plistPath = join(
            fixture.home,
            "Library/LaunchAgents/agentscrape.process-queue.plist",
          );
          writeFileSync(plistPath, `${text(plistPath)}\n<!-- forged -->\n`);
        },
      },
      {
        name: "deployment content not correlated with receipt SHA",
        mutate: (fixture) => {
          writeFileSync(
            join(fixture.home, ".local/state/agentscrape/deployed-sha"),
            `${"0".repeat(40)}\n`,
          );
        },
      },
      {
        name: "non-private deployment receipt",
        mutate: (fixture) => {
          chmodSync(join(fixture.home, ".local/state/agentscrape/deployed-sha"), 0o644);
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = installEnv();
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, scenario.name).toBe(0);
      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const deployedShaPath = join(fixture.home, ".local/state/agentscrape/deployed-sha");
      scenario.mutate(fixture);
      const commandSnapshot = text(commandPath);
      const plistSnapshot = text(plistPath);
      const deployedInode = statSync(deployedShaPath).ino;

      const refused = await command(["bash", "scripts/install.sh", "--uninstall"], {
        env: fixture.env,
      });
      expect(refused.code, scenario.name).not.toBe(0);
      expect(refused.stderr, scenario.name).toContain("refusing");
      expect(text(commandPath), scenario.name).toBe(commandSnapshot);
      expect(text(plistPath), scenario.name).toBe(plistSnapshot);
      expect(statSync(deployedShaPath).ino, scenario.name).toBe(deployedInode);
      expect(existsSync(fixture.serviceState), scenario.name).toBeTrue();
    }
  });

  test("uninstall rejects hard-linked managed artifacts before deleting anything", async () => {
    const relativeSlots = [
      ".local/bin/agentscrape",
      "Library/LaunchAgents/agentscrape.process-queue.plist",
      ".local/state/agentscrape/install-receipt",
      ".local/state/agentscrape/deployed-sha",
    ];
    for (const relative of relativeSlots) {
      const fixture = installEnv();
      const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
      expect(installed.code, relative).toBe(0);
      const commandPath = join(fixture.home, ".local/bin/agentscrape");
      const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
      const receiptPath = join(fixture.home, ".local/state/agentscrape/install-receipt");
      const deployedShaPath = join(fixture.home, ".local/state/agentscrape/deployed-sha");
      const slot = join(fixture.home, relative);
      linkSync(slot, `${slot}.hardlink`);

      const refused = await command(["bash", "scripts/install.sh", "--uninstall"], {
        env: fixture.env,
      });
      expect(refused.code, relative).not.toBe(0);
      expect(refused.stderr, relative).toContain("exactly one hard link");
      expect(existsSync(commandPath), relative).toBeTrue();
      expect(existsSync(plistPath), relative).toBeTrue();
      expect(existsSync(receiptPath), relative).toBeTrue();
      expect(existsSync(deployedShaPath), relative).toBeTrue();
      expect(existsSync(fixture.serviceState), relative).toBeTrue();
    }
  });

  test("uninstall removes only owned command and service and is idempotent", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code).toBe(0);

    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const queueDir = join(fixture.home, ".local/share/agentscrape/queue");
    const failedDir = join(fixture.home, ".local/share/agentscrape/failed");
    const logPath = join(fixture.home, ".local/state/agentscrape/process-queue.log");
    const queueRecord = join(queueDir, "preserved.yaml");
    const failedRecord = join(failedDir, "preserved.yaml");
    writeFileSync(queueRecord, "queue: preserved\n");
    writeFileSync(failedRecord, "failed: preserved\n");
    writeFileSync(logPath, "log preserved\n");

    const first = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(first.code).toBe(0);
    expect(existsSync(commandPath)).toBeFalse();
    expect(existsSync(plistPath)).toBeFalse();
    expect(text(queueRecord)).toBe("queue: preserved\n");
    expect(text(failedRecord)).toBe("failed: preserved\n");
    expect(text(logPath)).toBe("log preserved\n");

    const second = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(second.code).toBe(0);
  });
});

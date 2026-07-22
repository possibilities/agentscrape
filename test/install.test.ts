import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
      printf 'environment = { PATH => /tmp/foreign-bin }\n'
      exit 0
    fi
    printf 'service = %s\n' "$domain/$label"
    printf 'program = %s\n' "$program"
    printf 'environment = { PATH => %s }\n' "$path"
    printf 'plist = %s\n' "$plist"
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
    writeFileSync(firstCommandSnapshot, text(commandPath));
    writeFileSync(firstPlistSnapshot, text(plistPath));

    const second = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(second.code).toBe(0);

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

    const failed = await command(["bash", "scripts/install.sh"], {
      env: { ...fixture.env, FAKE_LAUNCHCTL_FAIL_BOOTSTRAP_ONCE: "1" },
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("restored previous owned state after failure");
    expect(text(commandPath)).toBe(previousCommand);
    expect(text(plistPath)).toBe(previousPlist);
    expect(text(receiptPath)).toBe(previousReceipt);
    expect(text(deployedShaPath)).toBe(previousDeployedSha);
    expect(text(fixture.launchctlLog)).toContain("bootout gui/");
    expect(
      text(fixture.launchctlLog).match(/bootstrap gui\//g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  test("uninstall removes only owned command and service and is idempotent", async () => {
    const fixture = installEnv();
    const installed = await command(["bash", "scripts/install.sh"], { env: fixture.env });
    expect(installed.code).toBe(0);

    const commandPath = join(fixture.home, ".local/bin/agentscrape");
    const plistPath = join(fixture.home, "Library/LaunchAgents/agentscrape.process-queue.plist");
    const queueDir = join(fixture.home, ".local/share/agentscrape/queue");

    const first = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(first.code).toBe(0);
    expect(existsSync(commandPath)).toBeFalse();
    expect(existsSync(plistPath)).toBeFalse();
    expect(existsSync(queueDir)).toBeTrue();

    const second = await command(["bash", "scripts/install.sh", "--uninstall"], {
      env: fixture.env,
    });
    expect(second.code).toBe(0);
  });
});

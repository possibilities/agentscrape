# Agentscrape operations

The operator lifecycle of the supported macOS standalone deployment: what the
installer requires and mutates, what the environment controls, and how
rollback, GC, and readiness behave. The behavioral contracts of the commands
themselves live in [contracts.md](contracts.md); the claimed security boundary
lives in the [threat model](threat-model.md).

## Runtime requirements

| Component | Requirement | Used for |
| --- | --- | --- |
| Bun | **At least 1.3.14**, matching `package.json` `engines.bun` | CLI and trusted TypeScript source execution |
| Production JavaScript dependencies | **Always** the frozen production dependency set; the standalone installer copies and seals it into the snapshot | Parsing, conversion, and extraction |
| `agent-browser` | Optional | JavaScript-rendered pages, browser sessions, and live canaries. Agentscrape invokes `agent-browser`, which delegates to `browserctl`; Agentscrape does not invoke `browserctl` directly. |
| `gh` | Optional | GitHub and Gist routes |
| `pdftotext` (poppler) | Optional | PDF extraction |
| `pandoc` | Optional | Conversion of GitHub `.rst` content, including repository READMEs and blob routes |
| `summaryctl` | Optional | Queue jobs whose record requests `summarize` |
| `agentbrain` | Optional | `reconcile-queue --apply` only |
| Trusted Git checkout plus `git`, `tar`, Bash, and core operating-system tools | Install/deploy only | Resolve and archive the exact commit, prepare the snapshot, and publish owned files |
| macOS `launchctl` and `plutil` | Supported standalone install only | Validate and manage the user LaunchAgent |

Several of these are unpublished local tools; see the README for what
Agentscrape does without them. Agentbuilds is commonly the trusted deployment
orchestrator but is not a production runtime dependency, and Python and
shellcheck are CI validation tools only.

## Distribution and version identity

The supported end-user distribution is the macOS standalone command, installed
as a sealed, effectively immutable snapshot from trusted Git. Sealing detects
ordinary mutation; it is not protection from malicious code with the same UID.
The package exports are trusted Bun TypeScript source contracts for repository
and linked-package use — there is no npm publication, transpiled JavaScript
distribution, general Node.js compatibility, or stability promise for
undeclared deep imports.

The package semantic version is the compatibility line reported by the CLI,
doctor, and extraction envelopes. A standalone deployment is identified more
narrowly by the exact Git SHA in its receipt and verified snapshot manifest;
semantic-version equality does not establish deployment-byte identity.

## Environment

| Variable | Runtime behavior |
| --- | --- |
| `HOME` | Supplies the default data home, managed `~/.local/bin/agent-browser` candidate, browserctl advisory-state location, and installer-owned user paths. The installer requires a normalized absolute, safely owned home. |
| `PATH` | Resolves Bun at install time and optional runtime executables. For `agent-browser`, a valid explicit override wins, then `$HOME/.local/bin/agent-browser`, then `PATH`. |
| `TMPDIR` | Influences the operating-system temporary directory used for explicitly retained diagnostic screenshots; those artifacts are not moved into the data home. |
| `AGENTSCRAPE_DATA_HOME` | Non-empty absolute runtime data root. It wins exactly and contains `queue/`, `retry/`, `failed/`, `frozen/`, `reconciliation/`, and the captured-corpus overlay. |
| `XDG_DATA_HOME` | Non-empty absolute fallback; runtime data becomes `$XDG_DATA_HOME/agentscrape`. Without either data variable, the fallback is `$HOME/.local/share/agentscrape`. The installer uses the same XDG fallback for its share directory. |
| `AGENTSCRAPE_AGENT_BROWSER_BIN` | A non-empty explicit `agent-browser` command/path. Runtime preserves an invalid configured value so spawn produces the normal missing-command classification; doctor reports it unavailable and does not fall back. |
| `AGENTSCRAPE_AGENT_BROWSER_TIMEOUT` | Positive finite seconds for browser commands; default 30 seconds. Missing, nonnumeric, zero, or negative values use the default. |
| `AGENTSCRAPE_CONDUIT_SOCKET` | Unix socket of an Agentweb conduit. When set together with a token file, Agentscrape asks the conduit before each browser navigation whether the URL's origin has an operator-established session, and attaches that session's storage state. Agentscrape never signs in and never stores credentials; it replays state a human established. An absent, misconfigured, or unreachable conduit degrades to unauthenticated extraction and never fails a fetch. |
| `AGENTSCRAPE_CONDUIT_TOKEN_FILE` | Path to the conduit's WORKER role credential. Read only from a bounded file, never from an argument. |
| `AGENTSCRAPE_BROWSER_SESSION` | Pins every otherwise-ephemeral operation to one operator-managed `agent-browser` session, so authenticated providers can reuse a session an operator already signed in. Agentscrape reuses it and never creates, authenticates, or closes it. An explicit `--session` still wins, and a name that is empty, over 128 characters, or outside `[A-Za-z0-9][A-Za-z0-9._-]*` is ignored in favor of the normal ephemeral session. |
| `AGENTSCRAPE_PROCESS_QUEUE_RETRY_INITIAL_DELAY_SECONDS` | Initial browser-host retry delay; finite values from 0.1 through 3600 seconds are accepted, otherwise the default is 1. |
| `AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_DELAY_SECONDS` | Retry cap; finite values from 0.1 through 3600 seconds are accepted, otherwise the default is 60. The effective cap is never below the initial delay. |
| `AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS` | Total attempts including the initial failed attempt; default 5. When present it must be an integer from 1 through 100 or queue processing fails closed. |
| `XDG_STATE_HOME` | Installer state defaults to `$XDG_STATE_HOME/agentscrape`, otherwise `$HOME/.local/state/agentscrape`. The HOME-scoped installer lock remains under `$HOME/.local/state/.agentscrape-installer`. |
| Installer overrides | The approved deployment overrides are `AGENTSCRAPE_INSTALL_BIN_DIR`, `AGENTSCRAPE_INSTALL_LAUNCH_AGENTS_DIR`, `AGENTSCRAPE_INSTALL_STATE_DIR`, `AGENTSCRAPE_INSTALL_SHARE_DIR`, `AGENTSCRAPE_INSTALL_BUN`, `AGENTSCRAPE_INSTALL_LAUNCHCTL`, and `AGENTSCRAPE_INSTALL_PLUTIL`. |

Queue resolution is explicit and shared by `submitScrapeJob()` and every
worker: `AGENTSCRAPE_DATA_HOME/queue` when that root is set, otherwise
`${XDG_DATA_HOME}/agentscrape/queue`, then `~/.local/share/agentscrape/queue`.

Retry delay is exponential, `min(effective maximum, initial × 2^(completed
failures - 1))`. The policy is captured when a retry chain begins, so later
environment changes do not rewrite an existing chain.

The managed wrapper always exports the installer-resolved share directory as
`AGENTSCRAPE_DATA_HOME`. The LaunchAgent plist receives only the `PATH` rendered
at installation and executes that wrapper; it does not inherit later
interactive-shell XDG, retry, or browser overrides. Interactive invocations of
the wrapper still inherit their calling shell except for the wrapper-fixed data
home.

Parser and option mistakes exit 2, separate from the runtime failures that exit
1; the full exit-code contract is in [contracts.md](contracts.md).

## Install and uninstall

```sh
./scripts/install.sh              # install or upgrade
./scripts/install.sh --uninstall  # idempotent removal
```

The installer resolves `HEAD^{commit}` and its exact tree once, archives only
that commit rather than worktree bytes, rejects tracked symlinks and gitlinks,
installs production dependencies in a private stage, and publishes the
verified, sealed result with an atomic no-replace rename as
`~/.local/state/agentscrape/runtime/<sha>` — files `0400`/`0500`, directories
`0500`, with a hashed manifest recording the commit, tree, and complete
inventory. It then installs an owned `~/.local/bin/agentscrape` wrapper
pointing at that snapshot, creates private queue data, and loads
`~/Library/LaunchAgents/agentscrape.process-queue.plist`. Every state override
sharing a HOME is serialized by one fail-closed
`~/.local/state/.agentscrape-installer` owner lock.

Verify after install:

```sh
agentscrape --help
launchctl print "gui/$(id -u)/agentscrape.process-queue"
```

The loaded service should reference `~/.local/bin/agentscrape`, the
installer-resolved queue directory, and the installer-rendered `PATH`.

Uninstall requires an exactly inspectable `launchctl` state plus correlated
command, plist, receipt, and deployed-SHA bytes; `<snapshot>/scripts/install.sh
--uninstall` stays usable after the source checkout is removed. It unloads the
service, removes only revalidated files, and fsyncs their parents under the
same lock. Ambiguous or foreign evidence is retained rather than deleted. Queue
files, failed jobs, browser/session data, logs, corpus captures, and every
published runtime snapshot survive uninstall; removing them is a separate
explicit operation.

## Rollback, cutover, and runtime GC

Cutover preflight classifies the public state into mutually exclusive cases:
first publication, an authenticated prior deployment, one recognized incomplete
state that retry can finish, and fully current. Expected-absent slots use
no-replace publication; expected-present slots are replaced only after the
destination still matches its classified device/inode immediately before
rename. Catchable failures make a conservative best-effort restoration, and the
deployed-SHA rename with a state-directory fsync is last.

There is no automatic recovery after process death or power loss. Any other
interrupted mixed state fails closed on the next run and requires an explicit
rerun or manual cleanup; the installer never deletes foreign or ambiguous
evidence.

To cut over from any predecessor deployment: stop new submissions, let the
active worker drain or archive its state, run `./scripts/install.sh`, verify
the two commands above, then resume submissions into the installed queue.

Runtime GC is never run by install or uninstall. Quiesce interactive commands
and workers first, then run `./scripts/install.sh --gc-runtime`. It takes the
same HOME-scoped lock, accepts only a fully correlated current installation
(preserving that receipt's SHA) or a fully absent public state (preserving
nothing), and refuses anything checkout-backed, incomplete, mismatched,
foreign, or ambiguous. It verifies every candidate snapshot's manifest before
deleting any, never executes a stale root's helper, and keeps the runtime
parent so repeat GC is idempotent. GC does not inspect process liveness and has
no rollback once deletion starts; an interruption can leave a partial root that
makes a later GC fail closed for manual inspection.

## Deployment readiness

`bun run x-readiness -- --once` probes the PATH-resolved Agentscrape executable
for both X presets and the timeline cursor flag. Each subprocess has a
five-second deadline and bounded output, and each completed check prints one
JSON object; exit 0 means ready, 1 means the binary is present but a required
capability is missing or unhealthy, and 2 means the binary is missing or a
probe/configuration error occurred. Without `--once`, use `--interval SECONDS`
and optional `--timeout SECONDS` to watch.

Subprocess timeout, cancellation, or output overflow is followed by at most a
fixed 100 ms teardown grace using local stdout/stderr cancellation rather than
waiting for pipe EOF. The runner sends `SIGKILL` to the original detached
process group, but descendants that create a new session with `setsid` may
survive and are not claimed as killed.

## Tests, coverage, and CI

`bun run check` is the contributor and CI default: typecheck, lint, then the
serial bounded suite. Before any of that it replaces `HOME` with a private
temporary directory and removes inherited Agentscrape, XDG, and Bun/Node
process-option state; `bun run test` and `bun run coverage` use the same
boundary. The suite makes no live internet calls, but it does use loopback
networking, so this is an isolation boundary rather than an external-network
sandbox.

`bun run coverage` adds text and LCOV reporters and requires at least 70%
aggregate line and function coverage, failing closed on missing, malformed, or
zero-denominator LCOV. That floor is a gate, not a claim of comprehensive
coverage; work in spawned CLI subprocesses is not necessarily attributed to the
parent report. CI runs the same check on Ubuntu and macOS, validates the shell
installer and plist, and rejects whitespace errors or any worktree change —
`.github/workflows/ci.yml` is the authority on the matrix and steps.

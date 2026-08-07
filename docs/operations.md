# Agentscrape operations

The operator lifecycle of the supported macOS standalone deployment: what the
installer requires and mutates, how snapshots are garbage collected, and how
cutover, rollback, readiness, and CI behave. The behavioral contracts of the
commands themselves live in [contracts.md](contracts.md).

## Runtime requirements

| Component | Requirement | Used for |
| --- | --- | --- |
| Bun | **Always exactly 1.3.14**, matching `package.json` `engines.bun` | CLI and trusted TypeScript source execution |
| Production JavaScript dependencies | **Always** the frozen production dependency set; the standalone installer copies and seals it into the snapshot | Parsing, conversion, and extraction |
| `agent-browser` | Optional | JavaScript-rendered pages, browser sessions, and live canaries. Agentscrape invokes `agent-browser`, which delegates to `browserctl`; Agentscrape does not invoke `browserctl` directly. |
| `gh` | Optional | GitHub and Gist routes |
| `pandoc` | Optional | Conversion of GitHub `.rst` content, including repository READMEs and blob routes |
| `summaryctl` | Optional | Queue jobs whose record requests `summarize` |
| `agentbrain` | Optional | `reconcile-queue --apply` only |
| Trusted Git checkout plus `git`, `tar`, Bash, and core operating-system tools | Install/deploy only | Resolve and archive the exact commit, prepare the snapshot, and publish owned files |
| macOS `launchctl` and `plutil` | Supported standalone install only | Validate and manage the user LaunchAgent |

Agentbuilds is commonly the trusted deployment orchestrator, but it is not a
production runtime dependency. Python and shellcheck are CI validation tools
only, not installer or Agentscrape runtime requirements.

## Distribution and version identity

`package.json` remains `private: true`. The supported end-user distribution is
the macOS standalone command installed as a sealed, effectively immutable
snapshot from trusted Git, usually through Agentbuilds. Sealing detects ordinary
mutation; it is not protection from malicious code with the same UID.

The package exports are trusted Bun TypeScript source contracts for repository
and linked-package use. There is no npm publication, transpiled JavaScript
distribution, general Node.js compatibility, or stability promise for undeclared
deep imports. The package semantic version is the compatibility line reported by
the CLI, doctor, and extraction envelopes. A standalone deployment is identified
more narrowly by the exact Git SHA recorded in its receipt and verified snapshot
manifest; semantic-version equality does not establish deployment-byte identity.

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

Retry delay is exponential, `min(effective maximum, initial × 2^(completed
failures - 1))`. The policy is captured when a retry chain begins, so later
environment changes do not rewrite an existing chain.

The managed wrapper always exports the installer-resolved share directory as
`AGENTSCRAPE_DATA_HOME`. The LaunchAgent plist receives only the `PATH` rendered
at installation and executes that wrapper; it does not inherit later
interactive-shell XDG, retry, or browser overrides. Interactive invocations of
the wrapper still inherit their calling shell except for the wrapper-fixed data
home.

## Install

```sh
./scripts/install.sh
```

The installer:

- resolves `HEAD^{commit}` and its exact tree once, requires the runtime verifier in that commit, archives only that commit (never helper or application bytes from the worktree), rejects tracked symlinks/gitlinks, and installs production dependencies in a private stage with `bun install --frozen-lockfile --production --ignore-scripts --backend=copyfile`
- publishes the verified, sealed stage with a native atomic no-replace rename as `~/.local/state/agentscrape/runtime/<sha>`; files are `0400`/`0500`, directories are `0500`, and a hashed manifest records the commit/tree and complete inventory, including the verifier
- requires `HOME` and installer-created private directories to have the current uid without group/other write or special bits, and serializes every state override that shares a HOME with one fail-closed `~/.local/state/.agentscrape-installer` owner lock held through classification and mutation
- creates private queue data under `${AGENTSCRAPE_INSTALL_SHARE_DIR:-${XDG_DATA_HOME:-~/.local/share}/agentscrape}/{queue,failed}`; workers create private `frozen` and `retry` state alongside it
- installs an owned executable at `~/.local/bin/agentscrape`, pointing to the sealed snapshot rather than the checkout
- renders the LaunchAgent from the snapshot's tracked plist and loads `~/Library/LaunchAgents/agentscrape.process-queue.plist`
- exports the exact installed queue root through `AGENTSCRAPE_DATA_HOME` in the owned wrapper so interactive and LaunchAgent runs keep using the same queue path even if later shell `XDG_DATA_HOME` differs
- refuses unrelated artifacts, malformed snapshots/locks, or unrelated loaded services, and rolls back to a previously snapshotted owned deployment if cutover fails

Snapshot sealing and repeated no-follow hash verification detect ordinary
corruption and unsafe metadata. They are not an immutability boundary against
malicious processes running as the same UID.

Verify after install:

```sh
agentscrape --help
launchctl print "gui/$(id -u)/agentscrape.process-queue"
```

The loaded service should reference `~/.local/bin/agentscrape`, the
installer-resolved queue directory, and the installer-rendered `PATH`.

## Uninstall

```sh
./scripts/install.sh --uninstall
```

Uninstall is idempotent and requires an exactly inspectable `launchctl` state
plus correlated command, plist, receipt, and deployed-SHA bytes. Snapshot
receipts use a bounded no-follow manifest/helper preflight and then the sealed
helper's full inventory verification, so `<snapshot>/scripts/install.sh
--uninstall` remains usable after the source checkout is removed and rollback
publication does not depend on Git. Exact 8- or 12-line checkout receipts can
migrate only while their exact source checkout and commit tree remain available
and agree with the current checkout's Git authority. The new installer
uninstalls a checkout-backed receipt only from that same checkout when its
commit also contains the authenticated runtime helper; helperless predecessors
fail closed without changing public evidence. It unloads the service, removes
only revalidated files, and fsyncs their parent directories under the
HOME-scoped lock. Catchable failures attempt a conservative no-replace restore
when the affected pathname is still absent or unchanged; ambiguous evidence is
retained. Queue files, failed jobs, browser/session data, logs, corpus
captures, and every published runtime snapshot are preserved by uninstall;
runtime cleanup is a separate explicit operation.

## Runtime snapshot garbage collection

Runtime GC is never run by install or uninstall. Quiesce interactive commands
and workers that may still be using an old snapshot, then run:

```sh
./scripts/install.sh --gc-runtime
```

The command takes the same HOME-scoped installer lock before classifying public
state and holds it through deletion and the runtime-parent fsync. Its accepted
states and helper authority are:

| Public state | Helper authority | Protection and result |
| --- | --- | --- |
| Exactly installed: owned regular command, plist, current 12-line snapshot receipt, and deployed SHA all agree; `launchd` is exactly owned or absent | Authenticated `HEAD` helper from the invoking Git checkout; if that checkout is gone, the fully preflighted and verified protected receipt helper when invoked from that installed snapshot | Preserve the receipt SHA and delete every other verified snapshot |
| Exactly uninstalled: all four public artifacts and the service are absent | Authenticated `HEAD` helper from a trusted Git checkout only | Protect nothing and delete every verified snapshot |
| Checkout-backed, incomplete, mismatched, foreign, or ambiguous | None | Refuse without deletion |

Before deleting anything, the helper requires an owned plain mode-`0700`
runtime parent, at most 64 immediate children, canonical lowercase 40-hex owned
mode-`0500` snapshot directories, the protected root when one is declared, and
complete manifest verification of every root. A stale root's helper is
inventory only and is never executed. Verified stale roots are reverified and
removed deterministically with manifest-driven no-follow unlink/rmdir
operations; the runtime directory itself remains, so repeat GC is idempotent.

GC does not inspect process liveness: operator quiescence is required. There is
no rollback after deletion starts. If GC is interrupted after opening a root
for deletion, that partial/noncanonical root makes a later GC fail closed for
manual inspection. As elsewhere, active malicious same-UID namespace races are
outside the claimed boundary.

## Rollback and cutover

Preflight classifies mutually exclusive A (first publication), B (authenticated
prior deployment), C (exact current command/plist/receipt with an absent or
safe noncurrent deployed SHA), and D (fully current). C is the one recognized
incomplete state: retry publishes the current deployed SHA, while a catchable
failed attempt restores the prior deployed bytes or absence. D avoids replacing
already-current public files. Expected-absent public slots use native
no-replace publication. Expected-present slots are replaced only after the
destination still matches its classified device/inode immediately before
rename. A same-UID malicious process can still exchange that pathname in the
tiny check-to-rename instruction gap; active same-UID namespace attacks are
outside the claimed boundary. Catchable cutover failures make a conservative
best-effort restoration. During an authorized helperless checkout migration,
this restores the exact correlated checkout-backed public bytes captured before
cutover; it does not fabricate a snapshot for a commit that predates the
runtime helper. The final deployed-SHA rename and state-directory fsync are
last.

There is no automatic recovery after process death or power loss. An
interrupted mixed public state other than conservative C fails closed on the
next run and requires explicit rerun or manual cleanup; the installer never
deletes foreign or ambiguous evidence.

For an operator cutover from any predecessor deployment, use this generic
sequence:

1. Stop new queue submissions and any external schedulers.
2. Let the currently active worker drain, or archive/export its state outside this repository.
3. Install this checkout with `./scripts/install.sh`.
4. Verify `agentscrape --help` and `launchctl print "gui/$(id -u)/agentscrape.process-queue"`.
5. Resume submissions into the installed queue directory.

## Deployment readiness

`bun run x-readiness -- --once` probes the PATH-resolved Agentscrape executable
for both X presets and the timeline cursor flag. Each subprocess has a
five-second deadline and bounded output. Each completed status check prints one
JSON object; exit 0 means ready, 1 means the binary is present but a required
capability is missing or unhealthy, and 2 means the binary is missing or a
probe/configuration error occurred. Without `--once`, use `--interval SECONDS`
and optional `--timeout SECONDS` to watch.

Under a responsive event loop, a subprocess timeout, cancellation, output
overflow, or capture/wait terminal event is followed by at most a fixed 100 ms
teardown grace, using local stdout/stderr cancellation rather than waiting
indefinitely for pipe EOF. A requested timeout therefore settles in `timeoutMs`
plus up to 100 ms plus event-loop scheduling. The runner sends `SIGKILL` to the
original detached process group, but arbitrary descendants that create a new
session with `setsid` may survive; those processes are outside containment and
are not claimed as killed.

## Tests, coverage, and CI

The offline suite covers handler fixtures, corpus replay, preset invariants,
envelope projection, recorded and fake-transport live feed discovery, output
formatting, and command smoke tests. It makes no live internet calls.

`bun run check` is the contributor and CI default. Before typecheck, lint, and
serial bounded tests, it replaces `HOME` with a private temporary directory and
removes inherited Agentscrape, XDG config/data/state, and Bun/Node
process-option state; `bun run test` and `bun run coverage` use the same
isolated boundary. Tests intentionally use loopback networking, so this is not
an external-network sandbox.

`bun run coverage` runs the full serial suite with text and LCOV reporters,
strictly aggregates each LCOV record's `LF`/`LH` line and `FNF`/`FNH` function
summaries, and requires at least 70% aggregate coverage for both lines and
functions. Missing, malformed, incomplete, or zero-denominator LCOV fails
closed. This floor is a gate, not a claim of comprehensive coverage; work in
spawned CLI subprocesses is not necessarily attributed to the parent report.
After a successful Linux gate, CI uploads `coverage/lcov.info` as
`coverage-lcov-ubuntu-24.04` for seven days.

CI runs the check on Ubuntu 24.04 and macOS 26, validates the shell installer
and plist, and rejects whitespace errors or any tracked, staged, or untracked
worktree changes.

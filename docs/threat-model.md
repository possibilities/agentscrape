# Agentscrape threat model

The security boundary Agentscrape claims, and — more usefully — the boundaries
it does not. What each command actually does is in
[contracts.md](contracts.md); the deployment lifecycle is in
[operations.md](operations.md). This document says which of those behaviors are
security properties and which are conveniences that happen to look like one.

## Assets

Agentscrape handles or mutates provider URLs, fetched content, account-visible
data, browser profiles and session state; Markdown destinations, frontmatter,
summaries, raw HTML, screenshots, and corpus captures; queue records, retry,
failure and frozen envelopes, reconciliation receipts, claims, and archives;
the installed command, plist, deployed-SHA marker, receipt, sealed snapshots
and manifests; and local configuration, environment values, and diagnostics
that may contain paths or secrets.

The goals are to keep accidental secrets out of bounded diagnostics and
structured failure output, refuse unsafe network destinations where the
selected transport can enforce that, avoid following unsafe filesystem objects,
preserve explicit queue and install evidence, and fail closed when an operation
cannot prove the state it intends to mutate. These are scoped guarantees, not a
sandbox.

## Trusted computing base

The operator is expected to trust the selected Git commit and its tracked code,
the frozen JavaScript dependencies, Bun, the operating system and filesystem,
registered TypeScript handlers, and every external executable Agentscrape is
allowed to invoke. A trusted deployment environment must also trust its Git
authority and dependency acquisition path. Official and registered handlers
execute as unsandboxed process code: a malicious handler, dependency, runtime,
external executable, or operating system bypasses application-level policy.

**A malicious process running as the same UID is outside the boundary**, as are
root and administrators. Ownership, mode, no-follow, identity, hash, and fsync
checks defend against accidents, ordinary corruption, unsafe pre-existing
objects, and bounded races. They are not an isolation boundary against an
active same-UID attacker, and every check-to-rename window documented elsewhere
remains racy against one.

Environment variables, command arguments, local preset files, queue records,
recorded responses, provider responses, and PATH-selected tools are all
operator-controlled inputs. Agentscrape validates each only as far as the
operation documents; it does not infer that local input is benign because the
current user can read it.

## Untrusted content

Remote and recorded provider output crosses an untrusted boundary, and all
emitted output stays untrusted. Handlers and envelope projection enforce their
structural, size, relation-count, URL, and redaction contracts, and the HTML
converters remove a small set of active elements and filter recognized anchor
and image destinations to credential-free HTTP(S) or safe relative references —
the exact link and MIME admission rules are in
[contracts.md](contracts.md#output-contract).

None of that is global Markdown or HTML sanitization, prompt-injection defense,
domain authorization, or egress enforcement, and none of it makes labels,
alternative text, code, or metadata trusted. Direct Markdown, GitHub
passthrough, and provider-authored text keep their bytes unchecked. Corpus HTML
and retained HTML or screenshots are raw evidence, not sanitized output: they
can contain private account data, active markup, tracking values, or secrets,
which is why shipped samples are reduced and hygiene-gated.

## Network

Agentscrape has separate network models rather than one global allowlist.

**Direct HTTP(S)** — Direct Markdown and live feed transports are public-only by
default. Each hop resolves A/AAAA records, rejects disallowed destinations,
pins a selected address while preserving Host or SNI identity, and repeats the
checks after redirects, ignoring ambient proxy variables. Pinning addresses DNS
rebinding between validation and connection; it does not make responses
trusted, guarantee availability, or constrain networking done outside the
direct helper.

**Browser transport** — Live browser navigation is denied unless the operation
carries explicit `--allow-private-network`. The browser/CDP profile boundary
cannot prove redirect, worker, extension, or subresource destinations, so that
flag is **unrestricted, unverifiable browser/profile egress: consent, not
enforcement**. Agentscrape does not present DNS preflight as a browser sandbox.
Browser profiles, extensions, and browserctl are part of the trusted external
browser boundary.

**External tools** — `gh` owns GitHub authentication and transport;
`summaryctl` and `agentbrain` do their own external work when their narrow
commands run; trusted custom handlers can perform arbitrary unsandboxed
networking. Live canaries intentionally contact configured public providers.
Recorded feed parsing, corpus replay, HTML conversion, and `doctor` are offline
with respect to Agentscrape-owned behavior.

| Executable | Invocation scope | What is not claimed |
| --- | --- | --- |
| Bun | Always; runs trusted source and installer helpers | General Node.js compatibility or sandboxing of trusted code |
| `agent-browser` | Browser-backed extraction, session management, and canaries | Destination-level egress enforcement; direct `browserctl` invocation by Agentscrape |
| `gh` | GitHub/Gist reads | Auth health, transport isolation, or provider availability |
| `pdftotext` | PDF extraction only | Document fidelity or recovery of scans with no text layer |
| `pandoc` | GitHub `.rst` conversion only | General document conversion service |
| `summaryctl` | Only queue records with `summarize` | Local-only processing or provider behavior inside that tool |
| `agentbrain` | `reconcile-queue --apply` only | Exactly-once remote acceptance without its idempotency contract |
| `git`, `tar`, Bash, and core OS tools | Trusted install/deploy path | Runtime extraction dependencies |
| macOS `launchctl` and `plutil` | Standalone service install, inspection, and removal | Cross-platform service management |

Child processes receive explicit argv rather than a shell, with bounded
stdout/stderr, deadlines, cancellation, and a fixed teardown grace. The runner
kills the original detached process group; a descendant that creates a new
session escapes it and is not claimed as killed. Doctor reports only whether a
configured path or PATH candidate is an executable regular file — it runs
nothing and checks no version, auth, or health.

## Filesystem and state

Sensitive managed directories and new evidence use restrictive ownership and
modes. Security-sensitive readers and publishers use bounded reads, no-follow
opens or lstat/fstat identity checks, private staging, no-clobber or
identity-checked publication where documented, and parent/file fsync for
durable queue and install transitions. Those properties hold for the named
operations; they are not a universal transactional filesystem or a power-loss
guarantee.

Queue transitions preserve captured source bytes in retry, failure, frozen, or
reconciliation evidence before retiring the proven source inode, and
per-generation claims coordinate workers and recover dead owners. Queue
processing is at least once, and reconciliation can resubmit after a crash
between external acceptance and durable local receipt; correctness there
depends on `agentbrain` idempotency.

Destinations, corpus captures, queue processing, reconciliation, browser
sessions, installation, and runtime GC all mutate local state deliberately.
"Agentscrape never writes back to providers" is not a claim of local read-only
behavior.

Install, uninstall, and GC classify public state from correlated evidence and
refuse to act on anything foreign, malformed, or ambiguous. Manifest
verification and sealing detect ordinary corruption, not malicious same-UID
modification. There is no universal recovery after process death or power loss:
one interrupted state is retryable and the rest require explicit rerun or
manual cleanup, and GC has no rollback once deletion begins.

## Explicit non-guarantees

Agentscrape does not claim:

- browser destination enforcement after unrestricted consent;
- trustworthiness, prompt safety, or global Markdown/HTML sanitization of output, provider content, or raw evidence;
- domain authorization or egress safety from recognized-link destination filtering;
- trustworthiness or safety of direct-Markdown content admitted by the strict final-2xx MIME policy;
- exactly-once provider, destination, summary, or reconciliation effects;
- containment of trusted custom handlers or escaped external-command descendants;
- provider availability, authentication health, or optional-tool health from doctor;
- manifest, receipt, service, or deployed-byte verification from doctor's source label;
- protection from malicious same-UID processes, root, administrators, trusted-code compromise, or hostile PATH-selected executables;
- whole-operation rollback across power loss, universal interrupted-install recovery, or GC rollback; or
- npm publication, transpiled JavaScript, general Node.js support, or undeclared deep-import compatibility.

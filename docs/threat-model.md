# Agentscrape threat model

This document states the security boundary claimed by Agentscrape. It distinguishes enforced behavior from operator assumptions and known non-guarantees. The operational details in the [README](../README.md) remain part of the contract.

## Assets

Agentscrape can handle or mutate these security-relevant assets:

- provider URLs, fetched content, account-visible data, browser profiles, cookies, and session state;
- Markdown destinations, frontmatter, summaries, raw HTML, diagnostic screenshots, and corpus captures;
- pending queue records, retry/failure/frozen envelopes, reconciliation records and receipts, claims, archives, and logs;
- the installed command, LaunchAgent plist, deployed-SHA marker, install receipt, sealed runtime snapshots, manifests, and production dependencies; and
- local configuration, environment values, executable selection, and diagnostics that may contain paths or secrets.

The main goals are to keep accidental secrets out of bounded diagnostics and structured failure output, prevent unsafe network destinations where the selected transport can enforce that policy, avoid following unsafe filesystem objects, preserve explicit queue/install evidence, and fail closed when an operation cannot prove the state it intends to mutate. These are scoped guarantees, not a sandbox.

## Trust boundaries and authorities

### Trusted computing base

The operator is expected to trust the selected Git commit, its tracked TypeScript and shell code, the frozen JavaScript dependencies, Bun 1.3.14, the operating system and filesystem, registered TypeScript handlers, and every external executable that Agentscrape is allowed to invoke. A trusted deployment environment must also trust its Git authority and dependency acquisition path.

Official and explicitly registered TypeScript handlers execute as unsandboxed process code. A malicious handler, dependency, Bun runtime, external executable, or operating system can bypass application-level policy.

A malicious process running as the same UID can race or rewrite user-owned namespaces and data. Root and administrators can do more. Active same-UID attackers, root, and administrators are outside the claimed boundary. Ownership, mode, no-follow, identity, hash, and fsync checks are defenses against accidents, ordinary corruption, unsafe pre-existing objects, and bounded races; they are not an isolation boundary against those actors.

### Authorities

- `package.json` is the single production authority for the package semantic version and exact Bun engine. Semver identifies a compatibility line, not installed bytes.
- The trusted registry and preset contracts authorize automatic routing and output invariants. Local YAML presets remain data-only; executable handlers require trusted in-process registration.
- The requested URL, selected route, and explicit `--allow-private-network` consent authorize network behavior for one operation. Consent does not make returned content trustworthy.
- Standalone deployment identity comes from the exact Git commit/tree, authenticated runtime helper, complete snapshot manifest, correlated receipt, and deployed-SHA evidence. The installer, uninstaller, and runtime GC own that classification.
- Doctor source identity is deliberately weaker and informational. A normalized source root ending in `runtime/<lowercase-40-hex>` is labeled `managed_snapshot`; doctor does not read or verify a manifest, receipt, deployed-SHA marker, service, or snapshot contents.
- Queue generation IDs, source inode snapshots, private claims, and durable envelopes authorize queue transitions. They do not prove that an external provider operation happened exactly once.

Environment variables, command arguments, local preset files, queue records, recorded responses, provider responses, and PATH-selected tools are operator-controlled inputs. Agentscrape validates each only to the extent documented for the operation; it does not infer that local input is benign merely because the current user can read it.

## Untrusted content boundary

Remote provider output and recorded provider output cross an untrusted boundary. All emitted output remains untrusted. Typed handlers and envelope projection enforce their current structural, size, relation-count, URL, and redaction contracts, but emitted Markdown and provider text must still be treated as untrusted by downstream renderers and agents.

The HTML converters remove a small set of active elements and filter recognized anchor and image destinations. Selected schema and GitHub-generated Markdown links use the same policy. Surrounding whitespace is trimmed; empty values, remaining whitespace/control/format characters, malformed percent escapes, backslashes, angle brackets, quotes, backticks, protocol-relative references, credentials, and schemes other than HTTP(S) are rejected. A bounded six-pass classification copy decodes percent escapes and HTML entities to expose smuggling, but emitted destinations are never taken from that copy. Absolute HTTP(S) destinations are normalized; relative path, query, and fragment references resolve only against a valid HTTP(S) base, or remain relative when no base exists. Unsafe anchors are unwrapped and unsafe images become escaped text alternatives or disappear.

This filtering is not global Markdown or HTML sanitization, prompt-injection defense, domain authorization, or network-egress enforcement. It does not inspect arbitrary Markdown/HTML constructs or make labels, alternative text, code, or metadata trusted.

Direct Markdown, GitHub passthrough content, and provider-authored Markdown/text are unchecked and preserve their current bytes. A final successful 2xx direct `.md` response is admitted only with exactly one raw `Content-Type` field line that strictly parses as `text/markdown`; aliases and all other types are rejected. Type, subtype, and parameter names are ASCII case-insensitive. The parser accepts SP/HTAB OWS at field, semicolon, and equals boundaries, RFC token and quoted-string parameter values, valid quoted-pairs, and commas only inside quoted strings. It rejects controls, non-ASCII, malformed or trailing syntax, unquoted separators/commas, missing parameter names, empty or trailing parameter segments, and duplicate parameter names. `charset` is optional; if present once its decoded value must be exactly `utf-8` case-insensitively. Other unique valid parameters are allowed. Requiring this field is an intentional compatibility break for direct Markdown servers that omit it or return historical aliases such as `text/plain`, `text/x-markdown`, or `application/markdown`.

Redirect MIME is ignored; only the final 2xx is checked, and its URL need not end in `.md`. Status, authentication, 304, and redirect failures precede MIME admission. There is no sniff, HEAD request, probe, fallback, or extra request, and `X-Content-Type-Options` is irrelevant. Exactly zero or one raw `Content-Encoding` field line is admitted; one must be SP/HTAB-trimmed `identity` case-insensitively, while duplicate lines, comma lists, and nonidentity values are unsupported. Both encoding and MIME are checked before Content-Length or body consumption. After response handling, existing status and redirect precedence is preserved, unsupported encoding precedes the fixed nonretryable MIME provider error, and rejected bodies are discarded. Admitted bytes still pass the existing limits, identity, and fatal UTF-8 checks; MIME admission does not make their content trusted. Downstream renderers should disable raw HTML and remote images (or use a separately enforced image proxy), and consumers must not automatically follow emitted links. Allowed HTTP(S) destinations can still track a renderer or target private services when fetched. Envelope media types, hashes, and relation lists do not imply content safety.

Corpus HTML and retained HTML/screenshots are raw evidence, not sanitized output. They can contain private account data, active markup, tracking values, or secrets.

## Network models

Agentscrape has separate network models rather than one global allowlist:

### Direct HTTP(S)

Direct Markdown and live feed transports are public-only by default. Each direct hop resolves A/AAAA records, rejects any disallowed destination, pins a selected address while preserving HTTP Host or HTTPS SNI/certificate identity, and repeats checks after redirects. HTTPS downgrades and credential- or secret-bearing URLs are rejected where documented. Ambient HTTP proxy variables are not used by these direct transports.

For direct Markdown, `--allow-private-network` permits valid private/reserved destinations while retaining address pinning and redirect revalidation. Live feed discovery has no private-network opt-in.

DNS rebinding between the validated resolution and the pinned connection is addressed by pinning, but this does not make response content trusted, guarantee remote availability, or constrain networking performed outside the direct helper.

### Browser transport

Browser-backed live navigation is denied unless the operation has explicit `--allow-private-network` consent. The browser/CDP profile boundary cannot prove redirect, worker, extension, or subresource destinations. Consent is therefore **unrestricted, unverifiable browser/profile egress; it is not enforcement**. Agentscrape does not present DNS preflight as a browser sandbox.

Agentscrape invokes `agent-browser`, which delegates to `browserctl`; Agentscrape does not invoke `browserctl` directly. Browser profiles, extensions, browserctl, and their network behavior are part of the trusted external browser boundary.

### External and custom networking

`gh` owns GitHub authentication and network transport for GitHub/Gist routes. `summaryctl` and `agentbrain` may perform their own external work when their narrowly scoped commands are requested. Their network policy, credentials, and provider behavior are outside the direct HTTP policy. Trusted custom handlers can perform arbitrary networking and are not sandboxed.

Live canaries intentionally contact configured providers. Installation may use trusted Git and Bun dependency acquisition in the deployment environment. Agentbuilds may orchestrate deployment, but it is neither invoked nor required by the Agentscrape runtime.

Recorded feed parsing, corpus replay, HTML conversion, and `doctor` are offline with respect to Agentscrape-owned behavior. Doctor performs only executable stat/PATH resolution, source-path classification, and reading Bun's in-process version string: it starts no child, browser, provider, queue, service, or Agentbuilds operation and performs no optional-executable version, auth, health, or receipt probe.

## External command boundary

| Executable | Invocation scope | What is not claimed |
| --- | --- | --- |
| Bun | Always; runs trusted source and installer helpers | General Node.js compatibility or sandboxing of trusted code |
| `agent-browser` | Browser-backed extraction, session management, and canaries | Destination-level egress enforcement; direct `browserctl` invocation by Agentscrape |
| `gh` | GitHub/Gist reads | Auth health, transport isolation, or provider availability |
| `pandoc` | GitHub `.rst` conversion only | General document conversion service |
| `summaryctl` | Only queue records with `summarize` | Local-only processing or provider behavior inside that tool |
| `agentbrain` | `reconcile-queue --apply` only | Exactly-once remote acceptance without its idempotency contract |
| `git`, `tar`, Bash, and core OS tools | Trusted install/deploy path | Runtime extraction dependencies |
| macOS `launchctl` and `plutil` | Standalone service install, inspection, and removal | Cross-platform service management |

Executable availability means only that the configured path or PATH candidate is an executable regular file. Doctor does not execute tools, inspect tool versions, check authentication, or report resolved paths. Missing optional executables never change doctor status; only an exact Bun mismatch makes doctor fail.

Child processes receive explicit argv rather than a shell from the TypeScript runner, with bounded stdout/stderr, deadlines, cancellation, and a fixed teardown grace. The runner kills the original detached process group. A descendant that creates a new session can escape that group and survive; arbitrary external tools are not containment-safe merely because the direct child is bounded.

## Filesystem and state model

Default runtime data uses `AGENTSCRAPE_DATA_HOME`, then `XDG_DATA_HOME/agentscrape`, then `$HOME/.local/share/agentscrape`. Explicit data roots must be non-empty absolute paths. The managed wrapper fixes `AGENTSCRAPE_DATA_HOME` to the installer-resolved share directory so its queue does not drift with later XDG changes.

Sensitive managed directories and new evidence use restrictive ownership and modes. Security-sensitive readers and publishers use bounded reads, no-follow opens or lstat/fstat identity checks, private staging, no-clobber or identity-checked publication where documented, and parent/file fsync for durable queue/install transitions. Those properties apply to the named operations; they are not a universal transactional filesystem or power-loss guarantee.

Queue transitions preserve the captured source bytes in retry, failure, frozen, or reconciliation evidence before retiring the proven source inode. Per-generation claims coordinate workers and recover dead owners. A concurrent replacement is preserved rather than unlinked. Queue processing is at least once: a crash after provider or destination success but before source retirement can repeat work. Reconciliation can also resubmit after a crash between external acceptance and durable local receipt; correctness then depends on `agentbrain` idempotency.

Destinations, corpus captures, queue processing, reconciliation apply, browser sessions, installation, and runtime GC intentionally mutate local state. Agentscrape's statement that it does not write back to providers must not be interpreted as local read-only behavior.

## Artifact guarantees and limits

Ordinary CLI/API fetches and queue jobs do not retain raw HTML sidecars or diagnostic screenshots. `fetch-markdown --retain-artifacts` is the explicit exception and cannot be combined with envelope output.

Retained HTML sidecars are preflighted against per-file and aggregate limits, use private same-directory staging, and publish each pathname atomically with mode `0600` or stricter. They do not promise set-level crash atomicity or no-clobber publication. A selector-failure screenshot uses a random private temporary directory and random filename. Its limit is checked after the external browser command returns, so the browser may transiently write more than the accepted limit. Failed cleanup is best effort, and successful evidence can survive a crash for operator or operating-system cleanup; there is no startup sweep.

Corpus capture is a separate explicit raw-evidence workflow with private modes, per-file/aggregate bounds, and atomic sample-directory publication. Its HTML and expected Markdown are not sanitized. Structured failures and diagnostics are bounded and redacted, but redaction is defense in depth rather than permission to log arbitrary secrets.

## Standalone install, rollback, and runtime GC

The standalone installer resolves one exact `HEAD^{commit}` and tree, authenticates the runtime helper from that commit, archives tracked bytes rather than application/helper bytes from the worktree, rejects tracked symlinks and gitlinks, installs frozen production dependencies without lifecycle scripts, records a complete hashed manifest, seals modes, and publishes the lowercase-SHA snapshot with native atomic no-replace semantics. Public wrapper, plist, receipt, and deployed-SHA cutover is serialized by the HOME-scoped owner lock and uses correlated evidence and identity checks.

Manifest verification and sealing detect ordinary corruption and unsafe metadata. They do not make a user-owned snapshot immutable against malicious same-UID code. The small check-to-rename namespace race called out in the README remains outside the boundary.

Catchable install/uninstall failures attempt conservative restoration only while the affected pathname is absent or still matches classified evidence. Foreign, malformed, helperless-unauthorized, or ambiguous evidence is retained and causes a fail-closed refusal rather than deletion.

**ASR-24 recovery limit:** there is no universal automatic recovery after process death or power loss. An interrupted mixed public state is accepted only when it exactly matches the one recognized retryable incomplete class; other mixed or ambiguous states require an explicit rerun or manual cleanup. Fsync and rollback narrow failure windows but do not promise whole-install crash atomicity.

Runtime GC is separate and never automatic. It verifies every candidate snapshot, preserves the protected receipt SHA when installed, and removes only verified unprotected roots under the same installer lock.

**ASR-25 GC limits:** the operator must quiesce interactive commands, workers, and external schedulers before GC. GC does not inspect process liveness, has no rollback after deletion begins, and cannot guarantee uninterrupted cleanup. Interruption can leave a partial/noncanonical root that makes later GC fail closed for manual inspection. Active same-UID namespace races remain excluded.

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

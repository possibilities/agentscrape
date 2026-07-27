# Agentscrape

Fetch and extract web content through an agent-friendly Bun CLI.

Agentscrape does not write back to remote providers. It is not read-only locally: commands can write destinations, capture corpus fixtures, convert HTML into sibling Markdown files, enqueue and fail queue records, reconcile archived records when `--apply` is given, create browser session state, and the installer mutates the user command and LaunchAgent paths it owns.

## Runtime requirements

- Bun 1.3.14
- macOS `launchctl` and `plutil` for the standalone queue worker installer
- `agent-browser` available in `PATH` for JavaScript-rendered pages and live canaries

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

Snapshot sealing and repeated no-follow hash verification detect ordinary corruption and unsafe metadata. They are not an immutability boundary against malicious processes running as the same UID.

Verify after install:

```sh
agentscrape --help
launchctl print "gui/$(id -u)/agentscrape.process-queue"
```

The loaded service should reference `~/.local/bin/agentscrape`, the installer-resolved queue directory, and the installer-rendered `PATH`.

## Uninstall

```sh
./scripts/install.sh --uninstall
```

Uninstall is idempotent and requires an exactly inspectable `launchctl` state plus correlated command, plist, receipt, and deployed-SHA bytes. Snapshot receipts use a bounded no-follow manifest/helper preflight and then the sealed helper's full inventory verification, so `<snapshot>/scripts/install.sh --uninstall` remains usable after the source checkout is removed and rollback publication does not depend on Git. Exact 8- or 12-line checkout receipts can migrate only while their exact source checkout and commit tree remain available and agree with the current checkout's Git authority. The new installer uninstalls a checkout-backed receipt only from that same checkout when its commit also contains the authenticated runtime helper; helperless predecessors fail closed without changing public evidence. It unloads the service, removes only revalidated files, and fsyncs their parent directories under the HOME-scoped lock. Catchable failures attempt a conservative no-replace restore when the affected pathname is still absent or unchanged; ambiguous evidence is retained. Queue files, failed jobs, browser/session data, logs, corpus captures, and every published runtime snapshot are preserved by uninstall; runtime cleanup is a separate explicit operation.

## Runtime snapshot garbage collection

Runtime GC is never run by install or uninstall. Quiesce interactive commands and workers that may still be using an old snapshot, then run:

```sh
./scripts/install.sh --gc-runtime
```

The command takes the same HOME-scoped installer lock before classifying public state and holds it through deletion and the runtime-parent fsync. Its accepted states and helper authority are:

| Public state | Helper authority | Protection and result |
| --- | --- | --- |
| Exactly installed: owned regular command, plist, current 12-line snapshot receipt, and deployed SHA all agree; `launchd` is exactly owned or absent | Authenticated `HEAD` helper from the invoking Git checkout; if that checkout is gone, the fully preflighted and verified protected receipt helper when invoked from that installed snapshot | Preserve the receipt SHA and delete every other verified snapshot |
| Exactly uninstalled: all four public artifacts and the service are absent | Authenticated `HEAD` helper from a trusted Git checkout only | Protect nothing and delete every verified snapshot |
| Checkout-backed, incomplete, mismatched, foreign, or ambiguous | None | Refuse without deletion |

Before deleting anything, the helper requires an owned plain mode-`0700` runtime parent, at most 64 immediate children, canonical lowercase 40-hex owned mode-`0500` snapshot directories, the protected root when one is declared, and complete manifest verification of every root. A stale root's helper is inventory only and is never executed. Verified stale roots are reverified and removed deterministically with manifest-driven no-follow unlink/rmdir operations; the runtime directory itself remains, so repeat GC is idempotent.

GC does not inspect process liveness: operator quiescence is required. There is no rollback after deletion starts. If GC is interrupted after opening a root for deletion, that partial/noncanonical root makes a later GC fail closed for manual inspection. As elsewhere, active malicious same-UID namespace races are outside the claimed boundary.

## Rollback and cutover

Preflight classifies mutually exclusive A (first publication), B (authenticated prior deployment), C (exact current command/plist/receipt with an absent or safe noncurrent deployed SHA), and D (fully current). C is the one recognized incomplete state: retry publishes the current deployed SHA, while a catchable failed attempt restores the prior deployed bytes or absence. D avoids replacing already-current public files. Expected-absent public slots use native no-replace publication. Expected-present slots are replaced only after the destination still matches its classified device/inode immediately before rename. A same-UID malicious process can still exchange that pathname in the tiny check-to-rename instruction gap; active same-UID namespace attacks are outside the claimed boundary. Catchable cutover failures make a conservative best-effort restoration. During an authorized helperless checkout migration, this restores the exact correlated checkout-backed public bytes captured before cutover; it does not fabricate a snapshot for a commit that predates the runtime helper. The final deployed-SHA rename and state-directory fsync are last.

There is no automatic recovery after process death or power loss. An interrupted mixed public state other than conservative C fails closed on the next run and requires explicit rerun or manual cleanup; the installer never deletes foreign or ambiguous evidence.

For an operator cutover from any predecessor deployment, use this generic sequence:

1. Stop new queue submissions and any external schedulers.
2. Let the currently active worker drain, or archive/export its state outside this repository.
3. Install this checkout with `./scripts/install.sh`.
4. Verify `agentscrape --help` and `launchctl print "gui/$(id -u)/agentscrape.process-queue"`.
5. Resume submissions into the installed queue directory.

## Commands

| Command | Purpose | Local mutation |
| --- | --- | --- |
| `fetch-markdown URL [DEST]` | Fetch Markdown, generic HTML, GitHub/Gist content, or a matched content preset | Writes `DEST`; sensitive HTML sidecars require explicit `--retain-artifacts` with actual Markdown output |
| `fetch-links URL` | Extract flat/two-level navigation or an X timeline | No local write unless redirected by the caller |
| `discover-feed [FILE] --source-url URL` | Discover bounded live RSS/Atom feeds, or parse recorded feed/archive responses when `FILE` is supplied | No local write unless redirected by the caller |
| `list-presets` | List official and local presets by mode | None |
| `show-preset NAME` | Display a preset contract | None |
| `validate-preset NAME_OR_PATH` | Validate strict preset YAML | None |
| `capture-corpus URL` | Atomically capture a positive or typed-negative content sample | Writes versioned corpus fixtures under the configured data home's `corpus/` overlay |
| `test-corpus [--preset NAME]` | Replay the shipped corpus, then a distinct configured capture overlay | None |
| `check-presets --live` | Classify configured public canaries | No provider writes; local browser/session state may change |
| `convert-html [FILE]` | Convert one file/stdin, or recursively convert `--dir` | Writes converted Markdown beside source HTML or to stdout |
| `open-session NAME` / `close-session NAME` | Manage reusable browser sessions | Writes or removes local browser session state |
| `process-queue` | Process durable standalone scrape-artifact jobs | Mutates queue, failed-job, destination, and log state |
| `reconcile-queue` | Inventory or apply reconciliation for frozen indexed records | `--apply` mutates archived reconciliation state; inventory mode does not |

Run `agentscrape --help` or any command with `--help` for options. Explicit CLI/API session closes report failures; automatic owned-session cleanup is silent and best-effort.

## Network egress policy

Direct Markdown HTTP(S) is public-only by default. Agentscrape resolves every A/AAAA answer for each hop, rejects the hop if any answer is private, reserved, documentation, multicast, or unspecified, and dials one selected address while preserving the original HTTP Host and HTTPS SNI/certificate hostname. It repeats resolution, validation, and pinning after every redirect and rejects HTTPS downgrade redirects. Direct requests do not use ambient HTTP proxy settings.

Browser-backed live routes are denied by default. The CDP/profile boundary cannot prove redirect or subresource destinations, so Agentscrape does not present DNS preflight as a browser egress sandbox. `--allow-private-network` on `fetch-markdown`, `fetch-links`, `capture-corpus`, or `check-presets --live` is explicit consent to unrestricted, unverifiable browser/profile egress. For direct Markdown the same option permits valid private/reserved destinations while retaining address pinning and per-redirect resolution. This option is an egress consent, not a content or provider trust guarantee. Offline injected HTML, corpus replay, GitHub/Gist `gh` routes, and `open-session`'s `about:blank` do not require it. Live feed discovery remains public-only and has no private-network opt-in.

Registered TypeScript content handlers are trusted, unsandboxed process code. Agentscrape's direct network helpers enforce their stated policy, but arbitrary networking performed by a custom handler cannot be sandboxed by registration.

## Feed discovery

Omit `FILE` for live discovery owned by Agentscrape:

```sh
agentscrape discover-feed --source-url https://example.com/blog \
  --validator-url https://example.com/feed.xml --etag '"feed-v4"'
```

Supply exactly one `FILE` to preserve network-free recorded-response parsing; recorded pagination remains explicit with repeatable `--page URL FILE` pairs:

```sh
agentscrape discover-feed response.xml --source-url https://example.com/feed.xml \
  --page https://example.com/feed.xml?page=2 response-page-2.xml
```

Every completed feed result is serialized as JSON or YAML on stdout. Exit `0` means `failure` is null, including deliberate partial results such as a missing recorded pagination page; exit `1` means `failure` is non-null, including a partial result that preserves earlier evidence. Recorded-response read, byte-limit, and UTF-8 failures omit local paths and file content. Usage errors remain diagnostics on stderr with exit `2`.

Live `auto` mode accepts a feed response directly. For an HTML source it follows only an explicit `<link rel="alternate">` whose type is RSS, Atom, XML, or text/XML; it never treats generic page-body HTML as feed entries. Use `--source-kind archive` plus `--archive-entry-selector` for configured HTML archives. `--etag` and `--last-modified` become conditional request validators in live mode. Direct `--source-kind feed` binds them to `--source-url`; auto/homepage mode requires an exact `--validator-url`, and sends them only if that exact response URL is reached.

A redirect-capable transport call may carry a conditional bound to a different URL, but the direct transport applies its headers only when the current request URL exactly matches that binding, and a `304` is accepted only from that effective URL. A matching initial `304` produces a successful, complete empty window. A matching `304` during later pagination or archive traversal ends discovery while preserving items and page evidence from earlier responses.

Live transport uses direct HTTP(S) without ambient proxies. It revalidates and DNS-pins every source, redirect, discovered feed, and pagination URL; rejects credential-bearing, secret-bearing, private, reserved, and HTTPS-downgrade destinations; requests identity encoding; bounds redirects, each response by the configured per-response byte cap, aggregate fetched-response bodies to 20 MB, time, live pages (10), items, and headers; parses each supplied page only once; and requires fatal UTF-8 decoding. The schema remains feed envelope version `1`, and `source_url` remains the requested source while page evidence records effective feed/page URLs.

Feed date parsing uses one closed, timezone-independent policy for feed entries, archive dates, and `--since`. A timezone-free `YYYY-MM-DD` means midnight UTC; timezone-free ISO-like datetimes, RFC822-style dates, and supported English month-name display dates are interpreted as UTC. AM/PM belongs to the display time and is not a timezone. Successful timezone-free entry dates emit `naive_date_assumed_utc`; invalid dates emit only `invalid_date`, while an invalid `--since` is `invalid_options`. Explicit zones are `Z`, `UT`, `UTC`, and `GMT` at zero; numeric `±HHMM` or `±HH:MM` with hours `00`–`23` and minutes `00`–`59`; North American `EST`/`EDT` (`-0500`/`-0400`), `CST`/`CDT` (`-0600`/`-0500`), `MST`/`MDT` (`-0700`/`-0600`), and `PST`/`PDT` (`-0800`/`-0700`); and whitespace-delimited military suffixes after a time: `A`–`I` are `+1` through `+9`, `K`–`M` are `+10` through `+12`, `N`–`Y` are `-1` through `-12`, and `Z` is zero. `J` and every unknown alphabetic suffix, including `CET` and `XYZ`, are rejected.

## Routing and preset safety

Routing policy is resolved before any provider dispatch, network fetch, or browser navigation. The system validates the URL and parameters first, then determines a single execution route:

1. Explicit `--preset` wins (with name-based selection, not URL pattern validation)
2. `--generic` forces browser fallback (conflicts with `--preset`)
3. Automatic preset matching for unambiguous page-kind patterns
4. Parseable GitHub/Gist URLs use `gh` (unless preset/generic specified); each top-level operation has a 60-second deadline, a 16 MB aggregate `gh` stdout budget, and a maximum of 100 nonempty Gist files
5. Unclaimed `.md` URLs use bounded direct HTTP
6. Generic browser fallback for all other cases (live navigation requires explicit network consent)

Automatic matching first gates each preset by its declared `domain` and `aliases`, with case-insensitive hostname and `www` normalization; `domain: "*"` is the explicit host-agnostic option. Content presets may declare zero `url_patterns` for explicit-only use. Every published automatic pattern must visibly begin with `^` and end with `$`, and runtime matching additionally requires the regex to consume the entire canonical, fragment-free URL. These publication and runtime checks prevent substring and top-level-alternation matches; explicit name-based selection remains independent of URL eligibility.

A domain claimed by a preset fails closed on unsupported or ambiguous routes. Claimed-domain `.md` URLs require `--generic` to bypass preset policy. Because X serves both posts and long-form Articles from `/status/` URLs, the official status route classifies the rendered page by its strong Article-reader landmark before validating the effective `x-tweet` or `x-article` contract.

Content handlers must return all artifact fields, non-empty Markdown, the declared structured schema, and Markdown identical to that schema's renderer. Missing provider structure raises typed drift rather than returning generic body text. Labeled zero balances remain valid for billing presets.

Local YAML presets remain data-only. Selector-based `links` and `nav-links` presets work directly in `./scrapers`; the CLI deliberately does not import executable handler modules from YAML, environment variables, or the working directory. Trusted TypeScript callers can register a content handler and its `ScrapeSchema` explicitly before loading the registry:

```ts
import { registerContentHandler, ScrapeSchema } from "agentscrape";

class ArticlePage extends ScrapeSchema {
  constructor(readonly markdown: string) {
    super();
  }
  toMarkdown() { return this.markdown; }
}

const unregister = registerContentHandler({
  handlerName: "local.article",
  schemaName: "ArticlePage",
  schema: ArticlePage,
  handler: async (_url, options) => {
    const structured = new ArticlePage(options?.html ?? "");
    return { full_html: "", selected_html: "", markdown: structured.toMarkdown(), structured };
  },
});
```

Registration is process-local, rejects built-in/name collisions, enforces the registered handler/schema pair, and returns an unregister function for test and lifecycle cleanup.

Official presets cover Anthropic, Claude, OpenAI, and Perplexity billing; ChatGPT conversations; DeepWiki wiki/search pages; X posts, profiles, timelines, and articles; and generic documentation navigation.

For deployment readiness, `bun run x-readiness -- --once` probes the PATH-resolved Agentscrape executable for both X presets and the timeline cursor flag. Each subprocess has a five-second deadline and bounded output. Every check prints one JSON status object; exit 0 means ready, 1 means present but not ready, and 2 means Agentscrape is missing. Without `--once`, use `--interval SECONDS` and optional `--timeout SECONDS` to watch.

Under a responsive event loop, a subprocess timeout, cancellation, output overflow, or capture/wait terminal event is followed by at most a fixed 100 ms teardown grace, using local stdout/stderr cancellation rather than waiting indefinitely for pipe EOF. A requested timeout therefore settles in `timeoutMs` plus up to 100 ms plus event-loop scheduling. The runner sends `SIGKILL` to the original detached process group, but arbitrary descendants that create a new session with `setsid` may survive; those processes are outside containment and are not claimed as killed.

## Output contract

`fetch-markdown` defaults to Markdown. `--json` and `--yaml` serialize structured output. `--envelope` emits the provider-neutral extraction envelope with schema version `1`, extractor identity `agentscrape`, one bounded UTF-8 Markdown artifact, normalized metadata/relations, or a classified failure. Existing envelope keys and enum shapes are stable.

Raw browser evidence is not retained by default: ordinary CLI/API fetches and queue jobs create neither raw/selected HTML sidecars nor diagnostic screenshots. Retention is available only on `fetch-markdown`, through CLI `--retain-artifacts` or API `retainArtifacts: true`; `fetch-links` and direct `scrapeWithPreset` calls cannot opt in. Retention cannot be combined with envelope output. In-memory `full_html` and `selected_html` result fields are unchanged.

With exact retention enabled and a Markdown `DEST`, each nonempty HTML field is written as `<stem>.raw.html` or `<stem>.selected.html`. Sidecars are sensitive raw evidence. Each is capped at exactly 8,000,000 UTF-8 bytes and the set at 16,000,000 bytes; all sidecar bytes are preflighted before the Markdown destination is written. Sidecars use same-directory random staging files, atomic pathname replacement, and mode `0600` or stricter. Replacement does not follow an existing final symlink, but sidecar publication intentionally does not promise set-level crash atomicity or no-clobber behavior.

When a browser selector is exhausted, exact retention may also preserve one sensitive diagnostic screenshot. Screenshots use random names in unique random directories under the operating-system temporary directory; retained directories are mode `0700` or stricter and files mode `0600` or stricter. The 10,000,000-byte screenshot limit is validated after the external browser command finishes. That external command can therefore transiently write more than the cap before validation and cleanup. Failed or unsafe captures are removed best-effort without replacing the content-not-found error. A successful retained directory may survive a process crash and is left to operator or operating-system temporary-file cleanup; Agentscrape performs no startup sweep. Plain CLI errors print the retained directory as a separate redacted `Artifacts retained:` notice, never inside the error message or an envelope.

X content metadata includes the additive parser-derived pair `content_kind` and `content_item_count`: a single post is `post`/`1`, a same-author sequence is `thread` with its observed post count, and an X Article is `article`/`1`. Quoted posts do not increase a thread count. Other extractors omit the pair, so generic fixtures remain unchanged. Consumers must accept the optional pair before this producer version is deployed; upgraded consumers continue to accept historical envelopes that omit it.

Envelope failure classes are `invalid_request`, `authentication_required`, `upstream_unavailable`, `timeout`, `browser_error`, `provider_error`, `malformed_provider_output`, `empty_content`, `output_limit_exceeded`, `cancelled`, and `internal_error`. Policy-denied invalid requests and authentication exit 2; other envelope invalid requests and failures exit 1, cancellation exits 130, and success exits 0. Diagnostics and URL evidence are bounded and redacted.

## Corpus and canaries

`capture-corpus` is a separate, explicit raw-evidence workflow; its HTML and expected Markdown may contain sensitive provider content and are not sanitized. Persisted metadata URLs and captured failure messages are redacted. New sample directories use mode `0700` or stricter and files mode `0600` or stricter. Every sample file, including `meta.yaml`, is capped at exactly 8,000,000 UTF-8 bytes, with an exact 24,000,000-byte aggregate cap across the sample. All bytes are preflighted before creation, and ordinary failures clean the owned temporary directory without publishing a partial final sample.

Corpus metadata uses version `1`, declares `content`, `links`, or `nav-links` mode, and declares `success` or a typed `failure`. Content replay invokes the handler's offline HTML path. Navigation samples use deterministic static selector replay. Missing files, mismatched structured output/Markdown, unsupported versions, and wrong failure types fail the command.

`capture-corpus` writes to `${AGENTSCRAPE_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}/agentscrape}/corpus` unless an API caller supplies an explicit root. Default-path creation rejects symlinked, foreign, or ambiguous ancestry. With no explicit root, `test-corpus` always runs the shipped `test/corpus` first and then that configured overlay when it exists and is physically distinct; secure overlay replay rejects files over 8,000,000 bytes and samples over 24,000,000 bytes before bounded no-follow reads. Overlay labels are `captured/<preset>/<sample>`, so duplicate shipped/captured samples both run deterministically. Replay never mutates the shipped snapshot.

`check-presets --live --allow-private-network` uses `config/preset-canaries.yaml`, validates the same registry and output contract as normal fetching, checks semantic invariants rather than exact mutable text, closes every browser session it was allowed to use, and exits nonzero only for drift.

## Queue

Queue records never request raw HTML or screenshot retention; successful queue processing writes only the configured Markdown destination and any explicitly configured frontmatter/summary changes. Programmatic `submitScrapeJob()` calls and workers share the same queue root and exact precedence: `AGENTSCRAPE_DATA_HOME/queue` when that explicit root is set, otherwise `${XDG_DATA_HOME}/agentscrape/queue`, then `~/.local/share/agentscrape/queue`. New jobs contain `url`, `destination`, optional `summarize`, optional `frontmatter`, and optional strict boolean `allow_private_network`. `submitScrapeJob(..., { allowPrivateNetwork })` writes that field only when supplied; workers pass the exact true/false value into the complete scrape operation, and frozen/retry envelopes preserve the original record bytes. A network-policy denial is permanent rather than an upstream retry. Reconciliation may inventory the consent field but never executes network policy or `agentbrain` because of it. Indexed submissions are rejected. Legacy indexed records are drained into immutable `frozen/` envelopes for reconciliation. Browser-host outages are captured as immutable, policy-pinned `retry/` envelopes and revisited by the LaunchAgent's 60-second interval; malformed and permanent failures are published without clobbering existing `failed/` evidence.

`process-queue` and `reconcile-queue --apply` share private, durable, per-name generation claims. A live owner makes peers skip while leaving the public source visible; a dead owner is recovered, and malformed, symlinked, foreign, or incomplete claim evidence fails closed. Outcomes, frozen/retry envelopes, failed records, and archives use fsynced no-clobber publication. Retirement removes only the snapshotted inode and preserves a concurrently replaced pathname. There is a narrow conditional gap between the final identity check and the private UUID rename; a generation captured in that gap is retained in the private retirement quarantine rather than unlinked. Queue processing is at least once: a crash after a provider succeeds (or destination/output is published) but before source retirement can repeat that provider/output work on recovery.

Reconciliation is inventory-only unless `--apply` is given and admits imports through explicit `agentbrain` argv with a bounded timeout. A valid existing outcome resumes archive publication without another submit. If an owner dies after `agentbrain` accepted a request but before its receipt was durably published, recovery can physically submit again; correctness at that boundary relies on the `agentbrain` duplicate/idempotency contract rather than a durable local intent record.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run check
bun run x-readiness -- --once
```

See `docs/migration/standalone.md` for intentional standalone identity and compatibility differences.

The offline suite covers handler fixtures, corpus replay, preset invariants, envelope projection, recorded and fake-transport live feed discovery, output formatting, and command smoke tests. It makes no live internet calls.

`bun run check` is the contributor and CI default. Before typecheck, lint, and serial bounded tests, it replaces `HOME` with a private temporary directory and removes inherited Agentscrape, XDG config/data/state, and Bun/Node process-option state; `bun run test` uses the same boundary. Tests intentionally use loopback networking, so this is not an external-network sandbox.

CI runs the check on Ubuntu 24.04 and macOS 15, validates the shell installer and plist, and rejects whitespace errors or any tracked, staged, or untracked worktree changes.

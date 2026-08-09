# Agentscrape behavior contracts

What each command promises: routing, egress policy, output shapes, corpus
rules, and queue semantics. Deployment lifecycle lives in
[operations.md](operations.md); claimed security boundaries live in the
[threat model](threat-model.md).

## Command surface

| Command | Purpose | Local mutation |
| --- | --- | --- |
| `fetch-markdown URL [DEST]` | Fetch Markdown, generic HTML, GitHub/Gist content, or a matched content preset | Writes `DEST`; sensitive HTML sidecars require explicit `--retain-artifacts` with actual Markdown output |
| `fetch-links URL` | Extract flat/two-level navigation or an X timeline | No local write unless redirected by the caller |
| `discover-feed [FILE] --source-url URL` | Discover bounded live RSS/Atom feeds, or parse recorded feed/archive responses when `FILE` is supplied | No local write unless redirected by the caller |
| `list-presets` | List official and local presets by mode | None |
| `show-preset NAME` | Display a preset contract | None |
| `validate-preset NAME_OR_PATH` | Validate strict preset JSON | None |
| `capture-corpus URL` | Atomically capture a positive or typed-negative content sample | Writes versioned corpus fixtures under the configured data home's `corpus/` overlay |
| `test-corpus [--preset NAME]` | Replay the shipped corpus, then a distinct configured capture overlay | None |
| `check-presets --live` | Classify configured public canaries | No provider writes; local browser/session state may change |
| `convert-html [FILE]` | Convert one file/stdin, or recursively convert `--dir` | Writes converted Markdown beside source HTML or to stdout |
| `open-session NAME` / `close-session NAME` | Manage reusable browser sessions | Writes or removes local browser session state |
| `process-queue` | Process durable standalone scrape-artifact jobs | Mutates queue, failed-job, destination, and log state |
| `reconcile-queue` | Inventory or apply reconciliation for frozen indexed records | `--apply` mutates archived reconciliation state; inventory mode does not |
| `doctor [--format human\|json]` | Inspect the Bun runtime and inventory optional executables using offline filesystem/PATH lookups | None |

`doctor` and `check-presets --live` answer different questions and are not
aliases. `doctor` is an offline inventory: it executes no capability and checks
no auth, service, provider, queue, or deployment receipt health. Missing
optional capabilities are informational; exit 0 means the Bun version satisfies
the requirement, exit 1 means it does not, and usage errors exit 2.
`check-presets --live` is live operational-health observation against
configured public canaries. `bun run x-readiness -- --once` is the external
deployment-capability probe for an installed Agentscrape.

Explicit CLI/API session closes report failures; automatic owned-session
cleanup is silent and best-effort.

## Network egress policy

Direct Markdown HTTP(S) is public-only by default. Agentscrape resolves every
A/AAAA answer for each hop, rejects the hop if any answer is private, reserved,
documentation, multicast, or unspecified, and dials one selected address while
preserving the original HTTP Host and HTTPS SNI/certificate hostname. It
repeats resolution, validation, and pinning after every redirect and rejects
HTTPS downgrade redirects. Direct requests do not use ambient HTTP proxy
settings.

Browser-backed live routes are denied by default. The CDP/profile boundary
cannot prove redirect or subresource destinations, so Agentscrape does not
present DNS preflight as a browser egress sandbox. `--allow-private-network` on
`fetch-markdown`, `fetch-links`, `capture-corpus`, or `check-presets --live` is
explicit consent to unrestricted, unverifiable browser/profile egress. For
direct Markdown the same option permits valid private/reserved destinations
while retaining address pinning and per-redirect resolution. This option is an
egress consent, not a content or provider trust guarantee. Offline injected
HTML, corpus replay, GitHub/Gist `gh` routes, and `open-session`'s
`about:blank` do not require it. Live feed discovery remains public-only and
has no private-network opt-in.

Registered TypeScript content handlers are trusted, unsandboxed process code.
Agentscrape's direct network helpers enforce their stated policy, but arbitrary
networking performed by a custom handler cannot be sandboxed by registration.

## Feed discovery

Omit `FILE` for live discovery owned by Agentscrape; supply exactly one `FILE`
to preserve network-free recorded-response parsing, where pagination stays
explicit through repeatable `--page URL FILE` pairs:

```sh
agentscrape discover-feed --source-url https://example.com/blog \
  --validator-url https://example.com/feed.xml --etag '"feed-v4"'

agentscrape discover-feed response.xml --source-url https://example.com/feed.xml \
  --page https://example.com/feed.xml?page=2 response-page-2.xml
```

Every completed feed result is serialized as JSON or YAML on stdout. Exit `0`
means `failure` is null, including deliberate partial results such as a missing
recorded pagination page; exit `1` means `failure` is non-null, including a
partial result that preserves earlier evidence. Recorded-response read,
byte-limit, and UTF-8 failures omit local paths and file content. Usage errors
remain diagnostics on stderr with exit `2`.

Live `auto` mode accepts a feed response directly. For an HTML source it
follows only an explicit `<link rel="alternate">` whose type is RSS, Atom, XML,
or text/XML; it never treats generic page-body HTML as feed entries. Use
`--source-kind archive` plus `--archive-entry-selector` for configured HTML
archives.

`--etag` and `--last-modified` become conditional request validators in live
mode, bound to one exact URL: `--source-kind feed` binds them to
`--source-url`, while auto/homepage mode requires an exact `--validator-url`.
Headers are sent, and a `304` accepted, only from that effective URL. A
matching initial `304` produces a successful, complete empty window; a matching
`304` later in pagination or archive traversal ends discovery while preserving
items and page evidence from earlier responses.

Live transport uses direct HTTP(S) without ambient proxies. It revalidates and
DNS-pins every source, redirect, discovered feed, and pagination URL; rejects
credential-bearing, secret-bearing, private, reserved, and HTTPS-downgrade
destinations; requests identity encoding; bounds redirects, each response by
the configured per-response byte cap, aggregate fetched-response bodies to
20 MB, time, live pages (10), items, and headers; parses each supplied page
only once; and requires fatal UTF-8 decoding. The schema remains feed envelope
version `1`, and `source_url` remains the requested source while page evidence
records effective feed/page URLs.

Feed entries, archive dates, and `--since` share one closed,
timezone-independent date policy: absent zones mean UTC and emit
`naive_date_assumed_utc`, explicit zones are the `Z`/`UT`/`UTC`/`GMT` and
numeric `±HH:MM` forms plus North American and military abbreviations, and
anything else is rejected as `invalid_date` — or `invalid_options` when it is
`--since`. The accepted spellings are enumerated in `test/feed.test.ts`
rather than here, because the tests are what the parser answers to.

## Routing and preset safety

The high-level public `fetchMarkdown`, `fetchLinks`, and `captureCorpus` APIs
and their CLI commands validate the request URL before preset selection,
provider dispatch, network fetch, or browser navigation. Trusted low-level
`scrapeWithPreset` calls remain outside this request-routing authority.

For `fetchMarkdown`, routing then selects one execution path:

1. Explicit `--preset` wins (with name-based selection, not URL pattern validation)
2. `--generic` forces browser fallback (conflicts with `--preset`)
3. Automatic preset matching for unambiguous page-kind patterns
4. Parseable GitHub/Gist URLs use `gh` (unless preset/generic specified); each top-level operation has a 60-second deadline, a 16 MB aggregate `gh` stdout budget, and a maximum of 100 nonempty Gist files
5. Unclaimed `.md` URLs use bounded direct HTTP
6. Generic browser fallback for all other cases (live navigation requires explicit network consent)

Automatic matching first gates each preset by its declared `domain` and
`aliases`, with case-insensitive hostname and `www` normalization;
`domain: "*"` is the explicit host-agnostic option. Content presets may declare
zero `url_patterns` for explicit-only use. Every published automatic pattern
must visibly begin with `^` and end with `$`, and runtime matching additionally
requires the regex to consume the entire canonical, fragment-free URL. These
publication and runtime checks prevent substring and top-level-alternation
matches; explicit name-based selection remains independent of URL eligibility.

Declaring a `domain` claims that host: a URL on it that matches no preset fails
rather than falling back to generic extraction. Claimed-domain `.md` URLs
require `--generic` to bypass preset policy. That is deliberate for hosts where
generic output would be worthless — x.com serves login walls — so a claim is a
statement that the listed presets cover everything worth extracting there. Do
not add a narrow preset for one page on a host whose other pages should stay
generically extractable; the claim is host-wide, not path-scoped. Because X
serves both posts and long-form Articles from `/status/` URLs, the official
status route classifies the rendered page by its strong Article-reader landmark
before validating the effective `x-tweet` or `x-article` contract.

Content handlers must return all artifact fields, non-empty Markdown, the
declared structured schema, and Markdown identical to that schema's renderer.
Missing provider structure raises typed drift rather than returning generic
body text.

Local JSON presets remain data-only. Selector-based `links` and `nav-links`
presets work directly in `./scrapers`; the CLI deliberately does not import
executable handler modules from JSON, environment variables, or the working
directory. Trusted TypeScript callers can pass a handler and its `ScrapeSchema`
to `registerContentHandler` before loading the registry. Registration is
process-local, rejects built-in and name collisions, enforces the registered
handler/schema pair, and returns an unregister function for test and lifecycle
cleanup.

PDFs are extracted with `pdftotext` (poppler), not the browser: a browser
renders a PDF into a viewer with no extractable DOM, so every PDF returned
empty content. A `.pdf` path routes there directly; a PDF served without one —
`arxiv.org/pdf/ID` is the common case — is retried as a PDF only after the
generic route comes back empty, and only an `application/pdf` content-type
answers that retry, so a genuinely empty page stays empty. Bytes pass through a
private temporary file because stdin carries a string. A scan with no text
layer yields nothing and reports `empty_content`, which is the truth about the
document rather than a failure of the extractor.

A Gist whose API read fails with a retryable provider error is re-read over
git, which is the protocol a Gist actually speaks. GitHub's API returns 5xx
indefinitely for some Gists that git and the web UI serve normally, and without
the fallback that is a permanent failure for reachable content. The clone is
shallow, private, top-level regular files only, and spends the same file-count
and byte budgets as the API path. A 404 or a file-count refusal is an answer,
not an outage, and never reaches git.

Official presets cover ChatGPT conversations; DeepWiki wiki/search pages; X
posts, profiles, timelines, and articles; and generic documentation navigation.

## Output contract

All Agentscrape output is untrusted content. The HTML converters and selected
generated schema/GitHub links filter recognized `a[href]`, `img[src]`, and
Markdown destinations to credential-free HTTP(S) or safe relative references.
This is not global Markdown or HTML sanitization, prompt-injection defense,
domain authorization, or network-egress enforcement. Direct Markdown,
provider-authored Markdown/text, and GitHub passthrough content remain
unchecked and preserve their current bytes.

A successful final 2xx direct `.md` response is admitted only when it has
exactly one raw `Content-Type` field line that strictly parses as
`text/markdown`, with an optional `charset` that must decode to `utf-8`. Type,
subtype, and parameter names are ASCII case-insensitive; OWS, RFC tokens, and
quoted strings are accepted. Everything else is rejected: missing, duplicate,
comma-listed, malformed, non-ASCII, or aliased types, duplicate parameters, and
any other charset. This is an intentional compatibility break for servers that
returned `text/plain`, `text/x-markdown`, `application/markdown`, or omitted
the field.

Redirect MIME is ignored and admission applies only to the final 2xx,
regardless of its URL suffix. Status, authentication, 304, and redirect
handling retain precedence. Agentscrape performs no MIME sniffing,
HEAD/probe/fallback, or extra request, and `X-Content-Type-Options` does not
affect admission. Exactly zero or one raw `Content-Encoding` field line is
allowed; one must be OWS-trimmed `identity` case-insensitively, while
duplicates, comma lists, and other values are unsupported. Encoding and MIME
rejection occur before content length or body consumption; encoding errors
retain precedence, and MIME rejection is a fixed nonretryable provider error.

Downstream consumers should disable raw HTML and remote images (or proxy
images through a separately enforced policy), and must not automatically follow
emitted links. Allowed HTTP(S) destinations can still track a renderer or
target private services if a consumer fetches them. Treat labels, image
alternatives, code, metadata, and non-recognized Markdown/HTML constructs as
attacker-controlled. Envelope media types, hashes, and relation lists do not
imply content safety.

`fetch-markdown` defaults to Markdown. `--json` and `--yaml` serialize
structured output. `--envelope` emits the provider-neutral extraction envelope
with schema version `1`, extractor identity `agentscrape`, one bounded UTF-8
Markdown artifact, normalized metadata/relations, or a classified failure.
Existing envelope keys and enum shapes are stable.

X content metadata includes the additive parser-derived pair `content_kind` and
`content_item_count`: a single post is `post`/`1`, a same-author sequence is
`thread` with its observed post count, and an X Article is `article`/`1`.
Quoted posts do not increase a thread count. Other extractors omit the pair, so
generic fixtures remain unchanged. Consumers must accept the optional pair
before this producer version is deployed; upgraded consumers continue to accept
historical envelopes that omit it.

Envelope failure classes are `invalid_request`, `authentication_required`,
`upstream_unavailable`, `timeout`, `browser_error`, `provider_error`,
`malformed_provider_output`, `empty_content`, `output_limit_exceeded`,
`cancelled`, and `internal_error`. Policy-denied invalid requests and
authentication exit 2; other envelope invalid requests and failures exit 1,
success exits 0, and cancellation reports which signal arrived — 130 for
SIGINT, 143 for SIGTERM, so a queue worker reaped by launchd is
distinguishable from an operator pressing Ctrl-C. Diagnostics and URL evidence
are bounded and redacted.

## Retained evidence

Raw browser evidence is not retained by default: ordinary CLI/API fetches and
queue jobs create neither raw/selected HTML sidecars nor diagnostic
screenshots. Retention is available only on `fetch-markdown`, through CLI
`--retain-artifacts` or API `retainArtifacts: true`; `fetch-links` and direct
`scrapeWithPreset` calls cannot opt in, and retention cannot be combined with
envelope output. In-memory `full_html` and `selected_html` result fields are
unchanged.

With retention enabled and a Markdown `DEST`, each nonempty HTML field is
written as `<stem>.raw.html` or `<stem>.selected.html`, capped at exactly
8,000,000 UTF-8 bytes each and 16,000,000 for the set, all preflighted before
the Markdown destination is written. Sidecars use same-directory random
staging, atomic replacement that does not follow an existing final symlink, and
mode `0600` or stricter — but publication promises neither set-level crash
atomicity nor no-clobber behavior.

When a browser selector is exhausted, retention may also preserve one sensitive
diagnostic screenshot in a unique random directory under the operating-system
temporary directory, mode `0700` or stricter. Its 10,000,000-byte limit is
validated after the external browser command finishes, so that command can
transiently write more before validation and cleanup. Failed captures are
removed best-effort without replacing the content-not-found error, and a
retained directory may survive a crash — Agentscrape performs no startup sweep.
Plain CLI errors print it as a separate redacted `Artifacts retained:` notice,
never inside the error message or an envelope.

## Corpus and canaries

`capture-corpus` is a separate, explicit raw-evidence workflow; its HTML and
expected Markdown may contain sensitive provider content and are not sanitized.
Persisted metadata URLs and captured failure messages are redacted. New sample
directories use mode `0700` or stricter and files mode `0600` or stricter.
Every sample file, including `meta.json`, is capped at exactly 8,000,000 UTF-8
bytes, with an exact 24,000,000-byte aggregate cap across the sample. All bytes
are preflighted before creation, and ordinary failures clean the owned
temporary directory without publishing a partial final sample.

Corpus metadata uses version `1`, declares `content`, `links`, or `nav-links`
mode, and declares `success` or a typed `failure`. Content replay invokes the
handler's offline HTML path; navigation samples replay selectors statically.
Missing files, mismatched structured output/Markdown, unsupported versions, and
wrong failure types fail the command.

`capture-corpus` writes to
`${AGENTSCRAPE_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}/agentscrape}/corpus`
unless an API caller supplies an explicit root, and default-path creation
rejects symlinked, foreign, or ambiguous ancestry. With no explicit root,
`test-corpus` always runs the shipped `test/corpus` first and then that
configured overlay when it exists and is physically distinct, under the same
caps and bounded no-follow reads. Overlay labels are
`captured/<preset>/<sample>`, so duplicate shipped/captured samples both run
deterministically, and replay never mutates the shipped snapshot.

A capture taken from a signed-in browser carries the whole session in the parts
no handler touches, so shipped samples are reduced to the DOM their handlers
read and gated by `test/fixture-hygiene.test.ts`, which rejects credential and
identity material by shape.

`check-presets --live --allow-private-network` uses
`config/preset-canaries.json`, validates the same registry and output contract
as normal fetching, checks semantic invariants rather than exact mutable text,
and closes every browser session it was allowed to use. A canary URL ships with
the repository, so only durable public resources qualify and presets without
one carry no canary. Its JSON or YAML output carries each result's `status`; it
exits 0 only when every emitted result is `pass`, and exits 1 when any emitted
result is `drift`, `operational_failure`, or `not_configured`.

## Queue

Queue records never request raw HTML or screenshot retention; successful queue
processing writes only the configured Markdown destination and any explicitly
configured frontmatter/summary changes. Programmatic `submitScrapeJob()` calls
and workers share the same queue root and exact precedence:
`AGENTSCRAPE_DATA_HOME/queue` when that explicit root is set, otherwise
`${XDG_DATA_HOME}/agentscrape/queue`, then `~/.local/share/agentscrape/queue`.

New jobs contain `url`, `destination`, optional `summarize`, optional
`frontmatter`, and optional strict boolean `allow_private_network`, which
`submitScrapeJob(..., { allowPrivateNetwork })` writes only when supplied.
Workers pass the exact true/false value into the scrape operation, frozen and
retry envelopes preserve the original record bytes, and a network-policy denial
is permanent rather than an upstream retry. Reconciliation may inventory the
consent field but never executes network policy or `agentbrain` because of it.

Indexed submissions are rejected, and legacy indexed records are drained into
immutable `frozen/` envelopes for reconciliation. Browser-host outages become
immutable, policy-pinned `retry/` envelopes revisited by the LaunchAgent's
60-second interval; malformed and permanent failures are published without
clobbering existing `failed/` evidence.

`process-queue` and `reconcile-queue --apply` share private, durable, per-name
generation claims. A live owner makes peers skip while leaving the public
source visible; a dead owner is recovered, and malformed, symlinked, foreign,
or incomplete claim evidence fails closed. Outcomes, frozen/retry envelopes,
failed records, and archives use fsynced no-clobber publication. Retirement
removes only the snapshotted inode and preserves a concurrently replaced
pathname. There is a narrow conditional gap between the final identity check
and the private UUID rename; a generation captured in that gap is retained in
the private retirement quarantine rather than unlinked.

Queue processing is at least once: a crash after a provider succeeds (or
destination/output is published) but before source retirement can repeat that
provider/output work on recovery.

Reconciliation is inventory-only unless `--apply` is given and admits imports
through explicit `agentbrain` argv with a bounded timeout. A valid existing
outcome resumes archive publication without another submit. If an owner dies
after `agentbrain` accepted a request but before its receipt was durably
published, recovery can physically submit again; correctness at that boundary
relies on the `agentbrain` duplicate/idempotency contract rather than a durable
local intent record.

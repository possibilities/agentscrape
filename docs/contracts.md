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
| `validate-preset NAME_OR_PATH` | Validate strict preset YAML | None |
| `capture-corpus URL` | Atomically capture a positive or typed-negative content sample | Writes versioned corpus fixtures under the configured data home's `corpus/` overlay |
| `test-corpus [--preset NAME]` | Replay the shipped corpus, then a distinct configured capture overlay | None |
| `check-presets --live` | Classify configured public canaries | No provider writes; local browser/session state may change |
| `convert-html [FILE]` | Convert one file/stdin, or recursively convert `--dir` | Writes converted Markdown beside source HTML or to stdout |
| `open-session NAME` / `close-session NAME` | Manage reusable browser sessions | Writes or removes local browser session state |
| `process-queue` | Process durable standalone scrape-artifact jobs | Mutates queue, failed-job, destination, and log state |
| `reconcile-queue` | Inventory or apply reconciliation for frozen indexed records | `--apply` mutates archived reconciliation state; inventory mode does not |
| `doctor [--format human\|json]` | Inspect the exact Bun runtime and inventory optional executables using offline filesystem/PATH lookups | None |

`doctor` is an offline local runtime/executable inventory: it executes no
capability and checks no auth, service, provider, queue, or deployment receipt
health. Human output is the default and `--format json` emits the same
deterministic report shape. Missing optional capabilities are informational;
exit 0 means the Bun version is the exact requirement, exit 1 means it is
incompatible, and usage errors exit 2. `bun run x-readiness -- --once` is the
external deployment-capability probe for an Agentscrape binary.
`check-presets --live` is live operational-health observation against
configured provider canaries. These answer different questions and are not
aliases.

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

Omit `FILE` for live discovery owned by Agentscrape:

```sh
agentscrape discover-feed --source-url https://example.com/blog \
  --validator-url https://example.com/feed.xml --etag '"feed-v4"'
```

Supply exactly one `FILE` to preserve network-free recorded-response parsing;
recorded pagination remains explicit with repeatable `--page URL FILE` pairs:

```sh
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
archives. `--etag` and `--last-modified` become conditional request validators
in live mode. Direct `--source-kind feed` binds them to `--source-url`;
auto/homepage mode requires an exact `--validator-url`, and sends them only if
that exact response URL is reached.

A redirect-capable transport call may carry a conditional bound to a different
URL, but the direct transport applies its headers only when the current request
URL exactly matches that binding, and a `304` is accepted only from that
effective URL. A matching initial `304` produces a successful, complete empty
window. A matching `304` during later pagination or archive traversal ends
discovery while preserving items and page evidence from earlier responses.

Live transport uses direct HTTP(S) without ambient proxies. It revalidates and
DNS-pins every source, redirect, discovered feed, and pagination URL; rejects
credential-bearing, secret-bearing, private, reserved, and HTTPS-downgrade
destinations; requests identity encoding; bounds redirects, each response by
the configured per-response byte cap, aggregate fetched-response bodies to
20 MB, time, live pages (10), items, and headers; parses each supplied page
only once; and requires fatal UTF-8 decoding. The schema remains feed envelope
version `1`, and `source_url` remains the requested source while page evidence
records effective feed/page URLs.

Feed date parsing uses one closed, timezone-independent policy for feed
entries, archive dates, and `--since`. A timezone-free `YYYY-MM-DD` means
midnight UTC; timezone-free ISO-like datetimes, RFC822-style dates, and
supported English month-name display dates are interpreted as UTC. AM/PM
belongs to the display time and is not a timezone. Successful timezone-free
entry dates emit `naive_date_assumed_utc`; invalid dates emit only
`invalid_date`, while an invalid `--since` is `invalid_options`. Explicit zones
are `Z`, `UT`, `UTC`, and `GMT` at zero; numeric `±HHMM` or `±HH:MM` with hours
`00`–`23` and minutes `00`–`59`; North American `EST`/`EDT` (`-0500`/`-0400`),
`CST`/`CDT` (`-0600`/`-0500`), `MST`/`MDT` (`-0700`/`-0600`), and `PST`/`PDT`
(`-0800`/`-0700`); and whitespace-delimited military suffixes after a time:
`A`–`I` are `+1` through `+9`, `K`–`M` are `+10` through `+12`, `N`–`Y` are
`-1` through `-12`, and `Z` is zero. `J` and every unknown alphabetic suffix,
including `CET` and `XYZ`, are rejected.

## Routing and preset safety

The high-level public `fetchMarkdown`, `fetchLinks`, and `captureCorpus` APIs
and their `fetch-markdown`, `fetch-links`, and `capture-corpus` CLI commands
validate the request URL before preset selection, provider dispatch, network
fetch, or browser navigation. Trusted low-level `scrapeWithPreset` calls remain
outside this request-routing authority.

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

A domain claimed by a preset fails closed on unsupported or ambiguous routes.
Claimed-domain `.md` URLs require `--generic` to bypass preset policy. Because
X serves both posts and long-form Articles from `/status/` URLs, the official
status route classifies the rendered page by its strong Article-reader landmark
before validating the effective `x-tweet` or `x-article` contract.

Content handlers must return all artifact fields, non-empty Markdown, the
declared structured schema, and Markdown identical to that schema's renderer.
Missing provider structure raises typed drift rather than returning generic
body text.

Local YAML presets remain data-only. Selector-based `links` and `nav-links`
presets work directly in `./scrapers`; the CLI deliberately does not import
executable handler modules from YAML, environment variables, or the working
directory. Trusted TypeScript callers can register a content handler and its
`ScrapeSchema` explicitly before loading the registry:

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

Registration is process-local, rejects built-in/name collisions, enforces the
registered handler/schema pair, and returns an unregister function for test and
lifecycle cleanup.

Official presets cover ChatGPT conversations; DeepWiki wiki/search pages; X
posts, profiles, timelines, and articles; and generic documentation navigation.

Declaring a `domain` claims that host: a URL on it that matches no preset fails
rather than falling back to generic extraction. That is deliberate for hosts
where generic output would be worthless — x.com serves login walls — so a claim
is a statement that the listed presets cover everything worth extracting there.
Do not add a narrow preset for one page on a host whose other pages should stay
genericly extractable; the claim is host-wide, not path-scoped.

## Output contract

All Agentscrape output is untrusted content. The HTML converters and selected
generated schema/GitHub links filter recognized `a[href]`, `img[src]`, and
Markdown destinations to credential-free HTTP(S) or safe relative references.
This is not global Markdown or HTML sanitization, prompt-injection defense,
domain authorization, or network-egress enforcement. Direct Markdown,
provider-authored Markdown/text, and GitHub passthrough content remain
unchecked and preserve their current bytes.

A successful final 2xx direct `.md` response is admitted only when it has
exactly one raw `Content-Type` field line that parses as `text/markdown`. The
type, subtype, and parameter names are ASCII case-insensitive; SP/HTAB OWS and
valid token or quoted-string parameters are accepted. `charset` may be absent,
but when present exactly once its decoded value must be `utf-8`
case-insensitively. Other unique valid parameters are permitted. Missing,
duplicate, comma-listed, malformed, non-ASCII/control-bearing, aliased, or
different media types; duplicate parameters; and any other charset are
rejected. This is an intentional compatibility break for servers that
previously returned `text/plain`, `text/x-markdown`, `application/markdown`, or
omitted the field.

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

Raw browser evidence is not retained by default: ordinary CLI/API fetches and
queue jobs create neither raw/selected HTML sidecars nor diagnostic
screenshots. Retention is available only on `fetch-markdown`, through CLI
`--retain-artifacts` or API `retainArtifacts: true`; `fetch-links` and direct
`scrapeWithPreset` calls cannot opt in. Retention cannot be combined with
envelope output. In-memory `full_html` and `selected_html` result fields are
unchanged.

With exact retention enabled and a Markdown `DEST`, each nonempty HTML field is
written as `<stem>.raw.html` or `<stem>.selected.html`. Sidecars are sensitive
raw evidence. Each is capped at exactly 8,000,000 UTF-8 bytes and the set at
16,000,000 bytes; all sidecar bytes are preflighted before the Markdown
destination is written. Sidecars use same-directory random staging files,
atomic pathname replacement, and mode `0600` or stricter. Replacement does not
follow an existing final symlink, but sidecar publication intentionally does
not promise set-level crash atomicity or no-clobber behavior.

When a browser selector is exhausted, exact retention may also preserve one
sensitive diagnostic screenshot. Screenshots use random names in unique random
directories under the operating-system temporary directory; retained
directories are mode `0700` or stricter and files mode `0600` or stricter. The
10,000,000-byte screenshot limit is validated after the external browser
command finishes. That external command can therefore transiently write more
than the cap before validation and cleanup. Failed or unsafe captures are
removed best-effort without replacing the content-not-found error. A successful
retained directory may survive a process crash and is left to operator or
operating-system temporary-file cleanup; Agentscrape performs no startup sweep.
Plain CLI errors print the retained directory as a separate redacted
`Artifacts retained:` notice, never inside the error message or an envelope.

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
cancellation exits 130, and success exits 0. Diagnostics and URL evidence are
bounded and redacted.

## Corpus and canaries

`capture-corpus` is a separate, explicit raw-evidence workflow; its HTML and
expected Markdown may contain sensitive provider content and are not sanitized.
Persisted metadata URLs and captured failure messages are redacted. New sample
directories use mode `0700` or stricter and files mode `0600` or stricter.
Every sample file, including `meta.yaml`, is capped at exactly 8,000,000 UTF-8
bytes, with an exact 24,000,000-byte aggregate cap across the sample. All bytes
are preflighted before creation, and ordinary failures clean the owned
temporary directory without publishing a partial final sample.

Corpus metadata uses version `1`, declares `content`, `links`, or `nav-links`
mode, and declares `success` or a typed `failure`. Content replay invokes the
handler's offline HTML path. Navigation samples use deterministic static
selector replay. Missing files, mismatched structured output/Markdown,
unsupported versions, and wrong failure types fail the command.

`capture-corpus` writes to
`${AGENTSCRAPE_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}/agentscrape}/corpus`
unless an API caller supplies an explicit root. Default-path creation rejects
symlinked, foreign, or ambiguous ancestry. With no explicit root, `test-corpus`
always runs the shipped `test/corpus` first and then that configured overlay
when it exists and is physically distinct; secure overlay replay rejects files
over 8,000,000 bytes and samples over 24,000,000 bytes before bounded no-follow
reads. Overlay labels are `captured/<preset>/<sample>`, so duplicate
shipped/captured samples both run deterministically. Replay never mutates the
shipped snapshot.

`check-presets --live --allow-private-network` uses
`config/preset-canaries.yaml`, validates the same registry and output contract
as normal fetching, checks semantic invariants rather than exact mutable text,
and closes every browser session it was allowed to use. Its JSON or YAML output
carries each result's `status`; it exits 0 only when every emitted result is
`pass`, and exits 1 when any emitted result is `drift`, `operational_failure`,
or `not_configured`.

## Queue

Queue records never request raw HTML or screenshot retention; successful queue
processing writes only the configured Markdown destination and any explicitly
configured frontmatter/summary changes. Programmatic `submitScrapeJob()` calls
and workers share the same queue root and exact precedence:
`AGENTSCRAPE_DATA_HOME/queue` when that explicit root is set, otherwise
`${XDG_DATA_HOME}/agentscrape/queue`, then `~/.local/share/agentscrape/queue`.
New jobs contain `url`, `destination`, optional `summarize`, optional
`frontmatter`, and optional strict boolean `allow_private_network`.
`submitScrapeJob(..., { allowPrivateNetwork })` writes that field only when
supplied; workers pass the exact true/false value into the complete scrape
operation, and frozen/retry envelopes preserve the original record bytes. A
network-policy denial is permanent rather than an upstream retry.
Reconciliation may inventory the consent field but never executes network
policy or `agentbrain` because of it. Indexed submissions are rejected. Legacy
indexed records are drained into immutable `frozen/` envelopes for
reconciliation. Browser-host outages are captured as immutable, policy-pinned
`retry/` envelopes and revisited by the LaunchAgent's 60-second interval;
malformed and permanent failures are published without clobbering existing
`failed/` evidence.

`process-queue` and `reconcile-queue --apply` share private, durable, per-name
generation claims. A live owner makes peers skip while leaving the public
source visible; a dead owner is recovered, and malformed, symlinked, foreign,
or incomplete claim evidence fails closed. Outcomes, frozen/retry envelopes,
failed records, and archives use fsynced no-clobber publication. Retirement
removes only the snapshotted inode and preserves a concurrently replaced
pathname. There is a narrow conditional gap between the final identity check
and the private UUID rename; a generation captured in that gap is retained in
the private retirement quarantine rather than unlinked. Queue processing is at
least once: a crash after a provider succeeds (or destination/output is
published) but before source retirement can repeat that provider/output work on
recovery.

Reconciliation is inventory-only unless `--apply` is given and admits imports
through explicit `agentbrain` argv with a bounded timeout. A valid existing
outcome resumes archive publication without another submit. If an owner dies
after `agentbrain` accepted a request but before its receipt was durably
published, recovery can physically submit again; correctness at that boundary
relies on the `agentbrain` duplicate/idempotency contract rather than a durable
local intent record.

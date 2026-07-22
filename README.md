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

- runs `bun install --frozen-lockfile`
- creates private state under `~/.local/state/agentscrape`
- creates private queue data under `${AGENTSCRAPE_INSTALL_SHARE_DIR:-${XDG_DATA_HOME:-~/.local/share}/agentscrape}/{queue,failed}`
- installs an owned executable at `~/.local/bin/agentscrape`
- renders and loads `~/Library/LaunchAgents/agentscrape.process-queue.plist`
- exports the exact installed queue root through `AGENTSCRAPE_DATA_HOME` in the owned wrapper so interactive and LaunchAgent runs keep using the same queue path even if later shell `XDG_DATA_HOME` differs
- refuses unrelated existing `~/.local/bin/agentscrape`, unrelated target plists, or unrelated loaded services
- rolls back to the prior owned command/service state if bootstrap or verification fails

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

Uninstall is idempotent. It removes only the owned command, LaunchAgent, and installer receipts. It preserves queue files, failed jobs, browser/session data, and logs so an operator can inspect or reinstall without losing local state.

## Rollback and cutover

If a reinstall fails to bootstrap or verify, the installer restores the previous owned command and re-bootstraps the previous owned service automatically.

For an operator cutover from any predecessor deployment, use this generic sequence:

1. Stop new queue submissions and any external schedulers.
2. Let the currently active worker drain, or archive/export its state outside this repository.
3. Install this checkout with `./scripts/install.sh`.
4. Verify `agentscrape --help` and `launchctl print "gui/$(id -u)/agentscrape.process-queue"`.
5. Resume submissions into the installed queue directory.

## Commands

| Command | Purpose | Local mutation |
| --- | --- | --- |
| `fetch-markdown URL [DEST]` | Fetch Markdown, generic HTML, GitHub/Gist content, or a matched content preset | Writes `DEST`, plus sibling `*.raw.html` / `*.selected.html` when available |
| `fetch-links URL` | Extract flat/two-level navigation or an X timeline | No local write unless redirected by the caller |
| `discover-feed FILE --source-url URL` | Parse recorded RSS, Atom, or configured archive pages without network access | No local write unless redirected by the caller |
| `list-presets` | List official and local presets by mode | None |
| `show-preset NAME` | Display a preset contract | None |
| `validate-preset NAME_OR_PATH` | Validate strict preset YAML | None |
| `capture-corpus URL` | Atomically capture a positive or typed-negative content sample | Writes versioned corpus fixtures under `test/corpus` |
| `test-corpus [--preset NAME]` | Replay the versioned, mode-aware corpus offline | None |
| `check-presets --live` | Classify configured public canaries | No provider writes; local browser/session state may change |
| `convert-html [FILE]` | Convert one file/stdin, or recursively convert `--dir` | Writes converted Markdown beside source HTML or to stdout |
| `open-session NAME` / `close-session NAME` | Manage reusable browser sessions | Writes or removes local browser session state |
| `process-queue` | Process durable standalone scrape-artifact jobs | Mutates queue, failed-job, destination, and log state |
| `reconcile-queue` | Inventory or apply reconciliation for frozen indexed records | `--apply` mutates archived reconciliation state; inventory mode does not |

Run `agentscrape --help` or any command with `--help` for options.

## Routing and preset safety

A parseable GitHub or Gist URL uses `gh`; a `.md` URL uses bounded direct HTTP; all other URLs use the strict preset registry. Automatic matching requires exactly one anchored page-kind pattern. A domain claimed by an official preset fails closed on unsupported or ambiguous routes. `--generic` is the only generic override on a claimed domain and conflicts with `--preset`.

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

## Output contract

`fetch-markdown` defaults to Markdown. `--json` and `--yaml` serialize structured output. `--envelope` emits the provider-neutral extraction envelope with schema version `1`, extractor identity `agentscrape`, one bounded UTF-8 Markdown artifact, normalized metadata/relations, or a classified failure. Existing envelope keys and enum shapes are stable.

Envelope failure classes are `invalid_request`, `authentication_required`, `upstream_unavailable`, `timeout`, `browser_error`, `provider_error`, `malformed_provider_output`, `empty_content`, `output_limit_exceeded`, `cancelled`, and `internal_error`. Authentication exits 2, cancellation exits 130, other failures exit 1, and success exits 0. Diagnostics and URL evidence are bounded and redacted.

## Corpus and canaries

Corpus metadata uses version `1`, declares `content`, `links`, or `nav-links` mode, and declares `success` or a typed `failure`. Content replay invokes the handler's offline HTML path. Navigation samples use deterministic static selector replay. Missing files, mismatched structured output/Markdown, unsupported versions, and wrong failure types fail the command.

`check-presets --live` uses `config/preset-canaries.yaml`, validates the same registry and output contract as normal fetching, checks semantic invariants rather than exact mutable text, closes every browser session, and exits nonzero only for drift.

## Queue

Queue files live under `AGENTSCRAPE_DATA_HOME/queue` when that explicit root is set. Otherwise Agentscrape uses `${XDG_DATA_HOME}/agentscrape/queue`, then `~/.local/share/agentscrape/queue`. New jobs contain `url`, `destination`, optional `summarize`, and optional `frontmatter`. Indexed submissions are rejected. Browser-host outages retry in place with bounded exponential backoff; malformed and permanent failures move to `failed/`. Reconciliation is inventory-only unless `--apply` is given, persists private atomic outcomes before archiving source records, and admits imports through explicit `agentbrain` argv with a bounded timeout.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run check
bun run x-readiness -- --once
```

See `docs/migration/standalone.md` for intentional standalone identity and compatibility differences.

The offline suite covers handler fixtures, corpus replay, preset invariants, envelope projection, feed discovery, output formatting, and command smoke tests.

# AgentScrape

[![CI](https://github.com/possibilities/agentscrape/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentscrape/actions/workflows/ci.yml)

Give it a URL and get what is actually on the page — Markdown, navigation links, live or recorded feeds, and strict provider presets — through an agent-friendly Bun CLI.

Agentscrape never writes back to remote providers, but it is not read-only locally. Commands write destination files, corpus fixtures, queue state, and browser session state, and the installer changes the user command and LaunchAgent paths it owns. See the [threat model](docs/threat-model.md) for the claimed boundaries.

## Install

Requires Bun ≥ 1.3.14. The supported distribution is the macOS standalone snapshot:

```sh
./scripts/install.sh
agentscrape --help
launchctl print "gui/$(id -u)/agentscrape.queue-processor"
```

Uninstall, snapshot GC, rollback, and every environment variable are covered in [docs/operations.md](docs/operations.md).

## Use

```sh
agentscrape fetch-markdown https://example.com/post out.md
agentscrape fetch-links https://example.com/docs --preset docs-sidebar
agentscrape discover-feed --source-url https://example.com/blog
```

`agentscrape --help` lists all commands, `agentscrape --agent-help` prints the agent runbook, `--agent-teaser` the one-screen command inventory, and `COMMAND --help-json` is machine-readable. Behavioral contracts — routing, egress policy, output shapes, corpus, queue — live in [docs/contracts.md](docs/contracts.md).

## Without the private toolchain

Several routes delegate to local tools that are not published. Agentscrape then degrades to a smaller working CLI rather than failing to install:

| Works with no extra tools | Needs an unpublished tool |
| --- | --- |
| Direct `.md` over bounded, DNS-pinned HTTP | Any browser-rendered page — generic extraction and every X, ChatGPT, and DeepWiki preset (`agent-browser` plus its configured provider) |
| PDFs, when `pdftotext` from poppler is on `PATH` | Durable signed-in Browser profile reuse (`agentbrowse`; human interaction routes through `agentattention`) |
| GitHub and Gist reads, when `gh` is installed and authenticated | Queue records that request `summarize` (`summaryctl`) |
| Recorded feed parsing, corpus replay, HTML conversion, preset inspection, `doctor` | — |

`agentscrape doctor` reports which of these are present. A missing optional tool is informational: the routes that need it fail closed with a classified error, rather than silently returning worse content.

## Develop

```sh
bun install --frozen-lockfile
bun run check   # hermetic: typecheck + lint + serial tests under a private HOME
```

`AGENTS.md` holds the constraints worth knowing before changing anything; `CONTEXT.md` holds the domain glossary; `docs/adr/` records the fail-closed preset decision.

## License

MIT — see [LICENSE](LICENSE).

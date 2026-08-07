# Agentscrape

Fetch and extract web content through an agent-friendly Bun CLI: Markdown from any URL, navigation links, live or recorded feeds, and strict provider presets.

Agentscrape never writes back to remote providers, but it is not read-only locally — commands write destinations, corpus fixtures, queue state, and browser session state, and the installer mutates the user command and LaunchAgent paths it owns. See the [threat model](docs/threat-model.md) for claimed boundaries.

## Install

Requires Bun 1.3.14. The supported distribution is the macOS standalone snapshot:

```sh
./scripts/install.sh
agentscrape --help
launchctl print "gui/$(id -u)/agentscrape.process-queue"
```

Uninstall, snapshot GC, rollback, and every environment variable are covered in [docs/operations.md](docs/operations.md).

## Use

```sh
agentscrape fetch-markdown https://example.com/post out.md
agentscrape fetch-links https://example.com/docs --preset docs-nav
agentscrape discover-feed --source-url https://example.com/blog
```

`agentscrape --help` lists all commands, `agentscrape --agent-help` prints the agent runbook, `--agent-teaser` the one-screen command inventory, and `COMMAND --help-json` is machine-readable. Behavioral contracts — routing, egress policy, output shapes, corpus, queue — live in [docs/contracts.md](docs/contracts.md).

## Develop

```sh
bun install --frozen-lockfile
bun run check   # hermetic: typecheck + lint + serial tests under a private HOME
```

`CONTEXT.md` holds the domain glossary; `docs/adr/` records the fail-closed preset decision; `docs/migration/standalone.md` records intentional differences from the predecessor deployment.

# Standalone migration notes

Agentscrape intentionally uses its own package name, executable name, state directories, service label, user-agent, capture-session prefix, and extraction-envelope identity. Envelope schema version `1` is retained, while `extractor.name` is `agentscrape`.

Safe offline command shapes and defaults remain compatible: preset inspection, corpus replay, HTML conversion, recorded feed discovery, output flags, selector/session/media options, and queue inventory preserve their established stdout/stderr roles. `--format` is accepted before the command and on commands where it is a compatibility no-op. Agent-oriented help is available through `--agent-help`, `--agent-teaser`, and hidden JSON help through `--help-json`.

Intentional behavior differences are hardening changes: parser and option mistakes exit 2, cancellation is signal-aware, recursive HTML conversion does not follow symlinks or overwrite Markdown, executable local content handlers require explicit in-process TypeScript registration, and queue runtime resolution is explicit as `AGENTSCRAPE_DATA_HOME` first, then `${XDG_DATA_HOME}/agentscrape`, then `~/.local/share/agentscrape`. The installed standalone wrapper exports its resolved private data root so interactive and LaunchAgent invocations stay aligned. No predecessor executable, state, service, or configuration is imported automatically.

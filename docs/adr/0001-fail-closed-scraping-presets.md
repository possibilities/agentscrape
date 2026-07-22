# ADR 0001: Fail-closed scraping presets

- Status: Accepted
- Date: 2026-07-19

## Context

A generic extractor can produce plausible Markdown after a known route or DOM changes, masking extraction drift. Named page kinds therefore need provider-specific structural and output invariants.

## Decision

- Automatic selection uses validated URL matchers and rejects ambiguity.
- A URL on a claimed domain fails when no matcher accepts it. `--generic` is the explicit override.
- Unclaimed domains may use generic extraction.
- A matched preset never falls back to generic extraction after structure or output validation fails.
- The entire official and local registry validates before publication.
- Provider drift maps to the provider-neutral extraction-envelope failure taxonomy.

## Consequences

Supported-provider drift becomes visible, local overrides remain all-or-nothing, and downstream consumers need no provider-specific protocol.

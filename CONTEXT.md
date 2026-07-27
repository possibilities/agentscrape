# Agentscrape domain glossary

- **Scraping preset** — A named page-kind extraction contract binding eligible URLs to one handler, output schema, and success invariants.
- **Extraction drift** — A rendered page does not satisfy the semantic structure or output invariants of its selected preset.
- **Valid empty** — A successful state with positive, page-specific evidence that a requested collection has no items. Missing selectors, loading shells, authentication pages, and error pages are not valid empty states.
- **Generic extraction** — Broad content extraction for an unclaimed domain or explicit human override. It is never recovery after a page-specific preset matches or begins extraction.
- **Deployment readiness** — External evidence that the deployed Agentscrape executable exposes the required command, presets, and flags. `x-readiness` checks this capability surface; it does not establish provider health or snapshot authenticity.
- **Operational health** — Current live evidence that configured provider canaries can satisfy their extraction contracts. `check-presets --live` observes this and is distinct from offline `doctor` inventory and deployment readiness.

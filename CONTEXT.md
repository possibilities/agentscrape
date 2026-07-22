# Agentscrape domain glossary

- **Scraping preset** — A named page-kind extraction contract binding eligible URLs to one handler, output schema, and success invariants.
- **Extraction drift** — A rendered page does not satisfy the semantic structure or output invariants of its selected preset.
- **Valid empty** — A successful state with positive, page-specific evidence that a requested collection has no items. Missing selectors, loading shells, authentication pages, and error pages are not valid empty states.
- **Generic extraction** — Broad content extraction for an unclaimed domain or explicit human override. It is never recovery after a page-specific preset matches or begins extraction.

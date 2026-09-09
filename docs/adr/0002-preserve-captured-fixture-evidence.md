# 0002: Preserve captured fixture evidence

Status: retrospective, recorded 2026-09-08 from the current fixture policy.

Provider page fixtures are captured evidence, not hand-authored examples. A
handler change must not be made to pass by editing its sample into the expected
shape: that would erase evidence of provider drift. Recapture through the
corpus workflow, or reduce the sample with a script that proves identical
extraction output.

A signed-in capture can contain auth bootstrap data and tokens outside the
subtree a handler reads. Only the needed, sanitized subtree belongs in the
repository, with fixture-hygiene checks rejecting sensitive shapes. The cost
is a deliberate recapture/reduction step rather than quick fixture patching;
the benefit is a reproducible regression and no committed session state.

Evidence: [fixture rules](../../AGENTS.md),
[fixture hygiene test](../../test/fixture-hygiene.test.ts), and the
[capture command contract](../contracts.md). This complements
[ADR 0001](0001-fail-closed-scraping-presets.md) rather than redefining fallback.

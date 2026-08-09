# Agentscrape contributor notes

Read `CONTEXT.md` for the glossary and `docs/contracts.md` for what each
command promises. These are the constraints those documents will not warn you
about in time.

## Gates

- Use Bun ≥ 1.3.14 and run `bun run check` before handing work off. It is the
  only gate: typecheck, lint, and the serial suite under a private HOME with
  the environment stripped to an allowlist. Running `bun test` directly can
  pass on state the harness would have removed.
- Tests are hermetic. Every "network" call is a loopback `Bun.serve`; nothing
  reaches the internet, and `check-presets --live` is the one command that
  deliberately would — never run it from a test or an agent session.
- Coverage is gated at 70% aggregate lines and functions, failing closed on
  unparseable LCOV.

## Config surfaces are zod-first

`src/config-schemas.ts` is the single source of truth for the three
user-editable surfaces: presets, `preset-canaries.json`, and corpus
`meta.json`. The loaders validate with those zod schemas at load, and
`bun run generate:schemas` regenerates the three `config/*.schema.json`
files from them — never hand-edit one; `test/schemas.test.ts` fails on
drift. Adding a config key means declaring and describing it there, and the
loader and published schema both follow. The parse quirks are deliberate
and pinned by `test/config-validation.test.ts`: preset string fields
tolerate null, `$schema` is ignored whatever its value, canary entries are
never judged at load, and error prose still names the offending key.

One gate zod cannot own alone: its object parser skips a literal own
`__proto__` key before unrecognized-key detection can see it, so
`strictObject` never reports one. The preset validator keeps its own raw
own-key walk and unions it with zod's verdict, and any future loader that
rejects unknown keys must do the same. Test such a key from handwritten JSON
text — `JSON.stringify` of an object literal cannot produce a `__proto__` own
property, which is why the first characterization pass missed it.

## Preset domain claims are host-wide

Declaring `domain:` in a preset claims the entire host. A URL on that host
matching no preset **fails** rather than falling back to generic extraction.
That is deliberate for x.com, where generic output is a login wall. Adding a
narrow preset for one page on an otherwise-generic host silently breaks every
other page on it — four billing presets did exactly that, and the fix was to
delete them. Fail-closed is the default everywhere: missing provider structure
raises typed drift rather than returning body text.

## Fixtures are captured, not authored

`test/fixtures/` and `test/corpus/` hold real captured page dumps. Never
hand-edit one to make a test pass — the sample is evidence of what a provider
actually served, and editing it converts a real regression into a fiction.
Recapture with `capture-corpus`, or reduce a sample to the DOM its handler
reads (that reduction is scripted and verified output-identical, never eyeballed).

A capture taken from a signed-in browser carries the whole session in the parts
no handler touches: auth bootstrap JSON, account state, tokens.
`test/fixture-hygiene.test.ts` rejects those shapes in anything committed under
`test/`, and it is the reason the shipped samples are subtrees rather than
whole pages.

## Cross-tool compatibility

Agentbrain machine-parses this CLI, so two things are frozen until it is
updated in the same change:

- `discover-feed --help` stdout must keep matching
  `/^Usage:\s+agentscrape\s+discover-feed\s+\[FILE\]\s+--source-url\s+URL\b/m`.
  It is a capability probe. Do not reflow that usage line.
- The extraction envelope: `schema_version` `"1"`, extractor name literally
  `"agentscrape"`, and the artifact/failure shapes. Keys and enums are additive
  only.

`AGENTSCRAPE_CONDUIT_SOCKET` and `AGENTSCRAPE_CONDUIT_TOKEN_FILE` are set by
agentbrain's worker plist and asserted by funk; renaming them breaks an
installed deployment, not just this repo.

## The skill is the advertised runbook

`skills/scrape/SKILL.md` is the canonical deep runbook for this CLI. Funk's
skills scanner installs it globally — `npx skills add` against this checkout,
discovering nested `skills/<name>/SKILL.md` — so every Claude Code, Codex, and
Pi session lists its name and frontmatter description without loading the body.
That description is all most sessions ever see; it has to route on its own. `--agent-help` stays in the binary as the fallback for a
session without the skill and points at it.

The skill states version-pinned behavior as fact, so a CLI behavior change is
not finished until its claims are re-verified against the live CLI — routing
tiers, consent denials, exit codes, flag names, and the error strings it quotes.
Trust the binary over the prose. The skill directory must stay self-contained:
the installer ships only that directory, so a `../` reference to `docs/` or
`README.md` resolves to nothing on an installed copy.

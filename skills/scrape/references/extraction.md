# Extraction details

Discover the current MCP schema before choosing less common parameters.
Hyphenated argument keys remain quoted JSON keys even when Executor normalizes
the tool's name.

## Routes and presets

Explicit presets select a page-kind contract. Automatic preset matching takes
precedence over generic extraction; GitHub/Gist use the existing `gh` transport,
and unclaimed Markdown URLs can use bounded direct HTTP. Remaining pages use
browser extraction. Preset-owned domains fail when no page-kind pattern matches;
they do not silently return generic content. A matched preset's missing structure
is provider drift, not permission to treat a login wall as an article.

Inspect the preset with the discovered list/show tools when its route matters.
Use `generic` deliberately for content outside the preset contract, rather than
as an automatic response to every preset failure. GitHub repository, file, issue,
PR, and Gist URLs select the supported GitHub route. Raw Markdown hosts that
return a different MIME type may fail the strict direct-fetch path.

## Links, timelines, and feeds

The links operation requires a preset or selectors; there is no universal
default navigation extraction. For an X timeline, select `x-timeline`, a stable
signed-in session, and bounded work, for example:

```json
{"url":"https://x.com/USER","preset":"x-timeline","session":"selected-session","allow-private-network":true,"limit":25,"max-scrolls":5,"json":true}
```

Use the returned cursor as `since-id` for a later window. Replies and reposts
are explicit additions. A timeline fetch performs real scrolling, so choose
breadth based on the question. `json: true` provides structured link results;
the default is YAML.

Feed discovery is bounded public HTTP or offline parsing of supplied files.
It does not accept the unrestricted-browser opt-in. Use `source-url` for the
site/feed, and an absolute `file` path only for a recorded response. In auto
mode, discovery follows declared RSS/Atom alternates; arbitrary body links
are not inferred to be feed entries. HTML archives require explicit selectors.

`status: "partial"` with no failure means a bound was reached. The cursor's
validators can support conditional reads, but an ETag or Last-Modified value
belongs to its exact source/validator URL. A matching 304 is a successful
empty update window, not evidence that the feed has no entries.

## Classify the result

An extraction envelope uses `schema_version: "1"`, `status`, `artifacts`,
`relations`, `metadata`, and `failure`. Artifact content and media type identify
what was extracted. X metadata distinguishes a post, same-author thread, and
article; quoted posts do not increase the thread count.

A failure carries `failure_class`, `retryable`, message, and evidence. Inspect
these fields instead of inferring success from Executor's outer execution
status. A byte/relation overflow is `output_limit_exceeded`; increase bounds
only when needed. An empty PDF extraction may mean a scan with no text layer;
use the document/image tools appropriate to that source.

Raw HTML and screenshot diagnostics can contain private account material.
`retain-artifacts` is for a deliberate investigation, requires a suitable
destination, and conflicts with the neutral envelope mode. Keep diagnostic
captures out of source control and unrelated outputs.

The HTML conversion tool uses a local file or directory. Supply an absolute
path: an MCP call has no interactive stdin and its cwd is not the caller's.
Inspect the schema and output behavior before converting a directory, since
conversion writes files beside the inputs.

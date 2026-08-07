import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
  cancellationError,
  throwIfAborted,
} from "./errors";
import type { ScrapeResult } from "./handlers/types";
import { convertHtml, fencedCodeBlock, markdownLink } from "./html";
import { GenericPage } from "./schemas";
import { findExecutable, type ProcessOptions, type ProcessResult, runProcess } from "./subprocess";

export type GithubKind = "profile" | "repo" | "tree" | "blob" | "issue" | "pr" | "compare" | "gist";
export interface GithubTarget {
  type: GithubKind;
  owner?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  path?: string | undefined;
  number?: string | undefined;
  compare?: string | undefined;
  user?: string | undefined;
  id?: string | undefined;
}
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const GIST = /^[a-f0-9]+$/;
const GITHUB_DEADLINE_MS = 60_000;
const GITHUB_OUTPUT_BYTES = 16_000_000;
const GIST_FILE_LIMIT = 100;
const PANDOC_OUTPUT_BYTES = 4_000_000;
const DEADLINE_MESSAGE = "GitHub operation deadline exceeded";
const OUTPUT_MESSAGE = "GitHub operation exceeded the aggregate gh output limit";
const GIST_FILES_MESSAGE = "GitHub Gist exceeded the file-count limit";

type ProcessRunner = (argv: string[], options?: ProcessOptions) => Promise<ProcessResult>;
interface GithubInternalOptions {
  now?: () => number;
  runProcess?: ProcessRunner;
  deadlineMs?: number;
  maxGhOutputBytes?: number;
  maxGistFiles?: number;
}
interface GithubOperationContext {
  signal?: AbortSignal | undefined;
  now: () => number;
  runner: ProcessRunner;
  injectedRunner: boolean;
  deadline: number;
  remainingGhBytes: number;
  maxGistFiles: number;
}

export function isGithubUrl(value: string): boolean {
  return (
    /^https?:\/\/(?:www\.)?github\.com\//.test(value) ||
    /^https?:\/\/gist\.github\.com\//.test(value)
  );
}
export function parseGithubUrl(value: string): GithubTarget | null {
  const url = value.split(/[?#]/)[0]!;
  let match = url.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/);
  if (match) return { type: "gist", user: match[1], id: match[2] };
  match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/?$/);
  if (match) return { type: "profile", owner: match[1] };
  for (const [part, type] of [
    ["issues", "issue"],
    ["pull", "pr"],
  ] as const) {
    match = url.match(
      new RegExp(`^https?://(?:www\\.)?github\\.com/([^/]+)/([^/]+)/${part}/(\\d+)`),
    );
    if (match) return { type, owner: match[1], repo: match[2], number: match[3] };
  }
  match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/compare\/(.+)/);
  if (match) return { type: "compare", owner: match[1], repo: match[2], compare: match[3] };
  match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
  if (match)
    return { type: "blob", owner: match[1], repo: match[2], branch: match[3], path: match[4] };
  match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/);
  if (match)
    return { type: "tree", owner: match[1], repo: match[2], branch: match[3], path: match[4] };
  match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?\/?$/);
  if (match)
    return {
      type: "repo",
      owner: match[1],
      repo: match[2],
      ...(match[3] ? { branch: match[3] } : {}),
    };
  return null;
}

function validate(target: GithubTarget): void {
  if (target.owner && !OWNER.test(target.owner))
    throw new AgentscrapeError(`invalid GitHub owner: '${target.owner}'`, "usage");
  if (target.repo && !REPO.test(target.repo))
    throw new AgentscrapeError(`invalid GitHub repo: '${target.repo}'`, "usage");
  if (target.path?.split("/").includes(".."))
    throw new AgentscrapeError("invalid GitHub path (contains '..')", "usage");
  if (target.type === "gist" && (!target.id || !GIST.test(target.id)))
    throw new AgentscrapeError(`invalid gist id: '${target.id}'`, "usage");
  if (
    target.type === "compare" &&
    (!target.compare?.includes("...") || target.compare.split("/").includes(".."))
  )
    throw new AgentscrapeError("invalid GitHub compare ref", "usage");
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  return value;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function createContext(
  signal: AbortSignal | undefined,
  internal: GithubInternalOptions | undefined,
): GithubOperationContext {
  if (internal?.now !== undefined && typeof internal.now !== "function")
    throw new Error("now must be a function");
  if (internal?.runProcess !== undefined && typeof internal.runProcess !== "function")
    throw new Error("runProcess must be a function");
  const now = internal?.now ?? performance.now.bind(performance);
  const started = now();
  if (!Number.isFinite(started)) throw new Error("now must return a finite number");
  const deadlineMs = positiveNumber(internal?.deadlineMs ?? GITHUB_DEADLINE_MS, "deadlineMs");
  const deadline = started + deadlineMs;
  if (!Number.isFinite(deadline)) throw new Error("GitHub operation deadline must be finite");
  return {
    signal,
    now,
    runner: internal?.runProcess ?? runProcess,
    injectedRunner: internal?.runProcess !== undefined,
    deadline,
    remainingGhBytes: positiveInteger(
      internal?.maxGhOutputBytes ?? GITHUB_OUTPUT_BYTES,
      "maxGhOutputBytes",
    ),
    maxGistFiles: positiveInteger(internal?.maxGistFiles ?? GIST_FILE_LIMIT, "maxGistFiles"),
  };
}
function remainingTime(context: GithubOperationContext): number {
  throwIfAborted(context.signal);
  const now = context.now();
  if (!Number.isFinite(now)) throw new Error("now must return a finite number");
  const remaining = context.deadline - now;
  if (remaining <= 0) throw new AgentscrapeTimeoutError(DEADLINE_MESSAGE);
  return remaining;
}
function checkpoint(context: GithubOperationContext): void {
  remainingTime(context);
}

/**
 * Read the HTTP status out of a gh failure.
 *
 * gh reports the same failure two ways depending on the subcommand: `gh api`
 * writes "gh: Server Error (HTTP 502)", while `gh gist view` writes
 * "HTTP 502: Server Error (https://api.github.com/...)". Reading only the
 * parenthesised form left the second unparsed, so a transient 5xx fell through
 * to the generic branch and was reported as permanent — the caller then never
 * retried a failure that would have cleared on its own.
 *
 * The trailing parenthesis in the second form holds a URL, so the prefixed
 * match must be anchored to the digits that follow "HTTP " directly.
 */
export function ghStatus(stderr: string): number {
  const parenthesised = stderr.match(/\(HTTP (\d+)\)/)?.[1];
  if (parenthesised !== undefined) return Number(parenthesised);
  return Number(stderr.match(/(?:^|\s)HTTP (\d{3})\b/)?.[1]);
}

async function gh(args: string[], context: GithubOperationContext): Promise<string> {
  checkpoint(context);
  if (context.remainingGhBytes <= 0) throw new AgentscrapeProviderError(OUTPUT_MESSAGE, false);
  if (!context.injectedRunner && !findExecutable("gh"))
    throw new AgentscrapeError(
      "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com",
    );
  const availableBytes = context.remainingGhBytes;
  let result: ProcessResult;
  try {
    result = await context.runner(["gh", ...args], {
      timeoutMs: remainingTime(context),
      maxOutputBytes: availableBytes,
      env: { GH_NO_PROMPT: "1" },
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (error) {
    if (context.signal?.aborted) throw cancellationError(context.signal);
    throw error;
  }
  if (context.signal?.aborted) throw cancellationError(context.signal);

  const stdoutBytes = new TextEncoder().encode(result.stdout).byteLength;
  const overflowed = stdoutBytes > availableBytes;
  context.remainingGhBytes = Math.max(0, availableBytes - stdoutBytes);
  if (result.timedOut) throw new AgentscrapeTimeoutError(DEADLINE_MESSAGE);
  if (result.truncated) throw new AgentscrapeProviderError(OUTPUT_MESSAGE, false);
  if (overflowed) throw new AgentscrapeProviderError(OUTPUT_MESSAGE, false);
  checkpoint(context);

  if (result.exitCode === 0) return result.stdout;
  const status = ghStatus(result.stderr);
  if (result.exitCode === 4 || status === 401)
    throw new AgentscrapeAuthError("GitHub authentication required — run `gh auth login`");
  if (status === 403 || status === 429)
    throw new AgentscrapeProviderError(
      "GitHub rate limit exceeded — retry later or authenticate with `gh auth login`",
      true,
      status,
    );
  if (status === 408 || status >= 500)
    throw new AgentscrapeProviderError(
      `GitHub provider is temporarily unavailable (HTTP ${status})`,
      true,
      status,
    );
  if (status === 404)
    throw new AgentscrapeProviderError(
      "GitHub resource not found, has no README, or is not accessible",
      false,
      status,
    );
  if (status === 451)
    throw new AgentscrapeProviderError(
      "GitHub resource unavailable for legal reasons (HTTP 451)",
      false,
      status,
    );
  throw new AgentscrapeProviderError(
    "gh request failed — check the URL and your GitHub access",
    false,
    Number.isFinite(status) ? status : undefined,
  );
}
async function raw(path: string, context: GithubOperationContext): Promise<string> {
  return gh(["api", "-H", "Accept: application/vnd.github.raw+json", "--", path], context);
}
function language(name: string): string {
  return (
    (
      {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".jsx": "javascript",
        ".go": "go",
        ".rs": "rust",
        ".rb": "ruby",
        ".sh": "bash",
        ".zsh": "zsh",
        ".json": "json",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".toml": "toml",
        ".swift": "swift",
        ".java": "java",
        ".kt": "kotlin",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".hpp": "cpp",
        ".html": "html",
        ".css": "css",
        ".scss": "scss",
        ".sql": "sql",
        ".xml": "xml",
        ".php": "php",
        ".r": "r",
      } as Record<string, string>
    )[extname(name)] ?? ""
  );
}
function notebook(content: string, context: GithubOperationContext): string {
  checkpoint(context);
  const value = JSON.parse(content) as {
    cells?: Array<{ cell_type?: string; source?: string | string[] }>;
    metadata?: { language_info?: { name?: string } };
  };
  return (value.cells ?? [])
    .flatMap((cell) => {
      const source = typeof cell.source === "string" ? cell.source : (cell.source ?? []).join("");
      if (cell.cell_type === "markdown") return [source];
      if (cell.cell_type === "code")
        return [fencedCodeBlock(source, value.metadata?.language_info?.name ?? "python")];
      return [];
    })
    .join("\n\n");
}
async function asMarkdown(
  content: string,
  name: string,
  context: GithubOperationContext,
): Promise<string> {
  checkpoint(context);
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return content;
  if (lower.endsWith(".ipynb")) return notebook(content, context);
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    checkpoint(context);
    return convertHtml(content);
  }
  if (lower.endsWith(".rst")) {
    checkpoint(context);
    if (!context.injectedRunner && !findExecutable("pandoc"))
      throw new AgentscrapeError("pandoc not found on PATH — install it to convert .rst files");
    let result: ProcessResult;
    try {
      result = await context.runner(["pandoc", "-f", "rst", "-t", "markdown"], {
        stdin: content,
        timeoutMs: remainingTime(context),
        maxOutputBytes: PANDOC_OUTPUT_BYTES,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      if (context.signal?.aborted) throw cancellationError(context.signal);
      throw error;
    }
    if (context.signal?.aborted) throw cancellationError(context.signal);
    if (result.timedOut) throw new AgentscrapeTimeoutError(DEADLINE_MESSAGE);
    if (result.truncated)
      throw new AgentscrapeProviderError("pandoc response exceeded the output limit", false);
    checkpoint(context);
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout : content;
  }
  checkpoint(context);
  return `**${name.split("/").pop()}**\n\n${fencedCodeBlock(content, language(lower))}`;
}
function apiPath(target: GithubTarget, branch = target.branch!, path = target.path!): string {
  return `repos/${target.owner}/${target.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
}
async function fetchBlob(target: GithubTarget, context: GithubOperationContext): Promise<string> {
  try {
    return asMarkdown(await raw(apiPath(target), context), target.path!, context);
  } catch (error) {
    if (
      !(error instanceof AgentscrapeProviderError) ||
      error.status !== 404 ||
      !target.path?.includes("/")
    )
      throw error;
    const branches = (
      await gh(
        [
          "api",
          "--paginate",
          "-q",
          ".[].name",
          "--",
          `repos/${target.owner}/${target.repo}/branches`,
        ],
        context,
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const full = `${target.branch}/${target.path}`;
    const branch = branches
      .filter((item) => full.startsWith(`${item}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!branch) throw error;
    const path = full.slice(branch.length + 1);
    return asMarkdown(await raw(apiPath(target, branch, path), context), path, context);
  }
}

interface GistFile {
  name: string;
  content: string;
}

/** Assemble Gist files into one Markdown document. */
function renderGist(files: GistFile[]): string {
  const sections = files.map(({ name, content }) =>
    name.endsWith(".md") && files.length === 1
      ? content
      : name.endsWith(".md")
        ? `## ${name}\n\n${content}`
        : `${files.length > 1 ? `## ${name}\n\n` : `**${name}**\n\n`}${fencedCodeBlock(content, language(name))}`,
  );
  return sections.join("\n\n---\n\n");
}

async function gistViaGh(id: string, context: GithubOperationContext): Promise<GistFile[]> {
  const names = scanGistFiles(await gh(["gist", "view", id, "--files"], context), context);
  const files: GistFile[] = [];
  for (const name of names)
    files.push({
      name,
      content: await gh(
        ["gist", "view", id, ...(names.length > 1 ? ["-f", name] : []), "--raw"],
        context,
      ),
    });
  return files;
}

/**
 * Read a Gist over git, which is what a Gist actually is.
 *
 * The clone is shallow, lands in a private temporary directory, and is removed
 * before returning. Only regular files at the top level are read: a Gist has no
 * subdirectories, so anything else — a symlink, a device node — is not Gist
 * content and is skipped rather than followed. The same file-count and
 * aggregate-byte budgets as the gh path apply, so a fallback cannot be a way to
 * exceed them.
 */
async function gistViaGit(id: string, context: GithubOperationContext): Promise<GistFile[]> {
  checkpoint(context);
  if (!context.injectedRunner && !findExecutable("git"))
    throw new AgentscrapeProviderError("git not found on PATH for the Gist fallback", false);
  const root = await mkdtemp(join(tmpdir(), "agentscrape-gist-"));
  try {
    await chmod(root, 0o700);
    const checkout = join(root, "gist");
    const result = await context.runner(
      ["git", "clone", "--quiet", "--depth", "1", `https://gist.github.com/${id}.git`, checkout],
      {
        timeoutMs: remainingTime(context),
        maxOutputBytes: 1_000_000,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
    throwIfAborted(context.signal);
    if (result.timedOut) throw new AgentscrapeTimeoutError(DEADLINE_MESSAGE);
    if (result.exitCode !== 0)
      throw new AgentscrapeProviderError("Gist git fallback could not clone the Gist", false);

    const files: GistFile[] = [];
    for (const entry of (await readdir(checkout, { withFileTypes: true }))
      .filter((item) => item.isFile() && item.name !== ".git")
      .sort((a, b) => a.name.localeCompare(b.name))) {
      checkpoint(context);
      if (files.length >= context.maxGistFiles)
        throw new AgentscrapeProviderError(GIST_FILES_MESSAGE, false);
      const bytes = await readFile(join(checkout, entry.name));
      if (bytes.byteLength > context.remainingGhBytes)
        throw new AgentscrapeProviderError(OUTPUT_MESSAGE, false);
      context.remainingGhBytes -= bytes.byteLength;
      files.push({ name: entry.name, content: bytes.toString("utf8") });
    }
    return files;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scanGistFiles(output: string, context: GithubOperationContext): string[] {
  checkpoint(context);
  const files: string[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== "\n") continue;
    let file = output.slice(start, index);
    if (file.endsWith("\r")) file = file.slice(0, -1);
    start = index + 1;
    if (!file) continue;
    files.push(file);
    if (files.length > context.maxGistFiles)
      throw new AgentscrapeProviderError(GIST_FILES_MESSAGE, false);
  }
  return files;
}

async function fetchTarget(target: GithubTarget, context: GithubOperationContext): Promise<string> {
  checkpoint(context);
  validate(target);
  if (target.type === "repo") {
    const path = `repos/${target.owner}/${target.repo}/readme${target.branch ? `?ref=${encodeURIComponent(target.branch)}` : ""}`;
    const name = (await gh(["api", "-q", ".name", "--", path], context)).trim();
    return asMarkdown(await raw(path, context), name, context);
  }
  if (target.type === "blob") return fetchBlob(target, context);
  if (target.type === "issue")
    return gh(
      ["issue", "view", "--repo", `${target.owner}/${target.repo}`, "--", target.number!],
      context,
    );
  if (target.type === "pr")
    return gh(
      ["pr", "view", "--repo", `${target.owner}/${target.repo}`, "--", target.number!],
      context,
    );
  if (target.type === "gist") {
    let files: GistFile[];
    try {
      files = await gistViaGh(target.id!, context);
    } catch (error) {
      // A Gist is a git repository, so git serves one the API cannot. GitHub's
      // API 5xxes on some Gists indefinitely while git and the web UI serve
      // them fine, and without this that is a permanent failure for content
      // that is plainly reachable. Only a retryable provider failure falls
      // through: a 404 or a file-count refusal is an answer, not an outage.
      if (!(error instanceof AgentscrapeProviderError) || !error.retryable) throw error;
      files = await gistViaGit(target.id!, context);
    }
    if (!files.length) throw new AgentscrapeError(`gist ${target.id} has no files`);
    return renderGist(files);
  }
  if (target.type === "profile") {
    const response = await gh(["api", "--", `users/${target.owner}`], context);
    checkpoint(context);
    const data = JSON.parse(response) as Record<string, unknown>;
    const lines = [
      `# ${data.name || data.login}`,
      "",
      `**Login:** ${markdownLink(String(data.login ?? ""), String(data.html_url ?? ""))}`,
    ];
    if (data.bio) lines.push("", String(data.bio));
    for (const [label, key] of [
      ["Company", "company"],
      ["Location", "location"],
      ["Blog", "blog"],
      ["Public repos", "public_repos"],
      ["Followers", "followers"],
      ["Following", "following"],
    ])
      if (data[key!] !== null && data[key!] !== "") lines.push(`- **${label}:** ${data[key!]}`);
    return `${lines.join("\n").trim()}\n`;
  }
  if (target.type === "compare") {
    const response = await gh(
      [
        "api",
        "--",
        `repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(target.compare!).replaceAll("%2E", ".")}`,
      ],
      context,
    );
    checkpoint(context);
    const data = JSON.parse(response) as Record<string, any>;
    const lines = [
      `# Compare ${target.owner}/${target.repo}: ${target.compare}`,
      "",
      `- **Status:** ${data.status}`,
      `- **Ahead by:** ${data.ahead_by}`,
      `- **Behind by:** ${data.behind_by}`,
      `- **Total commits:** ${data.total_commits}`,
    ];
    if (data.commits?.length) {
      lines.push("", "## Commits");
      for (const commit of data.commits.slice(0, 50)) {
        const author = commit.commit.author?.name ? ` — ${commit.commit.author.name}` : "";
        lines.push(
          `- \`${commit.sha.slice(0, 7)}\` ${commit.commit.message.split("\n")[0]}${author}`,
        );
      }
    }
    if (data.files?.length) {
      lines.push("", "## Files changed");
      for (const file of data.files.slice(0, 200)) {
        lines.push(
          `- \`${file.filename}\` (${file.status}, +${file.additions ?? 0} -${file.deletions ?? 0})`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }
  const response = await gh(["api", "--", apiPath(target)], context);
  checkpoint(context);
  const data = JSON.parse(response) as any;
  checkpoint(context);
  if (!Array.isArray(data))
    return asMarkdown(await raw(apiPath(target), context), target.path!, context);
  const lines = [
    `# ${target.owner}/${target.repo}/${target.path}`,
    "",
    `Branch: \`${target.branch}\``,
    "",
    "## Directory contents",
  ];
  for (const item of data)
    lines.push(
      `- ${item.html_url ? markdownLink(`\`${item.name}\``, String(item.html_url)) : `\`${item.name}\``} (${item.type}${item.size ? `, ${item.size} bytes` : ""})`,
    );
  return `${lines.join("\n")}\n`;
}

export async function fetchGithubIfApplicable(
  url: string,
  signal?: AbortSignal,
  INTERNAL?: GithubInternalOptions,
): Promise<ScrapeResult<GenericPage> | null> {
  throwIfAborted(signal);
  const target = parseGithubUrl(url);
  if (!target) return null;
  const context = createContext(signal, INTERNAL);
  const markdown = await fetchTarget(target, context);
  checkpoint(context);
  const structured = new GenericPage(url, markdown);
  return { full_html: "", selected_html: "", markdown, structured };
}

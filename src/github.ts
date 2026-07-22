import { extname } from "node:path";
import {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeProviderError,
  AgentscrapeTimeoutError,
  cancellationError,
  throwIfAborted,
} from "./errors";
import type { ScrapeResult } from "./handlers/types";
import { convertHtml } from "./html";
import { GenericPage } from "./schemas";
import { findExecutable, runProcess } from "./subprocess";

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

async function gh(args: string[], signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (!findExecutable("gh"))
    throw new AgentscrapeError(
      "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com",
    );
  const result = await runProcess(["gh", ...args], {
    timeoutMs: 60_000,
    maxOutputBytes: 16_000_000,
    env: { GH_NO_PROMPT: "1" },
    ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) throw cancellationError(signal);
  if (result.timedOut) throw new AgentscrapeTimeoutError("GitHub CLI request timed out");
  if (result.truncated)
    throw new AgentscrapeProviderError("GitHub CLI response exceeded the output limit", false);
  if (result.exitCode === 0) return result.stdout;
  const status = Number(result.stderr.match(/\(HTTP (\d+)\)/)?.[1]);
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
async function raw(path: string, signal?: AbortSignal): Promise<string> {
  return gh(["api", "-H", "Accept: application/vnd.github.raw+json", "--", path], signal);
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
function notebook(content: string): string {
  const value = JSON.parse(content) as {
    cells?: Array<{ cell_type?: string; source?: string[] }>;
    metadata?: { language_info?: { name?: string } };
  };
  return (value.cells ?? [])
    .flatMap((cell) => {
      const source = (cell.source ?? []).join("");
      if (cell.cell_type === "markdown") return [source];
      if (cell.cell_type === "code")
        return [`\`\`\`${value.metadata?.language_info?.name ?? "python"}\n${source}\n\`\`\``];
      return [];
    })
    .join("\n\n");
}
async function asMarkdown(content: string, name: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return content;
  if (lower.endsWith(".ipynb")) return notebook(content);
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return convertHtml(content);
  if (lower.endsWith(".rst")) {
    if (!findExecutable("pandoc"))
      throw new AgentscrapeError("pandoc not found on PATH — install it to convert .rst files");
    const result = await runProcess(["pandoc", "-f", "rst", "-t", "markdown"], {
      stdin: content,
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) throw cancellationError(signal);
    if (result.timedOut) throw new AgentscrapeTimeoutError("pandoc conversion timed out");
    if (result.truncated)
      throw new AgentscrapeProviderError("pandoc response exceeded the output limit", false);
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout : content;
  }
  return `**${name.split("/").pop()}**\n\n\`\`\`${language(lower)}\n${content}\n\`\`\``;
}
function apiPath(target: GithubTarget, branch = target.branch!, path = target.path!): string {
  return `repos/${target.owner}/${target.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
}
async function fetchBlob(target: GithubTarget, signal?: AbortSignal): Promise<string> {
  try {
    return asMarkdown(await raw(apiPath(target), signal), target.path!, signal);
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
        signal,
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
    return asMarkdown(await raw(apiPath(target, branch, path), signal), path, signal);
  }
}

async function fetchTarget(target: GithubTarget, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  validate(target);
  if (target.type === "repo") {
    const path = `repos/${target.owner}/${target.repo}/readme${target.branch ? `?ref=${encodeURIComponent(target.branch)}` : ""}`;
    const name = (await gh(["api", "-q", ".name", "--", path], signal)).trim();
    return asMarkdown(await raw(path, signal), name, signal);
  }
  if (target.type === "blob") return fetchBlob(target, signal);
  if (target.type === "issue")
    return gh(
      ["issue", "view", "--repo", `${target.owner}/${target.repo}`, "--", target.number!],
      signal,
    );
  if (target.type === "pr")
    return gh(
      ["pr", "view", "--repo", `${target.owner}/${target.repo}`, "--", target.number!],
      signal,
    );
  if (target.type === "gist") {
    const files = (await gh(["gist", "view", target.id!, "--files"], signal))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (!files.length) throw new AgentscrapeError(`gist ${target.id} has no files`);
    const sections: string[] = [];
    for (const file of files) {
      const content = await gh(
        ["gist", "view", target.id!, ...(files.length > 1 ? ["-f", file] : []), "--raw"],
        signal,
      );
      sections.push(
        file.endsWith(".md") && files.length === 1
          ? content
          : file.endsWith(".md")
            ? `## ${file}\n\n${content}`
            : `${files.length > 1 ? `## ${file}\n\n` : `**${file}**\n\n`}\`\`\`${language(file)}\n${content}\n\`\`\``,
      );
    }
    return sections.join("\n\n---\n\n");
  }
  if (target.type === "profile") {
    const data = JSON.parse(await gh(["api", "--", `users/${target.owner}`], signal)) as Record<
      string,
      unknown
    >;
    const lines = [
      `# ${data.name || data.login}`,
      "",
      `**Login:** [${data.login}](${data.html_url})`,
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
    const data = JSON.parse(
      await gh(
        [
          "api",
          "--",
          `repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(target.compare!).replaceAll("%2E", ".")}`,
        ],
        signal,
      ),
    ) as Record<string, any>;
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
  const data = JSON.parse(await gh(["api", "--", apiPath(target)], signal)) as any;
  if (!Array.isArray(data))
    return asMarkdown(await raw(apiPath(target), signal), target.path!, signal);
  const lines = [
    `# ${target.owner}/${target.repo}/${target.path}`,
    "",
    `Branch: \`${target.branch}\``,
    "",
    "## Directory contents",
  ];
  for (const item of data)
    lines.push(
      `- ${item.html_url ? `[\`${item.name}\`](${item.html_url})` : `\`${item.name}\``} (${item.type}${item.size ? `, ${item.size} bytes` : ""})`,
    );
  return `${lines.join("\n")}\n`;
}

export async function fetchGithubIfApplicable(
  url: string,
  signal?: AbortSignal,
): Promise<ScrapeResult<GenericPage> | null> {
  throwIfAborted(signal);
  const target = parseGithubUrl(url);
  if (!target) return null;
  const markdown = await fetchTarget(target, signal);
  const structured = new GenericPage(url, markdown);
  return { full_html: "", selected_html: "", markdown, structured };
}

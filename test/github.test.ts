import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentscrapeAuthError, AgentscrapeError } from "../src/errors";
import { fetchGithubIfApplicable } from "../src/github";

const originalPath = process.env.PATH;
const temporary: string[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fakeGh(script: string): void {
  const directory = mkdtempSync(join(tmpdir(), "agentscrape-gh-"));
  temporary.push(directory);
  const path = join(directory, "gh");
  writeFileSync(path, `#!/bin/sh\nset -eu\n${script}\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${directory}:${originalPath}`;
}

describe("GitHub and Gist fetching through explicit gh argv", () => {
  test("repository README resolves metadata then streams raw content", async () => {
    fakeGh(`
case "$*" in
  *"-q .name"*) printf 'README.md\\n' ;;
  *) printf '# Hello\\n\\nBody' ;;
esac`);
    const result = await fetchGithubIfApplicable("https://github.com/o/r");
    expect(result?.markdown).toBe("# Hello\n\nBody");
  });
  test("blob Markdown stays raw and source files get a language fence", async () => {
    fakeGh("printf '# Doc\\n'");
    expect(
      (await fetchGithubIfApplicable("https://github.com/o/r/blob/main/doc.md"))?.markdown,
    ).toBe("# Doc\n");
    fakeGh("printf 'print(1)\\n'");
    expect(
      (await fetchGithubIfApplicable("https://github.com/o/r/blob/main/app.py"))?.markdown,
    ).toContain("```python\nprint(1)");
  });
  test("issue and pull requests use their dedicated gh renderers", async () => {
    fakeGh(`
case "$1" in
  issue) printf 'issue body' ;;
  pr) printf 'pr body' ;;
esac`);
    expect((await fetchGithubIfApplicable("https://github.com/o/r/issues/7"))?.markdown).toBe(
      "issue body",
    );
    expect((await fetchGithubIfApplicable("https://github.com/o/r/pull/9"))?.markdown).toBe(
      "pr body",
    );
  });
  test("profile, compare, and tree responses render bounded Markdown", async () => {
    fakeGh(`
case "$*" in
  *"users/person"*) printf '%s' '{"login":"person","name":"Example","html_url":"https://github.com/person","public_repos":10}' ;;
  *"compare/a...b"*) printf '%s' '{"status":"ahead","ahead_by":1,"behind_by":0,"total_commits":1,"commits":[{"sha":"abcdef123","commit":{"message":"feat: thing","author":{"name":"A"}}}],"files":[{"filename":"README.md","status":"modified","additions":2,"deletions":1}]}' ;;
  *"contents/docs?ref=main"*) printf '%s' '[{"name":"guide.md","type":"file","size":42,"html_url":"https://github.com/o/r/blob/main/docs/guide.md"}]' ;;
esac`);
    expect((await fetchGithubIfApplicable("https://github.com/person"))?.markdown).toContain(
      "# Example",
    );
    const comparison = await fetchGithubIfApplicable("https://github.com/o/r/compare/a...b");
    expect(comparison?.markdown).toContain("`abcdef1` feat: thing — A");
    expect(comparison?.markdown).toContain("`README.md` (modified, +2 -1)");
    const tree = await fetchGithubIfApplicable("https://github.com/o/r/tree/main/docs");
    expect(tree?.markdown).toContain("[`guide.md`]");
  });
  test("single and multi-file Gists preserve file identity", async () => {
    fakeGh(`
case "$*" in
  *"--files"*) printf 'snippet.py\\n' ;;
  *) printf 'x = 1\\n' ;;
esac`);
    expect(
      (await fetchGithubIfApplicable("https://gist.github.com/user/abcdef"))?.markdown,
    ).toContain("**snippet.py**\n\n```python");
    fakeGh(`
case "$*" in
  *"--files"*) printf 'one.md\\ntwo.js\\n' ;;
  *"-f one.md"*) printf '# One\\n' ;;
  *"-f two.js"*) printf 'two();\\n' ;;
esac`);
    const multi = await fetchGithubIfApplicable("https://gist.github.com/user/abcdef");
    expect(multi?.markdown).toContain("## one.md");
    expect(multi?.markdown).toContain("## two.js");
  });
  test("slash-containing branches are resolved against the real branch list", async () => {
    fakeGh(`
case "$*" in
  *"branches"*) printf 'main\\nfeature/foo\\n' ;;
  *"ref=feature%2Ffoo"*) printf 'SLASH BRANCH\\n' ;;
  *) printf 'not found (HTTP 404)\\n' >&2; exit 1 ;;
esac`);
    const result = await fetchGithubIfApplicable(
      "https://github.com/o/r/blob/feature/foo/dir/app.txt",
    );
    expect(result?.markdown).toContain("SLASH BRANCH");
  });
  test("exit status maps authentication, rate limits, not found, and legal blocks", async () => {
    fakeGh("exit 4");
    expect(fetchGithubIfApplicable("https://github.com/o/r/issues/1")).rejects.toBeInstanceOf(
      AgentscrapeAuthError,
    );
    for (const [status, message] of [
      [403, "rate limit"],
      [404, "not found"],
      [451, "legal reasons"],
    ] as const) {
      fakeGh(`printf 'failed (HTTP ${status})\\n' >&2; exit 1`);
      try {
        await fetchGithubIfApplicable("https://github.com/o/r/issues/1");
        throw new Error("request unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentscrapeError);
        expect((error as Error).message).toContain(message);
      }
    }
  });
  test("hostile owners and parent path components fail before gh runs", async () => {
    fakeGh("printf 'must not run' >&2; exit 99");
    expect(fetchGithubIfApplicable("https://github.com/-evil/repo")).rejects.toThrow(
      "invalid GitHub owner",
    );
    expect(fetchGithubIfApplicable("https://github.com/o/r/blob/main/../secret")).rejects.toThrow(
      "contains '..'",
    );
  });
});

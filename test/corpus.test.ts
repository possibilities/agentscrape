import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  __publishCapturedSampleForTest,
  __setCorpusOverlaySampleGuardHookForTest,
  CORPUS_ARTIFACT_MAX_BYTES,
  CorpusSecurityError,
  captureCorpus,
  testCorpus,
} from "../src/corpus";
import { loadRegistry } from "../src/presets";

const shipped = join(import.meta.dir, "corpus");
const temporary: string[] = [];
const originalDataHome = process.env.AGENTSCRAPE_DATA_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;

function temp(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agentscrape-corpus-overlay-")));
  temporary.push(path);
  return path;
}

function makePrivate(path: string): void {
  const info = lstatSync(path);
  if (info.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makePrivate(join(path, name));
  } else {
    chmodSync(path, 0o600);
  }
}

function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, relative: string): void => {
    const info = lstatSync(path);
    hash.update(`${relative}\0${info.mode & 0o777}\0`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    } else {
      hash.update(readFileSync(path));
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

function installOverlaySample(dataHome: string): string {
  const overlay = join(dataHome, "corpus");
  const destination = join(overlay, "deepwiki-wiki-page", "sample-001");
  mkdirSync(join(overlay, "deepwiki-wiki-page"), { recursive: true, mode: 0o700 });
  cpSync(join(shipped, "deepwiki-wiki-page", "sample-001"), destination, { recursive: true });
  makePrivate(dataHome);
  return overlay;
}

afterEach(() => {
  __setCorpusOverlaySampleGuardHookForTest();
  if (originalDataHome === undefined) delete process.env.AGENTSCRAPE_DATA_HOME;
  else process.env.AGENTSCRAPE_DATA_HOME = originalDataHome;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("corpus overlay", () => {
  test("omitted root runs shipped corpus then a distinct private overlay deterministically", async () => {
    const home = temp();
    const dataHome = join(home, "data");
    mkdirSync(dataHome, { mode: 0o700 });
    const overlay = installOverlaySample(dataHome);
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;
    const shippedBefore = treeHash(shipped);

    const result = await testCorpus();
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(20);
    expect(result.lines).toContain("  PASS: deepwiki-wiki-page/sample-001");
    expect(result.lines).toContain("  PASS: captured/deepwiki-wiki-page/sample-001");
    expect(result.lines.indexOf("  PASS: deepwiki-wiki-page/sample-001")).toBeLessThan(
      result.lines.indexOf("  PASS: captured/deepwiki-wiki-page/sample-001"),
    );
    expect(treeHash(shipped)).toBe(shippedBefore);
    expect(lstatSync(overlay).mode & 0o077).toBe(0);
  });

  test("missing overlay is a no-op and an explicit root remains exactly one root", async () => {
    const home = temp();
    const dataHome = join(home, "missing-data-home");
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    const omitted = await testCorpus("deepwiki-wiki-page");
    expect(omitted.failed).toBe(0);
    expect(omitted.passed).toBe(2);
    expect(existsSync(dataHome)).toBeFalse();

    mkdirSync(dataHome, { mode: 0o700 });
    const overlay = installOverlaySample(dataHome);
    const explicit = await testCorpus(undefined, overlay);
    expect(explicit.failed).toBe(0);
    expect(explicit.passed).toBe(1);
    expect(explicit.lines).toEqual(["  PASS: deepwiki-wiki-page/sample-001"]);
  });

  test("an explicit root keeps legacy symlink-ancestor and hardlink compatibility", async () => {
    const home = temp();
    const root = join(home, "real-corpus");
    const sample = join(root, "deepwiki-wiki-page", "sample-001");
    mkdirSync(join(root, "deepwiki-wiki-page"), { recursive: true });
    cpSync(join(shipped, "deepwiki-wiki-page", "sample-001"), sample, { recursive: true });

    const hardlinkSource = join(home, "expected-hardlink-source.md");
    writeFileSync(hardlinkSource, readFileSync(join(sample, "expected.md")));
    rmSync(join(sample, "expected.md"));
    linkSync(hardlinkSource, join(sample, "expected.md"));
    expect(lstatSync(join(sample, "expected.md")).nlink).toBe(2);

    const alias = join(home, "corpus-through-symlink");
    symlinkSync(root, alias);
    const result = await testCorpus(undefined, alias);
    expect(result).toEqual({
      passed: 1,
      failed: 0,
      lines: ["  PASS: deepwiki-wiki-page/sample-001"],
    });
  });

  test("oversized private overlay replay fails with bounded security error and closes descriptors", async () => {
    const home = temp();
    const dataHome = join(home, "data");
    mkdirSync(dataHome, { mode: 0o700 });
    const overlay = installOverlaySample(dataHome);
    const oversized = join(overlay, "deepwiki-wiki-page", "sample-001", "page.html");
    writeFileSync(oversized, "x".repeat(CORPUS_ARTIFACT_MAX_BYTES + 1), { mode: 0o600 });
    makePrivate(dataHome);
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;
    const descriptorsBefore = readdirSync("/dev/fd").length;

    try {
      await testCorpus();
      throw new Error("expected oversized overlay replay to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CorpusSecurityError);
      expect((error as Error).message).toContain(`${CORPUS_ARTIFACT_MAX_BYTES}-byte limit`);
    }
    expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(descriptorsBefore + 1);
  });

  test("default overlay recursively rejects symlinks, hardlinks, and nonprivate files", async () => {
    for (const violation of ["symlink", "hardlink", "mode"] as const) {
      const home = temp();
      const dataHome = join(home, "data");
      mkdirSync(dataHome, { mode: 0o700 });
      const overlay = installOverlaySample(dataHome);
      const expected = join(overlay, "deepwiki-wiki-page", "sample-001", "expected.md");
      if (violation === "symlink") {
        rmSync(expected);
        symlinkSync(join(shipped, "deepwiki-wiki-page", "sample-001", "expected.md"), expected);
      } else if (violation === "hardlink") {
        const source = join(home, "hardlink-source.md");
        writeFileSync(source, readFileSync(expected), { mode: 0o600 });
        rmSync(expected);
        linkSync(source, expected);
      } else {
        chmodSync(expected, 0o644);
      }
      process.env.HOME = home;
      process.env.AGENTSCRAPE_DATA_HOME = dataHome;
      delete process.env.XDG_DATA_HOME;
      await expect(testCorpus()).rejects.toThrow(/symbolic-link|ambiguous|nonprivate/);
    }
  });

  test("overlay aliases fail closed while cancelled default capture performs no preparation", async () => {
    const home = temp();
    const dataHome = join(home, "data");
    mkdirSync(dataHome, { mode: 0o700 });
    const overlay = join(dataHome, "corpus");
    symlinkSync(shipped, overlay);
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;
    const shippedBefore = treeHash(shipped);

    await expect(testCorpus()).rejects.toThrow(/plain directory|aliases/);

    const controller = new AbortController();
    controller.abort();
    await expect(
      captureCorpus("https://example.com", {
        preset: "deepwiki-wiki-page",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort|cancel/i);
    expect(lstatSync(overlay).isSymbolicLink()).toBeTrue();
    expect(treeHash(shipped)).toBe(shippedBefore);
  });

  test("retained overlay guards reject a directory swap without touching the replacement", async () => {
    const home = temp();
    const dataHome = join(home, "data");
    mkdirSync(dataHome, { mode: 0o700 });
    const overlay = installOverlaySample(dataHome);
    const sample = join(overlay, "deepwiki-wiki-page", "sample-001");
    const replacement = join(home, "replacement-sample");
    cpSync(sample, replacement, { recursive: true });
    writeFileSync(join(replacement, "sentinel.txt"), "leave me alone\n", { mode: 0o600 });
    makePrivate(replacement);
    const replacementBefore = treeHash(replacement);
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    let swapped = false;
    __setCorpusOverlaySampleGuardHookForTest((directory) => {
      if (swapped) return;
      swapped = true;
      renameSync(directory, join(dirname(directory), ".original-sample"));
      renameSync(replacement, directory);
    });

    await expect(testCorpus()).rejects.toThrow(/identity changed/);
    expect(swapped).toBeTrue();
    expect(treeHash(sample)).toBe(replacementBefore);
    expect(readFileSync(join(sample, "sentinel.txt"), "utf8")).toBe("leave me alone\n");
  });

  test("omitted capture publishes one private sample under the configured data home", () => {
    const home = temp();
    const dataHome = join(home, "data");
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    const sample = __publishCapturedSampleForTest("x-tweet", {
      "meta.json": '{ "version": 1 }\n',
      "page.html": "<main>captured</main>\n",
    });
    expect(sample).toBe(join(dataHome, "corpus", "x-tweet", "sample-001"));
    for (const path of [
      dataHome,
      join(dataHome, "corpus"),
      join(dataHome, "corpus", "x-tweet"),
      sample,
    ])
      expect(lstatSync(path).mode & 0o077).toBe(0);
    for (const name of readdirSync(sample))
      expect(lstatSync(join(sample, name)).mode & 0o077).toBe(0);
  });

  test("default publication preflights oversize artifacts before creating data-home ancestry", () => {
    const home = temp();
    const dataHome = join(home, "missing-data-home");
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    expect(() =>
      __publishCapturedSampleForTest("x-tweet", {
        "meta.json": '{ "version": 1 }\n',
        "page.html": "x".repeat(CORPUS_ARTIFACT_MAX_BYTES + 1),
      }),
    ).toThrow(`${CORPUS_ARTIFACT_MAX_BYTES}-byte limit`);
    expect(existsSync(dataHome)).toBeFalse();
    expect(existsSync(join(dataHome, "corpus"))).toBeFalse();
  });

  test("a malicious local-registry preset name cannot escape default capture publication", () => {
    const home = temp();
    const dataHome = join(home, "data");
    const local = join(home, "local-presets");
    const escaped = join(home, "escaped");
    mkdirSync(local, { mode: 0o700 });
    mkdirSync(escaped, { mode: 0o700 });
    writeFileSync(join(escaped, "sentinel.txt"), "foreign path remains\n", { mode: 0o600 });
    writeFileSync(
      join(local, "malicious.json"),
      `${JSON.stringify(
        {
          name: "../../escaped",
          summary: "malicious local capture name",
          domain: "example.invalid",
          mode: "content",
          aliases: [],
          url_patterns: ["^https://example\\.invalid/.*$"],
          handler: "x.scrape_tweet",
          schema: "TweetThread",
        },
        null,
        2,
      )}\n`,
    );
    const registry = loadRegistry({
      officialDir: join(import.meta.dir, "../config/presets"),
      localDir: local,
    });
    const malicious = registry.byName("../../escaped");
    expect(malicious?.source).toBe("local");
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    expect(() =>
      __publishCapturedSampleForTest(malicious!.name, { "meta.json": '{ "version": 1 }\n' }),
    ).toThrow(/unsafe path name|separator/);
    expect(readFileSync(join(escaped, "sentinel.txt"), "utf8")).toBe("foreign path remains\n");
    expect(existsSync(dataHome)).toBeFalse();
  });

  test("next-sample collisions fail closed without replacing the occupied sample", () => {
    const home = temp();
    const dataHome = join(home, "data");
    const preset = join(dataHome, "corpus", "x-tweet");
    mkdirSync(join(preset, "sample-001"), { recursive: true, mode: 0o700 });
    mkdirSync(join(preset, "sample-003"), { mode: 0o700 });
    writeFileSync(join(preset, "sample-003", "sentinel.txt"), "occupied\n", { mode: 0o600 });
    makePrivate(dataHome);
    process.env.HOME = home;
    process.env.AGENTSCRAPE_DATA_HOME = dataHome;
    delete process.env.XDG_DATA_HOME;

    expect(() =>
      __publishCapturedSampleForTest("x-tweet", { "meta.json": '{ "version": 1 }\n' }),
    ).toThrow(/already occupied/);
    expect(readFileSync(join(preset, "sample-003", "sentinel.txt"), "utf8")).toBe("occupied\n");
    expect(readdirSync(preset).filter((name) => name.startsWith(".capture-tmp-"))).toEqual([]);
  });
});

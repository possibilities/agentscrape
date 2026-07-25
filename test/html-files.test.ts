import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertHtmlDirectory,
  convertHtmlDirectoryForTest,
  type HtmlConversionTransactionPhase,
} from "../src/html-files";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
const preparationPrefix = ".agentscrape-html-prepare-";
const transactionPrefix = ".agentscrape-html-retire-";
const cleanupPrefix = ".agentscrape-html-cleanup-";
const lockName = ".agentscrape-html-convert.lock";
const lockOwnerPrefix = ".agentscrape-html-lock-owner-";
const lockQuarantinePrefix = ".agentscrape-html-lock-quarantine-";
const posixTest = process.platform === "win32" ? test.skip : test;
const foreignUidTest = process.platform !== "win32" && process.getuid?.() === 0 ? test : test.skip;

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agentscrape-html-files-"));
  temporary.push(path);
  return path;
}

function reserved(directory: string, prefix: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(prefix));
}

function preparations(directory: string): string[] {
  return reserved(directory, preparationPrefix);
}

function transactions(directory: string): string[] {
  return reserved(directory, transactionPrefix);
}

function cleanups(directory: string): string[] {
  return reserved(directory, cleanupPrefix);
}

function lockDebris(directory: string): string[] {
  return readdirSync(directory).filter(
    (name) =>
      name === lockName ||
      name.startsWith(lockOwnerPrefix) ||
      name.startsWith(lockQuarantinePrefix),
  );
}

function onlyTransaction(directory: string): string {
  const names = transactions(directory);
  expect(names).toHaveLength(1);
  return join(directory, names[0] as string);
}

function replaceAtomically(path: string, content: string): void {
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, content);
  renameSync(replacement, path);
}

function makeOwnedDirectoriesRemovable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return;

  chmodSync(path, (stat.mode & 0o777) | 0o700);
  for (const name of readdirSync(path)) makeOwnedDirectoriesRemovable(join(path, name));
}

function expectError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected action to throw");
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function crashAt(directory: string, phase: HtmlConversionTransactionPhase): Promise<number> {
  const script = join(temp(), "crash.ts");
  const modulePath = join(root, "src/html-files.ts");
  writeFileSync(
    script,
    `import { convertHtmlDirectoryForTest } from ${JSON.stringify(modulePath)};\n` +
      `convertHtmlDirectoryForTest(${JSON.stringify(directory)}, (phase) => {\n` +
      `  if (phase === ${JSON.stringify(phase)}) process.exit(73);\n` +
      `});\n`,
  );
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await new Promise<number>((resolve, reject) => {
      void child.exited.then((exitCode) => {
        if (!timedOut) resolve(exitCode);
      }, reject);
      timer = setTimeout(async () => {
        timedOut = true;
        child.kill("SIGKILL");
        await child.exited;
        reject(new Error(`Crash subprocess did not reach ${phase}`));
      }, 10_000);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    if (existsSync(path)) makeOwnedDirectoriesRemovable(path);
    rmSync(path, { recursive: true, force: true });
  }
});

describe("HTML directory conversion lock", () => {
  test("a live subprocess blocks overlapping recovery and traversal without changing its transaction", async () => {
    const directory = temp();
    const control = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const ready = join(control, "ready");
    const release = join(control, "release");
    const result = join(control, "result");
    const firstScript = join(control, "first.ts");
    const secondScript = join(control, "second.ts");
    const modulePath = join(root, "src/html-files.ts");
    writeFileSync(source, "<h1>Serialized</h1>");
    writeFileSync(
      firstScript,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { convertHtmlDirectoryForTest } from ${JSON.stringify(modulePath)};\n` +
        `const count = convertHtmlDirectoryForTest(${JSON.stringify(directory)}, (phase) => {\n` +
        `  if (phase !== "afterSourceRetirement") return;\n` +
        `  writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
        `  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n` +
        `});\n` +
        `writeFileSync(${JSON.stringify(result)}, String(count));\n`,
    );
    writeFileSync(
      secondScript,
      `import { convertHtmlDirectory } from ${JSON.stringify(modulePath)};\n` +
        `try { convertHtmlDirectory(${JSON.stringify(directory)}); process.exit(0); }\n` +
        `catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(81); }\n`,
    );

    const first = Bun.spawn([process.execPath, firstScript], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForPath(ready);
      const transaction = onlyTransaction(directory);
      const transactionNames = readdirSync(transaction).sort();
      const retired = readFileSync(join(transaction, "retired-source"), "utf8");
      const published = readFileSync(destination, "utf8");

      const second = Bun.spawn([process.execPath, secondScript], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await second.exited).toBe(81);
      expect(await new Response(second.stderr).text()).toContain("Active HTML conversion");
      expect(onlyTransaction(directory)).toBe(transaction);
      expect(readdirSync(transaction).sort()).toEqual(transactionNames);
      expect(readFileSync(join(transaction, "retired-source"), "utf8")).toBe(retired);
      expect(readFileSync(destination, "utf8")).toBe(published);
      expect(existsSync(source)).toBeFalse();

      writeFileSync(release, "release");
      expect(await first.exited).toBe(0);
      expect(readFileSync(result, "utf8")).toBe("1");
      expect(convertHtmlDirectory(directory)).toBe(0);
      expect(readFileSync(destination, "utf8")).toContain("# Serialized");
      expect(lockDebris(directory)).toEqual([]);
    } finally {
      writeFileSync(release, "release");
      if (first.exitCode === null) first.kill("SIGKILL");
      await first.exited;
    }
  });

  test("a live subdirectory invocation blocks parent recovery without changing its transaction", async () => {
    const directory = temp();
    const childDirectory = join(directory, "child");
    const control = temp();
    const source = join(childDirectory, "page.html");
    const destination = join(childDirectory, "page.md");
    const ready = join(control, "ready");
    const release = join(control, "release");
    const result = join(control, "result");
    const childScript = join(control, "child.ts");
    const parentScript = join(control, "parent.ts");
    const modulePath = join(root, "src/html-files.ts");
    mkdirSync(childDirectory);
    writeFileSync(source, "<h1>Nested serialization</h1>");
    writeFileSync(
      childScript,
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `import { convertHtmlDirectoryForTest } from ${JSON.stringify(modulePath)};\n` +
        `const count = convertHtmlDirectoryForTest(${JSON.stringify(childDirectory)}, (phase) => {\n` +
        `  if (phase !== "afterSourceRetirement") return;\n` +
        `  writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
        `  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n` +
        `});\n` +
        `writeFileSync(${JSON.stringify(result)}, String(count));\n`,
    );
    writeFileSync(
      parentScript,
      `import { convertHtmlDirectory } from ${JSON.stringify(modulePath)};\n` +
        `try { convertHtmlDirectory(${JSON.stringify(directory)}); process.exit(0); }\n` +
        `catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(81); }\n`,
    );

    const child = Bun.spawn([process.execPath, childScript], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForPath(ready);
      const transaction = onlyTransaction(childDirectory);
      const transactionNames = readdirSync(transaction).sort();
      const retired = readFileSync(join(transaction, "retired-source"), "utf8");
      const published = readFileSync(destination, "utf8");

      const parent = Bun.spawn([process.execPath, parentScript], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await parent.exited).toBe(81);
      expect(await new Response(parent.stderr).text()).toContain("Active HTML conversion");
      expect(onlyTransaction(childDirectory)).toBe(transaction);
      expect(readdirSync(transaction).sort()).toEqual(transactionNames);
      expect(readFileSync(join(transaction, "retired-source"), "utf8")).toBe(retired);
      expect(readFileSync(destination, "utf8")).toBe(published);
      expect(existsSync(source)).toBeFalse();
      expect(lockDebris(directory)).toEqual([]);
      expect(lockDebris(childDirectory)).toHaveLength(2);

      writeFileSync(release, "release");
      expect(await child.exited).toBe(0);
      expect(readFileSync(result, "utf8")).toBe("1");
      expect(readFileSync(destination, "utf8")).toContain("# Nested serialization");
      expect(convertHtmlDirectory(directory)).toBe(0);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Nested serialization");
      expect(lockDebris(directory)).toEqual([]);
      expect(lockDebris(childDirectory)).toEqual([]);
    } finally {
      writeFileSync(release, "release");
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("a dead subprocess claim is reclaimed immediately with its transaction", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Dead owner</h1>");

    expect(await crashAt(directory, "afterSourceRetirement")).toBe(73);
    expect(existsSync(join(directory, lockName))).toBeTrue();
    expect(reserved(directory, lockOwnerPrefix)).toHaveLength(1);
    expect(transactions(directory)).toHaveLength(1);

    expect(convertHtmlDirectory(directory)).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Dead owner");
    expect(transactions(directory)).toEqual([]);
    expect(lockDebris(directory)).toEqual([]);
  });

  test("malformed, symlinked, and foreign fixed claims fail closed and remain unchanged", () => {
    for (const kind of ["malformed", "symlink", "foreign"] as const) {
      const directory = temp();
      const fixed = join(directory, lockName);
      const sentinel = join(directory, "sentinel");
      let evidencePath = fixed;
      writeFileSync(sentinel, "untouched");

      if (kind === "malformed") {
        writeFileSync(fixed, "not a lock", { mode: 0o600 });
        chmodSync(fixed, 0o600);
      } else if (kind === "symlink") {
        symlinkSync(sentinel, fixed);
      } else {
        const token = randomUUID();
        const owner = join(directory, `${lockOwnerPrefix}${token}`);
        const stat = lstatSync(directory);
        const metadata = {
          version: 1,
          pid: process.pid,
          token,
          owner: `${lockOwnerPrefix}${token}`,
          rootDevice: `${stat.dev}`,
          rootInode: `${stat.ino + 1}`,
        };
        writeFileSync(owner, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
        chmodSync(owner, 0o600);
        linkSync(owner, fixed);
        evidencePath = owner;
      }
      const before = lstatSync(fixed);
      const evidence =
        kind === "symlink" ? readFileSync(sentinel, "utf8") : readFileSync(fixed, "utf8");

      const error = expectError(() => convertHtmlDirectory(directory));
      expect(error.message).toContain("Unsafe occupied HTML conversion lock");
      const after = lstatSync(fixed);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(
        kind === "symlink" ? readFileSync(sentinel, "utf8") : readFileSync(fixed, "utf8"),
      ).toBe(evidence);
      expect(existsSync(evidencePath)).toBeTrue();
      expect(reserved(directory, lockOwnerPrefix).length).toBe(kind === "foreign" ? 1 : 0);
    }
  });
});

describe("recoverable HTML retire transactions", () => {
  for (const phase of [
    "afterPreparationDirectoryCreation",
    "afterPreparationOutputCreation",
    "afterPreparationOutputWrite",
    "afterPreparationManifestCreation",
    "afterPreparationManifestWrite",
    "afterPreparationFilesSync",
    "afterPreparationReadyModeTransition",
    "afterPreparationTransition",
  ] as const) {
    test(`a true crash at ${phase} leaves only recoverable private preparation state`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Preparation crash</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      expect(readFileSync(source, "utf8")).toBe("<h1>Preparation crash</h1>");
      expect(existsSync(destination)).toBeFalse();
      if (phase === "afterPreparationTransition") {
        expect(preparations(directory)).toEqual([]);
        expect(transactions(directory)).toHaveLength(1);
        const transaction = onlyTransaction(directory);
        expect(readdirSync(transaction).sort()).toEqual(["manifest.json", "output"]);
      } else {
        expect(preparations(directory)).toHaveLength(1);
        expect(transactions(directory)).toEqual([]);
        const preparation = join(directory, preparations(directory)[0] as string);
        expect(lstatSync(preparation).mode & 0o777).toBe(
          phase === "afterPreparationReadyModeTransition" ? 0o700 : 0o300,
        );
      }

      expect(convertHtmlDirectory(directory)).toBe(1);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Preparation crash");
      expect(preparations(directory)).toEqual([]);
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    });
  }

  posixTest("preparation mkdir ignores a restrictive umask and restores it on failure", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    writeFileSync(source, "<h1>Umask</h1>");
    const originalUmask = process.umask(0o777);
    let observedMode: number | null = null;

    try {
      expectError(() =>
        convertHtmlDirectoryForTest(directory, (phase, context) => {
          if (phase !== "afterPreparationDirectoryCreation") return;
          observedMode = lstatSync(context.preparationDirectory).mode & 0o777;
          throw new Error("fail after exact-mode mkdir");
        }),
      );
      expect(Number(observedMode)).toBe(0o300);
      expect(process.umask()).toBe(0o777);
      expect(readFileSync(source, "utf8")).toBe("<h1>Umask</h1>");
      expect(preparations(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    } finally {
      process.umask(originalUmask);
    }
  });

  test("empty canonical mode-0300 preparation crash debris recovers", () => {
    const directory = temp();
    const preparation = join(directory, `${preparationPrefix}${randomUUID()}`);
    mkdirSync(preparation, { mode: 0o300 });
    chmodSync(preparation, 0o300);

    expect(convertHtmlDirectory(directory)).toBe(0);
    expect(existsSync(preparation)).toBeFalse();
  });

  const preparationCrashStates = [
    ["mode-0300 empty", "afterPreparationDirectoryCreation"],
    ["mode-0300 output-only", "afterPreparationOutputWrite"],
    ["mode-0300 manifest-partial", "afterPreparationManifestCreation"],
    ["mode-0700 ready", "afterPreparationReadyModeTransition"],
  ] as const;
  const preparationCleanupCrashPhases = [
    "afterCleanupPendingCreation",
    "afterCleanupPendingWrite",
    "afterCleanupMarkerLink",
    "afterCleanupPendingRemoval",
    "afterCleanupMarker",
    "afterCleanupTransition",
    "afterCleanupMarkerRemoval",
  ] as const;

  for (const [state, preparationPhase] of preparationCrashStates) {
    const sweepPhases: HtmlConversionTransactionPhase[] = [];
    if (state.includes("manifest") || state.includes("ready"))
      sweepPhases.push("afterCleanupManifestRemoval");
    if (!state.includes("empty")) sweepPhases.push("afterCleanupOutputRemoval");

    const cleanupPhases: HtmlConversionTransactionPhase[] = [
      ...preparationCleanupCrashPhases,
      ...(state.startsWith("mode-0300")
        ? (["afterPreparationCleanupModeTransition"] as const)
        : []),
      ...sweepPhases,
    ];
    for (const cleanupPhase of cleanupPhases) {
      test(`${state} preparation cleanup survives a second crash at ${cleanupPhase}`, async () => {
        const directory = temp();
        const source = join(directory, "page.html");
        const destination = join(directory, "page.md");
        writeFileSync(source, "<h1>Two-stage preparation recovery</h1>");

        expect(await crashAt(directory, preparationPhase)).toBe(73);
        expect(preparations(directory)).toHaveLength(1);
        expect(await crashAt(directory, cleanupPhase)).toBe(73);
        expect(readFileSync(source, "utf8")).toBe("<h1>Two-stage preparation recovery</h1>");
        expect(existsSync(destination)).toBeFalse();
        expect(preparations(directory).length + cleanups(directory).length).toBe(1);
        expect(transactions(directory)).toEqual([]);
        if (state.startsWith("mode-0300") && cleanupPhase === "afterCleanupMarker") {
          const preparation = join(directory, preparations(directory)[0] as string);
          expect(lstatSync(preparation).mode & 0o777).toBe(0o300);
        }
        if (state.startsWith("mode-0300") && cleanupPhase === "afterCleanupTransition") {
          const cleanup = join(directory, cleanups(directory)[0] as string);
          expect(lstatSync(cleanup).mode & 0o777).toBe(0o300);
        }
        if (cleanupPhase === "afterPreparationCleanupModeTransition") {
          const cleanup = join(directory, cleanups(directory)[0] as string);
          expect(lstatSync(cleanup).mode & 0o777).toBe(0o700);
        }

        const changedCurrentSource =
          state.includes("output-only") && cleanupPhase === "afterCleanupMarker";
        if (changedCurrentSource)
          replaceAtomically(source, "<h1>Current source after cleanup authority</h1>");
        expect(convertHtmlDirectory(directory)).toBe(1);
        expect(existsSync(source)).toBeFalse();
        expect(readFileSync(destination, "utf8")).toContain(
          changedCurrentSource
            ? "# Current source after cleanup authority"
            : "# Two-stage preparation recovery",
        );
        expect(preparations(directory)).toEqual([]);
        expect(transactions(directory)).toEqual([]);
        expect(cleanups(directory)).toEqual([]);
      });
    }
  }

  test("a prepare-to-retire target collision is refused before publication", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    let collision = "";
    writeFileSync(source, "<h1>Collision</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase, context) => {
        if (phase !== "afterPreparationDirectoryCreation") return;
        collision = context.transactionDirectory;
        mkdirSync(collision, { mode: 0o700 });
        chmodSync(collision, 0o700);
      }),
    );
    expect(collision).not.toBe("");
    expect(lstatSync(collision).isDirectory()).toBeTrue();
    expect(readdirSync(collision)).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe("<h1>Collision</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(preparations(directory)).toEqual([]);
  });

  test("valid preparation artifact subsets are swept without public mutation", () => {
    for (const artifacts of [
      [],
      [["output", "partial output"]],
      [["manifest.json", '{"partial":']],
    ] as const) {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      const preparation = join(directory, `${preparationPrefix}${randomUUID()}`);
      writeFileSync(source, "<h1>Subset</h1>");
      mkdirSync(preparation, { mode: 0o300 });
      chmodSync(preparation, 0o300);
      for (const [name, content] of artifacts) {
        writeFileSync(join(preparation, name), content, { mode: 0o600 });
        chmodSync(join(preparation, name), 0o600);
      }

      let reachedOrdinarySetup = false;
      expectError(() =>
        convertHtmlDirectoryForTest(directory, (phase) => {
          if (phase === "afterPreparationDirectoryCreation") {
            reachedOrdinarySetup = true;
            throw new Error("stop before publication");
          }
        }),
      );
      expect(reachedOrdinarySetup).toBeTrue();
      expect(readFileSync(source, "utf8")).toBe("<h1>Subset</h1>");
      expect(existsSync(destination)).toBeFalse();
      expect(preparations(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    }
  });

  for (const mutation of ["atomic replacement", "same-inode rewrite"] as const) {
    for (const phase of ["beforeDestinationLink", "afterDestinationLink"] as const) {
      test(`${mutation} at ${phase} retains the new source and removes owned output`, () => {
        const directory = temp();
        const source = join(directory, "page.html");
        const destination = join(directory, "page.md");
        const newer = "<h1>NEW</h1>";
        writeFileSync(source, "<h1>OLD</h1>");

        expectError(() =>
          convertHtmlDirectoryForTest(directory, (currentPhase) => {
            if (currentPhase !== phase) return;
            if (mutation === "atomic replacement") replaceAtomically(source, newer);
            else writeFileSync(source, newer);
          }),
        );

        expect(readFileSync(source, "utf8")).toBe(newer);
        expect(existsSync(destination)).toBeFalse();
        expect(transactions(directory)).toEqual([]);
        expect(convertHtmlDirectory(directory)).toBe(1);
        expect(readFileSync(destination, "utf8")).toContain("# NEW");
        expect(existsSync(source)).toBeFalse();
        expect(transactions(directory)).toEqual([]);
      });
    }
  }

  test("replacement immediately before retirement restores the replacement generation", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>OLD</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase === "beforeSourceRetirement") replaceAtomically(source, "<h1>NEW</h1>");
      }),
    );

    expect(readFileSync(source, "utf8")).toBe("<h1>NEW</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(transactions(directory)).toEqual([]);
    expect(convertHtmlDirectory(directory)).toBe(1);
    expect(readFileSync(destination, "utf8")).toContain("# NEW");
  });

  test("an occupied retired-source target immediately before rename is never clobbered", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const newer = "<h1>Foreign public source</h1>";
    const evidence = "foreign retired-source evidence";
    let artifact = "";
    let artifactDevice = 0;
    let artifactInode = 0;
    writeFileSync(source, "<h1>Original</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase, context) => {
        if (phase !== "beforeSourceRetirementRename") return;
        replaceAtomically(source, newer);
        artifact = context.retiredSource;
        writeFileSync(artifact, evidence, { mode: 0o600 });
        chmodSync(artifact, 0o600);
        ({ dev: artifactDevice, ino: artifactInode } = lstatSync(artifact));
      }),
    );

    const preserved = lstatSync(artifact);
    expect(preserved.dev).toBe(artifactDevice);
    expect(preserved.ino).toBe(artifactInode);
    expect(preserved.mode & 0o777).toBe(0o600);
    expect(readFileSync(artifact, "utf8")).toBe(evidence);
    expect(readFileSync(source, "utf8")).toBe(newer);
    expect(existsSync(destination)).toBeFalse();
    expect(transactions(directory)).toHaveLength(1);
  });

  test("an occupied normal capture target immediately before rename is never clobbered", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const foreignDestination = "foreign public destination";
    const evidence = "foreign captured-destination evidence";
    let artifact = "";
    let artifactDevice = 0;
    let artifactInode = 0;
    writeFileSync(source, "<h1>Original</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase, context) => {
        if (phase !== "beforeDestinationCaptureRename") return;
        artifact = context.capturedDestination;
        writeFileSync(artifact, evidence, { mode: 0o600 });
        chmodSync(artifact, 0o600);
        ({ dev: artifactDevice, ino: artifactInode } = lstatSync(artifact));
        unlinkSync(destination);
        writeFileSync(destination, foreignDestination);
      }),
    );

    const preserved = lstatSync(artifact);
    expect(preserved.dev).toBe(artifactDevice);
    expect(preserved.ino).toBe(artifactInode);
    expect(preserved.mode & 0o777).toBe(0o600);
    expect(readFileSync(artifact, "utf8")).toBe(evidence);
    expect(readFileSync(source, "utf8")).toBe("<h1>Original</h1>");
    expect(readFileSync(destination, "utf8")).toBe(foreignDestination);
    expect(transactions(directory)).toHaveLength(1);
  });

  test("an occupied rollback quarantine target immediately before rename is never clobbered", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const newer = "<h1>Foreign public source</h1>";
    const foreignDestination = "foreign rollback destination";
    const evidence = "foreign rollback quarantine evidence";
    let artifact = "";
    let artifactDevice = 0;
    let artifactInode = 0;
    writeFileSync(source, "<h1>Original</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase, context) => {
        if (phase === "afterDestinationLink") replaceAtomically(source, newer);
        if (phase !== "beforeRollbackDestinationQuarantineRename") return;
        artifact = context.capturedDestination;
        writeFileSync(artifact, evidence, { mode: 0o600 });
        chmodSync(artifact, 0o600);
        ({ dev: artifactDevice, ino: artifactInode } = lstatSync(artifact));
        unlinkSync(destination);
        writeFileSync(destination, foreignDestination);
      }),
    );

    const preserved = lstatSync(artifact);
    expect(preserved.dev).toBe(artifactDevice);
    expect(preserved.ino).toBe(artifactInode);
    expect(preserved.mode & 0o777).toBe(0o600);
    expect(readFileSync(artifact, "utf8")).toBe(evidence);
    expect(readFileSync(source, "utf8")).toBe(newer);
    expect(readFileSync(destination, "utf8")).toBe(foreignDestination);
    expect(transactions(directory)).toHaveLength(1);
  });

  test("a new public generation after retirement is never deleted and evidence fails closed", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>OLD</h1>");

    const error = expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase === "afterSourceRetirement") writeFileSync(source, "<h1>NEW</h1>");
      }),
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(readFileSync(source, "utf8")).toBe("<h1>NEW</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(transactions(directory)).toHaveLength(1);
    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(source, "utf8")).toBe("<h1>NEW</h1>");
  });

  test("an occupied destination is the only false path and leaves no artifacts", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Source</h1>");
    writeFileSync(destination, "foreign");

    expect(convertHtmlDirectory(directory)).toBe(0);
    expect(readFileSync(source, "utf8")).toBe("<h1>Source</h1>");
    expect(readFileSync(destination, "utf8")).toBe("foreign");
    expect(transactions(directory)).toEqual([]);
  });

  test("a foreign destination replacement before rollback survives", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>OLD</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase !== "afterDestinationLink") return;
        unlinkSync(destination);
        writeFileSync(destination, "foreign");
        writeFileSync(source, "<h1>NEW</h1>");
      }),
    );

    expect(readFileSync(destination, "utf8")).toBe("foreign");
    expect(readFileSync(source, "utf8")).toBe("<h1>NEW</h1>");
    expect(transactions(directory)).toEqual([]);
  });

  test("a foreign destination directory visible before capture is never quarantined", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const sentinel = join(destination, "sentinel");
    writeFileSync(source, "<h1>Original</h1>");

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase !== "afterDestinationLink") return;
        unlinkSync(destination);
        mkdirSync(destination);
        writeFileSync(sentinel, "preserved");
      }),
    );

    expect(readFileSync(source, "utf8")).toBe("<h1>Original</h1>");
    expect(lstatSync(destination).isDirectory()).toBeTrue();
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
    expect(transactions(directory)).toEqual([]);
  });

  test("success removes source and all transaction artifacts", () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Done</h1>");

    expect(convertHtmlDirectory(directory)).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Done");
    expect(transactions(directory)).toEqual([]);
  });

  posixTest("a backslash filename converts to the matching Markdown basename", () => {
    const directory = temp();
    const source = join(directory, String.raw`page\section.html`);
    const destination = join(directory, String.raw`page\section.md`);
    writeFileSync(source, "<h1>Backslash</h1>");

    expect(convertHtmlDirectory(directory)).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Backslash");
    expect(transactions(directory)).toEqual([]);
    expect(cleanups(directory)).toEqual([]);
  });

  posixTest("a backslash filename recovers and cleans its crash transaction", async () => {
    const directory = temp();
    const source = join(directory, String.raw`crash\page.html`);
    const destination = join(directory, String.raw`crash\page.md`);
    writeFileSync(source, "<h1>Backslash crash</h1>");

    expect(await crashAt(directory, "afterDestinationLink")).toBe(73);
    expect(transactions(directory)).toHaveLength(1);
    expect(convertHtmlDirectory(directory)).toBe(1);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Backslash crash");
    expect(transactions(directory)).toEqual([]);
    expect(cleanups(directory)).toEqual([]);
  });

  for (const phase of ["afterDestinationLink", "afterSourceRetirement"] as const) {
    test(`a true crash at ${phase} restores the only source copy and rolls back output`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Crash</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      expect(transactions(directory)).toHaveLength(1);
      if (phase === "afterDestinationLink") expect(existsSync(source)).toBeTrue();
      else expect(existsSync(source)).toBeFalse();
      expect(existsSync(destination)).toBeTrue();

      expectError(() =>
        convertHtmlDirectoryForTest(directory, (currentPhase) => {
          if (currentPhase === "transactionPrepared") throw new Error("stop after recovery");
        }),
      );
      expect(readFileSync(source, "utf8")).toBe("<h1>Crash</h1>");
      expect(existsSync(destination)).toBeFalse();
      expect(transactions(directory)).toEqual([]);

      expect(convertHtmlDirectory(directory)).toBe(1);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Crash");
      expect(transactions(directory)).toEqual([]);
    });
  }

  test("a true crash after durable commit finalizes without restoring old source", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Committed</h1>");

    expect(await crashAt(directory, "afterDurableCommit")).toBe(73);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Committed");
    expect(transactions(directory)).toHaveLength(1);

    expect(convertHtmlDirectory(directory)).toBe(0);
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Committed");
    expect(transactions(directory)).toEqual([]);
  });

  for (const phase of [
    "afterCommitPendingCreation",
    "afterCommitPendingWrite",
    "afterCommitMarkerLink",
    "afterCommitPendingRemoval",
  ] as const) {
    test(`commit marker publication recovers after a true crash at ${phase}`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Commit marker</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      const transaction = onlyTransaction(directory);
      const names = readdirSync(transaction);
      expect(names.includes("committed")).toBe(
        phase === "afterCommitMarkerLink" || phase === "afterCommitPendingRemoval",
      );
      expect(names.includes("committed.pending")).toBe(phase !== "afterCommitPendingRemoval");

      if (phase === "afterCommitPendingCreation") {
        expectError(() =>
          convertHtmlDirectoryForTest(directory, (currentPhase) => {
            if (currentPhase === "transactionPrepared") throw new Error("stop after rollback");
          }),
        );
        expect(readFileSync(source, "utf8")).toContain("Commit marker");
        expect(existsSync(destination)).toBeFalse();
      } else {
        expect(convertHtmlDirectory(directory)).toBe(0);
        expect(existsSync(source)).toBeFalse();
        expect(readFileSync(destination, "utf8")).toContain("# Commit marker");
      }
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    });
  }

  for (const phase of [
    "afterCleanupPendingCreation",
    "afterCleanupPendingWrite",
    "afterCleanupMarkerLink",
    "afterCleanupPendingRemoval",
  ] as const) {
    test(`cleanup marker publication recovers after a true crash at ${phase}`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Cleanup marker</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      const transaction = onlyTransaction(directory);
      const names = readdirSync(transaction);
      expect(names.includes("cleanup-ready")).toBe(
        phase === "afterCleanupMarkerLink" || phase === "afterCleanupPendingRemoval",
      );
      expect(names.includes("cleanup-ready.pending")).toBe(phase !== "afterCleanupPendingRemoval");
      expect(convertHtmlDirectory(directory)).toBe(0);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Cleanup marker");
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    });
  }

  foreignUidTest(
    "a readable foreign-uid source commits and crash recovery finalizes it",
    async () => {
      const foreignUid = process.getuid?.() === 65_534 ? 65_533 : 65_534;
      const group = process.getgid?.() ?? 0;
      const normalDirectory = temp();
      const normalSource = join(normalDirectory, "foreign-owner.html");
      const normalDestination = join(normalDirectory, "foreign-owner.md");
      writeFileSync(normalSource, "<h1>Foreign owner normal</h1>", { mode: 0o644 });
      chmodSync(normalSource, 0o644);
      chownSync(normalSource, foreignUid, group);

      expect(convertHtmlDirectory(normalDirectory)).toBe(1);
      expect(existsSync(normalSource)).toBeFalse();
      expect(readFileSync(normalDestination, "utf8")).toContain("# Foreign owner normal");
      expect(transactions(normalDirectory)).toEqual([]);

      const directory = temp();
      const source = join(directory, "foreign-owner.html");
      const destination = join(directory, "foreign-owner.md");
      writeFileSync(source, "<h1>Foreign owner</h1>", { mode: 0o644 });
      chmodSync(source, 0o644);
      chownSync(source, foreignUid, group);

      expect(await crashAt(directory, "afterDurableCommit")).toBe(73);
      const transaction = onlyTransaction(directory);
      expect(lstatSync(join(transaction, "retired-source")).uid).toBe(foreignUid);
      expect(readFileSync(destination, "utf8")).toContain("# Foreign owner");

      expect(convertHtmlDirectory(directory)).toBe(0);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Foreign owner");
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    },
  );

  for (const phase of [
    "afterSourceRetirementRename",
    "afterSourceRetirementTargetSync",
    "afterDestinationCaptureRename",
    "afterDestinationCaptureTargetSync",
  ] as const) {
    test(`recovery is safe at the preserving rename durability boundary ${phase}`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Boundary</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      expect(transactions(directory)).toHaveLength(1);
      expectError(() =>
        convertHtmlDirectoryForTest(directory, (currentPhase) => {
          if (currentPhase === "transactionPrepared") throw new Error("stop after recovery");
        }),
      );
      expect(readFileSync(source, "utf8")).toBe("<h1>Boundary</h1>");
      expect(existsSync(destination)).toBeFalse();
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    });
  }

  for (const phase of [
    "afterRollbackDestinationQuarantineRename",
    "afterRollbackDestinationQuarantineTargetSync",
  ] as const) {
    test(`rollback quarantine recovers at ${phase}`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Rollback</h1>");
      expect(await crashAt(directory, "afterDestinationLink")).toBe(73);

      expect(await crashAt(directory, phase)).toBe(73);
      expect(transactions(directory)).toHaveLength(1);
      expectError(() =>
        convertHtmlDirectoryForTest(directory, (currentPhase) => {
          if (currentPhase === "transactionPrepared") throw new Error("stop after recovery");
        }),
      );
      expect(readFileSync(source, "utf8")).toBe("<h1>Rollback</h1>");
      expect(existsSync(destination)).toBeFalse();
      expect(transactions(directory)).toEqual([]);
    });
  }

  test("missing public and retired sources preserves transaction and public output evidence", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Only copy</h1>");
    expect(await crashAt(directory, "afterSourceRetirement")).toBe(73);
    const transaction = onlyTransaction(directory);
    unlinkSync(join(transaction, "retired-source"));

    expectError(() => convertHtmlDirectory(directory));
    expect(existsSync(source)).toBeFalse();
    expect(readFileSync(destination, "utf8")).toContain("# Only copy");
    expect(existsSync(join(transaction, "manifest.json"))).toBeTrue();
    expect(existsSync(join(transaction, "output"))).toBeTrue();
  });

  test("a same-size retired rewrite is restored but retained as conflicting evidence", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>OLD</h1>");
    expect(await crashAt(directory, "afterSourceRetirement")).toBe(73);
    const transaction = onlyTransaction(directory);
    writeFileSync(join(transaction, "retired-source"), "<h1>BAD</h1>");

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(source, "utf8")).toBe("<h1>BAD</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(readFileSync(join(transaction, "retired-source"), "utf8")).toBe("<h1>BAD</h1>");
    expect(existsSync(join(transaction, "manifest.json"))).toBeTrue();
    expect(existsSync(join(transaction, "output"))).toBeTrue();
    expectError(() => convertHtmlDirectory(directory));
  });

  test("a symlinked retired source fails closed without touching its target", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const sentinel = join(directory, "sentinel");
    writeFileSync(source, "<h1>Original</h1>");
    writeFileSync(sentinel, "untouched");
    expect(await crashAt(directory, "afterSourceRetirement")).toBe(73);
    const transaction = onlyTransaction(directory);
    unlinkSync(join(transaction, "retired-source"));
    symlinkSync(sentinel, join(transaction, "retired-source"));

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(existsSync(source)).toBeFalse();
    expect(existsSync(destination)).toBeTrue();
    expect(transactions(directory)).toHaveLength(1);
  });

  test("a malformed public-only source retains transaction evidence", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const sentinel = join(directory, "sentinel");
    writeFileSync(source, "<h1>Original</h1>");
    writeFileSync(sentinel, "foreign");
    expect(await crashAt(directory, "afterDestinationLink")).toBe(73);
    unlinkSync(source);
    symlinkSync(sentinel, source);

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(sentinel, "utf8")).toBe("foreign");
    expect(existsSync(destination)).toBeFalse();
    expect(transactions(directory)).toHaveLength(1);
  });

  test("a different regular public-only generation survives and retains crash evidence", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>OLD</h1>");
    expect(await crashAt(directory, "afterDestinationLink")).toBe(73);
    const transaction = onlyTransaction(directory);
    unlinkSync(source);
    writeFileSync(source, "<h1>NEW</h1>");

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(source, "utf8")).toBe("<h1>NEW</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(onlyTransaction(directory)).toBe(transaction);
    expect(existsSync(join(transaction, "output"))).toBeTrue();
    expect(existsSync(join(transaction, "manifest.json"))).toBeTrue();
  });

  test("foreign public source and destination generations both survive recovery", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Original</h1>");
    expect(await crashAt(directory, "afterSourceRetirement")).toBe(73);
    writeFileSync(source, "<h1>Foreign source</h1>");
    unlinkSync(destination);
    writeFileSync(destination, "foreign destination");

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(source, "utf8")).toBe("<h1>Foreign source</h1>");
    expect(readFileSync(destination, "utf8")).toBe("foreign destination");
    expect(readFileSync(join(onlyTransaction(directory), "retired-source"), "utf8")).toBe(
      "<h1>Original</h1>",
    );
  });

  test("uncommitted rollback resumes from the cleanup namespace without public mutation", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Rollback cleanup</h1>");
    expect(await crashAt(directory, "afterDestinationLink")).toBe(73);

    expect(await crashAt(directory, "afterCleanupTransition")).toBe(73);
    expect(readFileSync(source, "utf8")).toBe("<h1>Rollback cleanup</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(cleanups(directory)).toHaveLength(1);
    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase === "transactionPrepared") throw new Error("stop after cleanup recovery");
      }),
    );
    expect(readFileSync(source, "utf8")).toBe("<h1>Rollback cleanup</h1>");
    expect(existsSync(destination)).toBeFalse();
    expect(cleanups(directory)).toEqual([]);
  });

  test("a quarantined foreign destination symlink is restored without following it", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    const sentinel = join(directory, "sentinel");
    writeFileSync(source, "<h1>Symlink destination</h1>");
    writeFileSync(sentinel, "untouched");
    expect(await crashAt(directory, "afterDestinationLink")).toBe(73);
    expect(await crashAt(directory, "afterRollbackDestinationQuarantineRename")).toBe(73);
    const transaction = onlyTransaction(directory);
    const captured = join(transaction, "captured-destination");
    unlinkSync(captured);
    symlinkSync(sentinel, captured);

    expectError(() =>
      convertHtmlDirectoryForTest(directory, (phase) => {
        if (phase === "transactionPrepared") throw new Error("stop after recovery");
      }),
    );
    expect(readFileSync(destination, "utf8")).toBe("untouched");
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(readFileSync(source, "utf8")).toBe("<h1>Symlink destination</h1>");
    expect(transactions(directory)).toEqual([]);
  });

  test("recovery restores an already-captured foreign directory as the exact inode", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Directory recovery</h1>");
    expect(await crashAt(directory, "afterDestinationCaptureRename")).toBe(73);
    const transaction = onlyTransaction(directory);
    const captured = join(transaction, "captured-destination");
    unlinkSync(captured);
    mkdirSync(captured);
    writeFileSync(join(captured, "sentinel"), "preserved");
    const before = lstatSync(captured);

    expect(convertHtmlDirectory(directory)).toBe(0);
    const restored = lstatSync(destination);
    expect(restored.isDirectory()).toBeTrue();
    expect(restored.dev).toBe(before.dev);
    expect(restored.ino).toBe(before.ino);
    expect(readFileSync(join(destination, "sentinel"), "utf8")).toBe("preserved");
    expect(readFileSync(source, "utf8")).toBe("<h1>Directory recovery</h1>");
    expect(transactions(directory)).toEqual([]);
  });

  test("a competing public name preserves an already-captured foreign directory", async () => {
    const directory = temp();
    const source = join(directory, "page.html");
    const destination = join(directory, "page.md");
    writeFileSync(source, "<h1>Directory conflict</h1>");
    expect(await crashAt(directory, "afterDestinationCaptureRename")).toBe(73);
    const transaction = onlyTransaction(directory);
    const captured = join(transaction, "captured-destination");
    unlinkSync(captured);
    mkdirSync(captured);
    writeFileSync(join(captured, "sentinel"), "preserved");
    writeFileSync(destination, "competitor");

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(destination, "utf8")).toBe("competitor");
    expect(readFileSync(join(captured, "sentinel"), "utf8")).toBe("preserved");
    expect(readFileSync(source, "utf8")).toBe("<h1>Directory conflict</h1>");
    expect(onlyTransaction(directory)).toBe(transaction);
  });

  for (const phase of [
    "afterCleanupMarker",
    "afterCleanupTransition",
    "afterCleanupManifestRemoval",
    "afterCleanupOutputRemoval",
    "afterCleanupCommitRemoval",
    "afterCleanupMarkerRemoval",
  ] as const) {
    test(`committed cleanup resumes after a crash at ${phase}`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Cleanup</h1>");

      expect(await crashAt(directory, phase)).toBe(73);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Cleanup");
      expect(transactions(directory).length + cleanups(directory).length).toBe(1);
      if (phase === "afterCleanupMarkerRemoval") {
        const names = cleanups(directory);
        expect(names).toHaveLength(1);
        const tombstone = join(directory, names[0] as string);
        expect(readdirSync(tombstone)).toEqual([]);
        expect(lstatSync(tombstone).mode & 0o777).toBe(0o700);
      }
      expect(convertHtmlDirectory(directory)).toBe(0);
      expect(existsSync(source)).toBeFalse();
      expect(readFileSync(destination, "utf8")).toContain("# Cleanup");
      expect(transactions(directory)).toEqual([]);
      expect(cleanups(directory)).toEqual([]);
    });
  }

  test("a canonical mode-0300 cleanup transition repairs a lost marker and sweeps", () => {
    const directory = temp();
    const cleanup = join(directory, `${cleanupPrefix}${randomUUID()}`);
    mkdirSync(cleanup, { mode: 0o300 });
    chmodSync(cleanup, 0o300);
    const output = join(cleanup, "output");
    writeFileSync(output, "private partial output", { mode: 0o600 });
    chmodSync(output, 0o600);

    expect(convertHtmlDirectory(directory)).toBe(0);
    expect(existsSync(cleanup)).toBeFalse();
  });

  test("malformed canonical mode-0300 cleanup state is retained without following symlinks", () => {
    for (const kind of ["unexpected", "symlink", "marker"] as const) {
      const directory = temp();
      const cleanup = join(directory, `${cleanupPrefix}${randomUUID()}`);
      const sentinel = join(directory, "sentinel");
      mkdirSync(cleanup, { mode: 0o300 });
      chmodSync(cleanup, 0o300);
      writeFileSync(sentinel, "untouched");
      if (kind === "unexpected")
        writeFileSync(join(cleanup, "unexpected"), "retain me", { mode: 0o600 });
      else if (kind === "symlink") symlinkSync(sentinel, join(cleanup, "output"));
      else {
        writeFileSync(join(cleanup, "cleanup-ready"), "wrong\n", { mode: 0o600 });
        chmodSync(join(cleanup, "cleanup-ready"), 0o600);
      }

      expectError(() => convertHtmlDirectory(directory));
      expect(existsSync(cleanup)).toBeTrue();
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      chmodSync(cleanup, 0o700);
    }
  });

  test("a noncanonical mode-0300 cleanup directory fails closed", () => {
    const directory = temp();
    const cleanup = join(directory, `${cleanupPrefix}not-a-uuid`);
    mkdirSync(cleanup, { mode: 0o300 });
    chmodSync(cleanup, 0o300);

    expectError(() => convertHtmlDirectory(directory));
    expect(existsSync(cleanup)).toBeTrue();
    expect(lstatSync(cleanup).mode & 0o777).toBe(0o300);
    chmodSync(cleanup, 0o700);
  });

  test("an empty private cleanup tombstone is harmless", () => {
    const directory = temp();
    const tombstone = join(directory, `${cleanupPrefix}empty`);
    mkdirSync(tombstone, { mode: 0o700 });
    chmodSync(tombstone, 0o700);

    expect(convertHtmlDirectory(directory)).toBe(0);
    expect(existsSync(tombstone)).toBeFalse();
  });

  for (const prefix of [preparationPrefix, transactionPrefix, cleanupPrefix]) {
    test(`an exact ${prefix} symlink surface is rejected without following it`, () => {
      const directory = temp();
      const target = temp();
      const sentinel = join(target, "sentinel");
      writeFileSync(sentinel, "untouched");
      symlinkSync(target, join(directory, prefix));

      expectError(() => convertHtmlDirectory(directory));
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(existsSync(join(directory, prefix))).toBeTrue();
    });

    test(`an exact ${prefix} malformed file surface is retained`, () => {
      const directory = temp();
      const malformed = join(directory, prefix);
      writeFileSync(malformed, "not a private directory");

      expectError(() => convertHtmlDirectory(directory));
      expect(readFileSync(malformed, "utf8")).toBe("not a private directory");
    });
  }

  test("unexpected reserved artifacts are retained", () => {
    for (const prefix of [preparationPrefix, transactionPrefix, cleanupPrefix]) {
      const directory = temp();
      const surface = join(directory, `${prefix}unexpected`);
      mkdirSync(surface, { mode: 0o700 });
      chmodSync(surface, 0o700);
      writeFileSync(join(surface, "unexpected"), "retain me");

      expectError(() => convertHtmlDirectory(directory));
      expect(readFileSync(join(surface, "unexpected"), "utf8")).toBe("retain me");
    }
  });

  test("symlinked and malformed preparation artifacts fail closed", () => {
    for (const kind of ["symlink", "directory", "mode", "marker"] as const) {
      const directory = temp();
      const preparation = join(directory, `${preparationPrefix}${randomUUID()}`);
      const artifact = join(preparation, kind === "marker" ? "cleanup-ready" : "output");
      const sentinel = join(directory, "sentinel");
      mkdirSync(preparation, { mode: 0o300 });
      chmodSync(preparation, 0o300);
      writeFileSync(sentinel, "untouched");
      if (kind === "symlink") symlinkSync(sentinel, artifact);
      else if (kind === "directory") mkdirSync(artifact);
      else if (kind === "mode") {
        writeFileSync(artifact, "private content", { mode: 0o600 });
        chmodSync(artifact, 0o644);
      } else {
        writeFileSync(artifact, "wrong\n", { mode: 0o600 });
        chmodSync(artifact, 0o600);
      }

      expectError(() => convertHtmlDirectory(directory));
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(existsSync(preparation)).toBeTrue();
      chmodSync(preparation, 0o700);
    }
  });

  test("a noncanonical broad-prefix preparation directory is retained", () => {
    const directory = temp();
    const preparation = join(directory, `${preparationPrefix}not-a-transaction`);
    mkdirSync(preparation, { mode: 0o700 });
    chmodSync(preparation, 0o700);
    writeFileSync(join(preparation, "output"), "arbitrary", { mode: 0o600 });

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(join(preparation, "output"), "utf8")).toBe("arbitrary");
  });

  test("an incomplete canonical mode-0700 preparation directory is retained", () => {
    const directory = temp();
    const preparation = join(directory, `${preparationPrefix}${randomUUID()}`);
    mkdirSync(preparation, { mode: 0o700 });
    chmodSync(preparation, 0o700);
    writeFileSync(join(preparation, "output"), "arbitrary", { mode: 0o600 });

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(join(preparation, "output"), "utf8")).toBe("arbitrary");
  });

  test("a complete-shaped but invalid canonical mode-0700 preparation is retained", () => {
    const directory = temp();
    const preparation = join(directory, `${preparationPrefix}${randomUUID()}`);
    mkdirSync(preparation, { mode: 0o700 });
    chmodSync(preparation, 0o700);
    writeFileSync(join(preparation, "output"), "arbitrary", { mode: 0o600 });
    writeFileSync(join(preparation, "manifest.json"), '{"invalid":true}\n', { mode: 0o600 });

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(join(preparation, "output"), "utf8")).toBe("arbitrary");
    expect(readFileSync(join(preparation, "manifest.json"), "utf8")).toBe('{"invalid":true}\n');
  });

  for (const mutation of ["output", "public source"] as const) {
    test(`a ready mode-0700 preparation with changed ${mutation} fails closed`, async () => {
      const directory = temp();
      const source = join(directory, "page.html");
      const destination = join(directory, "page.md");
      writeFileSync(source, "<h1>Ready preparation</h1>");
      expect(await crashAt(directory, "afterPreparationReadyModeTransition")).toBe(73);
      const preparation = join(directory, preparations(directory)[0] as string);
      if (mutation === "output") writeFileSync(join(preparation, "output"), "tampered");
      else writeFileSync(source, "<h1>Changed preparation</h1>");

      expectError(() => convertHtmlDirectory(directory));
      expect(existsSync(preparation)).toBeTrue();
      expect(existsSync(destination)).toBeFalse();
      expect(existsSync(source)).toBeTrue();
    });
  }

  test("a malformed cleanup marker is strict and retained", () => {
    const directory = temp();
    const surface = join(directory, `${cleanupPrefix}bad-marker`);
    mkdirSync(surface, { mode: 0o700 });
    chmodSync(surface, 0o700);
    const marker = join(surface, "cleanup-ready");
    writeFileSync(marker, "wrong\n", { mode: 0o600 });
    chmodSync(marker, 0o600);

    expectError(() => convertHtmlDirectory(directory));
    expect(readFileSync(marker, "utf8")).toBe("wrong\n");
  });
});

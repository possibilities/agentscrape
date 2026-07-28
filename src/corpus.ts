import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type PreparedTextArtifact,
  preflightTextArtifacts,
  writePreparedTextArtifacts,
} from "./artifacts";
import {
  closeSessionBestEffort,
  currentBrowserNetworkPolicy,
  runAgentBrowser,
  withBrowserNetworkPolicy,
} from "./browser";
import { EnvelopeBuildError, validateRequestUrl } from "./envelope";
import {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeNetworkPolicyError,
  AgentscrapeRuntimeError,
  AgentscrapeUpstreamDownError,
  AgentscrapeUsageError,
  AgentscrapeValueError,
  cancellationError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  throwIfAborted,
} from "./errors";
import type { ScrapeResult } from "./handlers/types";
import { offlineExtractLinks } from "./links";
import { loadRegistry, matchPreset, type PresetConfig, scrapeWithPreset } from "./presets";
import { resolveDataHome } from "./queue-paths";
import { redactDiagnostic, redactUrl, sanitizeErrorInPlace } from "./redaction";
import { type LinkItem, LinkList } from "./schemas";

export const CORPUS_VERSION = 1;
export const CORPUS_ARTIFACT_MAX_BYTES = 8_000_000;
export const CORPUS_AGGREGATE_MAX_BYTES = 24_000_000;
const ROOT = join(import.meta.dir, "../test/corpus");
const FAILURE_TYPES: Record<string, abstract new (...args: never[]) => Error> = {
  AgentscrapeAuthError,
  AgentscrapeError,
  AgentscrapeUpstreamDownError,
  PresetConfigError,
  PresetDriftError,
  PresetOutputError,
  PresetSelectionError,
  Error,
  TypeError,
  RangeError,
  ValueError: AgentscrapeValueError,
  RuntimeError: AgentscrapeRuntimeError,
};
class CorpusError extends Error {}
interface Meta {
  version: number;
  preset: string;
  mode: "content" | "links" | "nav-links";
  url: string;
  expect: "success" | "failure";
  structured?: unknown;
  links?: LinkItem[];
  failure?: { type?: string; contains?: string; message_captured?: string };
  assertions?: { contains?: string[]; not_contains?: string[] };
  category_pages?: Array<{ section_url: string; page: string }>;
}
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

class CorpusSecurityError extends CorpusError {}

// Node exposes no openat-style relative filesystem operations. These retained descriptors plus
// repeated descriptor/path identities are the strongest available boundary here; private ownership
// excludes cross-UID mutation, but this does not claim protection from a malicious same-UID process.
interface DirectoryGuard {
  path: string;
  readonly descriptor: number;
  readonly identity: Pick<BigIntStats, "dev" | "ino" | "uid" | "mode">;
  readonly privateDirectory: boolean;
}

interface SecureSampleContext {
  readonly sampleRoot: string;
  readonly guards: readonly DirectoryGuard[];
  readonly budget: {
    totalBytes: number;
    readonly files: Map<string, Pick<BigIntStats, "dev" | "ino" | "size">>;
  };
}

const DIRECTORY_IDENTITY_FIELDS = ["dev", "ino", "uid", "mode"] as const;
const FILE_STABILITY_FIELDS = [
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;

function currentUid(): bigint {
  if (typeof process.getuid !== "function")
    throw new CorpusSecurityError("POSIX file ownership is required for the corpus overlay");
  return BigInt(process.getuid());
}

function lstatBigIntOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CorpusSecurityError(`cannot inspect corpus path: ${path}`);
  }
}

function sameFields<T extends (typeof DIRECTORY_IDENTITY_FIELDS)[number]>(
  left: Pick<BigIntStats, T>,
  right: Pick<BigIntStats, T>,
  fields: readonly T[],
): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function sameDirectoryIdentity(
  left: Pick<BigIntStats, (typeof DIRECTORY_IDENTITY_FIELDS)[number]>,
  right: Pick<BigIntStats, (typeof DIRECTORY_IDENTITY_FIELDS)[number]>,
): boolean {
  return sameFields(left, right, DIRECTORY_IDENTITY_FIELDS);
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return FILE_STABILITY_FIELDS.every((field) => left[field] === right[field]);
}

function requireDirectory(path: string, info: BigIntStats, privateDirectory: boolean): void {
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CorpusSecurityError(`corpus ancestry is not a plain directory: ${path}`);
  if (privateDirectory && info.uid !== currentUid())
    throw new CorpusSecurityError(`corpus directory has foreign ownership: ${path}`);
  if (privateDirectory && (info.mode & 0o077n) !== 0n)
    throw new CorpusSecurityError(`corpus directory is not private: ${path}`);
}

function openDirectoryGuard(path: string, privateDirectory: boolean): DirectoryGuard {
  const before = lstatBigIntOrNull(path);
  if (!before) throw new CorpusSecurityError(`corpus directory disappeared: ${path}`);
  requireDirectory(path, before, privateDirectory);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatBigIntOrNull(path);
    if (!after) throw new CorpusSecurityError(`corpus directory disappeared: ${path}`);
    requireDirectory(path, opened, privateDirectory);
    requireDirectory(path, after, privateDirectory);
    if (!sameDirectoryIdentity(before, opened) || !sameDirectoryIdentity(opened, after))
      throw new CorpusSecurityError(`corpus directory identity changed: ${path}`);
    return {
      path,
      descriptor,
      identity: {
        dev: opened.dev,
        ino: opened.ino,
        uid: opened.uid,
        mode: opened.mode,
      },
      privateDirectory,
    };
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (error instanceof CorpusSecurityError) throw error;
    throw new CorpusSecurityError(`cannot securely open corpus directory: ${path}`);
  }
}

function revalidateDirectoryGuard(guard: DirectoryGuard): void {
  let opened: BigIntStats;
  try {
    opened = fstatSync(guard.descriptor, { bigint: true });
  } catch {
    throw new CorpusSecurityError(`corpus directory guard was closed: ${guard.path}`);
  }
  const pathname = lstatBigIntOrNull(guard.path);
  if (!pathname) throw new CorpusSecurityError(`corpus directory disappeared: ${guard.path}`);
  requireDirectory(guard.path, opened, guard.privateDirectory);
  requireDirectory(guard.path, pathname, guard.privateDirectory);
  if (!sameDirectoryIdentity(guard.identity, opened) || !sameDirectoryIdentity(opened, pathname))
    throw new CorpusSecurityError(`corpus directory identity changed: ${guard.path}`);
}

function revalidateDirectoryGuards(guards: readonly DirectoryGuard[]): void {
  for (const guard of guards) revalidateDirectoryGuard(guard);
  for (let index = 1; index < guards.length; index += 1) {
    const parent = guards[index - 1]!;
    const child = guards[index]!;
    if (dirname(child.path) !== parent.path)
      throw new CorpusSecurityError("corpus directory guard ancestry is ambiguous");
    const childName = relative(parent.path, child.path);
    if (!childName || childName.includes(sep))
      throw new CorpusSecurityError("corpus directory guard ancestry is ambiguous");
    const relativeChild = lstatBigIntOrNull(join(parent.path, childName));
    if (!relativeChild || !sameDirectoryIdentity(relativeChild, child.identity))
      throw new CorpusSecurityError(`corpus parent-relative identity changed: ${child.path}`);
  }
}

function closeDirectoryGuards(guards: readonly DirectoryGuard[]): void {
  for (const guard of [...guards].reverse()) {
    try {
      closeSync(guard.descriptor);
    } catch {
      // A prior corpus result or security failure wins.
    }
  }
}

function absolutePathPrefixes(path: string): string[] {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
    throw new CorpusSecurityError("corpus path must be a normalized absolute path");
  const root = parsePath(path).root;
  const prefixes = [root];
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    assertSafeName(part);
    current = join(current, part);
    prefixes.push(current);
  }
  return prefixes;
}

function openAncestryGuards(
  path: string,
  privateDirectories: ReadonlySet<string>,
): DirectoryGuard[] {
  const guards: DirectoryGuard[] = [];
  try {
    for (const prefix of absolutePathPrefixes(path)) {
      revalidateDirectoryGuards(guards);
      guards.push(openDirectoryGuard(prefix, privateDirectories.has(prefix)));
    }
    revalidateDirectoryGuards(guards);
    return guards;
  } catch (error) {
    closeDirectoryGuards(guards);
    throw error;
  }
}

function requirePrivateFile(path: string, info: BigIntStats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== currentUid() ||
    info.nlink !== 1n ||
    (info.mode & 0o077n) !== 0n
  )
    throw new CorpusSecurityError(`corpus file is foreign, nonprivate, or ambiguous: ${path}`);
}

function secureFilePath(path: string, security: SecureSampleContext): void {
  const fromSample = relative(security.sampleRoot, path);
  if (
    !fromSample ||
    isAbsolute(fromSample) ||
    fromSample === ".." ||
    fromSample.startsWith(`..${sep}`)
  )
    throw new CorpusSecurityError("corpus fixture path escapes its sample directory");
  for (const part of fromSample.split(sep)) assertSafeName(part);
}

function readCorpusText(path: string, security?: SecureSampleContext): string | null {
  if (!security) return existsSync(path) ? readFileSync(path, "utf8") : null;
  secureFilePath(path, security);
  revalidateDirectoryGuards(security.guards);
  const before = lstatBigIntOrNull(path);
  if (!before) {
    revalidateDirectoryGuards(security.guards);
    return null;
  }
  requirePrivateFile(path, before);
  if (before.size > BigInt(CORPUS_ARTIFACT_MAX_BYTES))
    throw new CorpusSecurityError(
      `corpus file exceeds ${CORPUS_ARTIFACT_MAX_BYTES}-byte limit: ${path}`,
    );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    requirePrivateFile(path, opened);
    if (!sameFileState(before, opened))
      throw new CorpusSecurityError(`corpus file identity changed before read: ${path}`);
    const prior = security.budget.files.get(path);
    if (prior) {
      if (prior.dev !== opened.dev || prior.ino !== opened.ino || prior.size !== opened.size)
        throw new CorpusSecurityError(`corpus file identity changed between reads: ${path}`);
    } else {
      const nextTotal = security.budget.totalBytes + Number(opened.size);
      if (nextTotal > CORPUS_AGGREGATE_MAX_BYTES)
        throw new CorpusSecurityError(
          `corpus sample exceeds ${CORPUS_AGGREGATE_MAX_BYTES}-byte aggregate limit`,
        );
      security.budget.totalBytes = nextTotal;
      security.budget.files.set(path, {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
      });
    }
    const value = readFileSync(descriptor, "utf8");
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatBigIntOrNull(path);
    if (!afterPath) throw new CorpusSecurityError(`corpus file disappeared during read: ${path}`);
    requirePrivateFile(path, afterDescriptor);
    requirePrivateFile(path, afterPath);
    if (!sameFileState(opened, afterDescriptor) || !sameFileState(afterDescriptor, afterPath))
      throw new CorpusSecurityError(`corpus file identity changed during read: ${path}`);
    revalidateDirectoryGuards(security.guards);
    return value;
  } catch (error) {
    if (error instanceof CorpusSecurityError) throw error;
    throw new CorpusSecurityError(`cannot securely read corpus file: ${path}`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function loadMeta(directory: string, security?: SecureSampleContext): Meta {
  const path = join(directory, "meta.yaml");
  const text = readCorpusText(path, security);
  if (text === null) throw new CorpusError("missing meta.yaml");
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new CorpusError(`malformed meta.yaml: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CorpusError("meta.yaml must be a mapping");
  const data = value as Record<string, unknown>;
  if (data.version !== CORPUS_VERSION)
    throw new CorpusError(
      `unsupported sample contract version ${String(data.version)} (expected ${CORPUS_VERSION})`,
    );
  for (const field of ["preset", "mode", "url", "expect"])
    if (!(field in data)) throw new CorpusError(`meta.yaml missing required field: ${field}`);
  if (!["content", "links", "nav-links"].includes(data.mode as string))
    throw new CorpusError(`meta.yaml has unsupported mode: '${String(data.mode)}'`);
  if (!["success", "failure"].includes(data.expect as string))
    throw new CorpusError(
      `meta.yaml 'expect' must be 'success' or 'failure', got '${String(data.expect)}'`,
    );
  return data as unknown as Meta;
}
function rootHtml(directory: string, security?: SecureSampleContext): string {
  const selected = readCorpusText(join(directory, "selected.html"), security);
  if (selected?.trim()) return selected;
  const page = readCorpusText(join(directory, "page.html"), security);
  if (page !== null) return page;
  throw new CorpusError("no page.html or selected.html input found");
}
function verifyFailure(meta: Meta, error: unknown): void {
  if (!meta.failure?.type) throw new CorpusError("expect: failure requires a 'failure.type' field");
  const expected = FAILURE_TYPES[meta.failure.type];
  if (!expected) throw new CorpusError(`unknown failure type in meta.yaml: '${meta.failure.type}'`);
  const value = error instanceof Error ? error : new Error(String(error));
  const matches = (candidate: Error, expectedType: abstract new (...args: never[]) => Error) =>
    candidate instanceof expectedType;
  if (!matches(value, expected))
    throw new CorpusError(
      `expected failure type ${meta.failure.type}, got ${value.constructor.name}: ${value.message}`,
    );
  if (meta.failure.type === "PresetDriftError" && !(value instanceof PresetDriftError))
    throw new CorpusError(
      `expected failure type PresetDriftError, got ${value.constructor.name}: ${value.message}`,
    );
  if (meta.failure.contains && !value.message.includes(meta.failure.contains))
    throw new CorpusError(
      `failure message missing expected substring '${meta.failure.contains}': ${value.message}`,
    );
}
function verifySuccess(
  directory: string,
  meta: Meta,
  markdown: string,
  payload: unknown,
  security?: SecureSampleContext,
): void {
  const expected = readCorpusText(join(directory, "expected.md"), security);
  if (expected === null) throw new CorpusError("expect: success requires expected.md");
  if (markdown.trim() !== expected.trim())
    throw new CorpusError("markdown does not match expected.md");
  if (meta.mode === "content") {
    if ("structured" in meta && !isDeepStrictEqual(payload, meta.structured))
      throw new CorpusError("structured output does not match meta.yaml 'structured'");
  } else {
    if (!meta.links)
      throw new CorpusError(`expect: success (${meta.mode} mode) requires a 'links' field`);
    if (!isDeepStrictEqual(payload, meta.links))
      throw new CorpusError("extracted links do not match meta.yaml 'links'");
  }
  for (const needle of meta.assertions?.contains ?? [])
    if (!markdown.includes(needle))
      throw new CorpusError(`expected markdown to contain '${needle}'`);
  for (const needle of meta.assertions?.not_contains ?? [])
    if (markdown.includes(needle))
      throw new CorpusError(`expected markdown to NOT contain '${needle}'`);
}
async function replay(
  directory: string,
  meta: Meta,
  preset: PresetConfig,
  security?: SecureSampleContext,
): Promise<[string, unknown]> {
  if (meta.mode === "content") {
    const result = await scrapeWithPreset(meta.url, preset, {
      html: rootHtml(directory, security),
    });
    return [result.markdown, plain(result.structured)];
  }
  if (meta.mode === "links") {
    const section = new URL(meta.url).pathname.replace(/\/$/, "").split("/").pop() ?? "";
    const links = offlineExtractLinks(
      rootHtml(directory, security),
      preset.selector!,
      meta.url,
    ).map((item) => ({ ...item, section }));
    const structured = new LinkList(links);
    return [structured.toMarkdown(), links];
  }
  if (!meta.category_pages?.length)
    throw new CorpusError("nav-links mode requires 'category_pages' in meta.yaml");
  const pages = new Map(
    meta.category_pages.map((entry) => {
      const path = join(directory, entry.page);
      const content = readCorpusText(path, security);
      if (content === null) throw new CorpusError(`missing category page fixture: ${entry.page}`);
      return [entry.section_url, content] as const;
    }),
  );
  const sections = offlineExtractLinks(
    rootHtml(directory, security),
    preset.section_selector!,
    meta.url,
  );
  const links: LinkItem[] = [];
  for (const section of sections) {
    const categoryPage = pages.get(section.url);
    if (!categoryPage) continue;
    for (const item of offlineExtractLinks(categoryPage, preset.category_selector!, section.url))
      links.push({ ...item, section: section.title });
  }
  if (!links.length) throw new Error("nav-links replay produced no links");
  const structured = new LinkList(links);
  return [structured.toMarkdown(), links];
}
async function runSample(
  directory: string,
  meta: Meta,
  preset: PresetConfig,
  security?: SecureSampleContext,
): Promise<void> {
  if (meta.mode !== preset.mode)
    throw new CorpusError(
      `meta.yaml mode '${meta.mode}' does not match registry mode '${preset.mode}' for preset '${preset.name}'`,
    );
  try {
    const [markdown, payload] = await replay(directory, meta, preset, security);
    if (meta.expect === "failure")
      throw new CorpusError(`expected failure '${meta.failure?.type}' but replay succeeded`);
    verifySuccess(directory, meta, markdown, payload, security);
  } catch (error) {
    if (error instanceof CorpusError) throw error;
    if (meta.expect !== "failure")
      throw new CorpusError(
        `unexpected exception during replay: ${error instanceof Error ? error.message : String(error)}`,
      );
    verifyFailure(meta, error);
  }
}
function assertSafeName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\ufffd") ||
    [...name].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new CorpusSecurityError("corpus contains an unsafe path name");
}

function validatePrivateCorpusTree(
  root: string,
  guards: readonly DirectoryGuard[] = [],
  enforceSampleAggregate = false,
): void {
  revalidateDirectoryGuards(guards);
  let totalBytes = 0;
  const walk = (directory: string): void => {
    const directoryInfo = lstatBigIntOrNull(directory);
    if (!directoryInfo) throw new CorpusSecurityError("corpus directory disappeared");
    requireDirectory(directory, directoryInfo, true);
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      throw new CorpusSecurityError(`cannot securely list corpus directory: ${directory}`);
    }
    for (const name of names) {
      assertSafeName(name);
      const path = join(directory, name);
      const info = lstatBigIntOrNull(path);
      if (!info || info.isSymbolicLink())
        throw new CorpusSecurityError("corpus contains a missing or symbolic-link entry");
      if (info.isDirectory()) {
        walk(path);
      } else {
        requirePrivateFile(path, info);
        if (info.size > BigInt(CORPUS_ARTIFACT_MAX_BYTES))
          throw new CorpusSecurityError(
            `corpus file exceeds ${CORPUS_ARTIFACT_MAX_BYTES}-byte limit: ${path}`,
          );
        if (enforceSampleAggregate) {
          totalBytes += Number(info.size);
          if (totalBytes > CORPUS_AGGREGATE_MAX_BYTES)
            throw new CorpusSecurityError(
              `corpus sample exceeds ${CORPUS_AGGREGATE_MAX_BYTES}-byte aggregate limit`,
            );
        }
      }
    }
  };
  walk(root);
  revalidateDirectoryGuards(guards);
}

function readDirectorySecurely(path: string, guards: readonly DirectoryGuard[]): string[] {
  revalidateDirectoryGuards(guards);
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch {
    throw new CorpusSecurityError(`cannot securely list corpus directory: ${path}`);
  }
  revalidateDirectoryGuards(guards);
  for (const name of names) assertSafeName(name);
  return names;
}

function openChildGuard(parentGuards: readonly DirectoryGuard[], path: string): DirectoryGuard {
  revalidateDirectoryGuards(parentGuards);
  const guard = openDirectoryGuard(path, true);
  try {
    revalidateDirectoryGuards([...parentGuards, guard]);
    return guard;
  } catch (error) {
    closeDirectoryGuards([guard]);
    throw error;
  }
}

function ensureCaptureDirectoryGuards(dataHome: string, presetName: string): DirectoryGuard[] {
  assertSafeName(presetName);
  const corpus = join(dataHome, "corpus");
  const preset = join(corpus, presetName);
  const prefixes = absolutePathPrefixes(preset);
  const guards: DirectoryGuard[] = [];
  let creating = false;
  try {
    for (const prefix of prefixes) {
      revalidateDirectoryGuards(guards);
      let info = lstatBigIntOrNull(prefix);
      if (!info) {
        const parent = guards.at(-1);
        if (
          !parent ||
          parent.identity.uid !== currentUid() ||
          (parent.identity.mode & 0o022n) !== 0n
        )
          throw new CorpusSecurityError(
            "configured data-home parent is foreign, writable, or ambiguous",
          );
        creating = true;
        try {
          mkdirSync(prefix, { mode: 0o700 });
        } catch {
          throw new CorpusSecurityError("configured corpus ancestry changed while creating it");
        }
        info = lstatBigIntOrNull(prefix);
        if (!info) throw new CorpusSecurityError("created corpus directory disappeared");
      }
      const managed = creating || prefix === dataHome || prefix.startsWith(`${dataHome}${sep}`);
      requireDirectory(prefix, info, managed);
      guards.push(openDirectoryGuard(prefix, managed));
    }
    revalidateDirectoryGuards(guards);
    return guards;
  } catch (error) {
    closeDirectoryGuards(guards);
    throw error;
  }
}

let overlaySampleGuardHook: ((directory: string) => void) | undefined;

/** @internal Test-only hook at the retained overlay sample guard boundary. */
export function __setCorpusOverlaySampleGuardHookForTest(hook?: (directory: string) => void): void {
  overlaySampleGuardHook = hook;
}

async function runCorpusRoot(
  root: string,
  labelPrefix: string,
  presetFilter: string | null | undefined,
  registry: ReturnType<typeof loadRegistry>,
  result: { passed: number; failed: number; lines: string[] },
  baseGuards?: readonly DirectoryGuard[],
): Promise<void> {
  const presetNames = baseGuards
    ? readDirectorySecurely(root, baseGuards)
    : readdirSync(root).sort();
  for (const presetName of presetNames) {
    if (presetFilter && presetName !== presetFilter) continue;
    const presetDirectory = join(root, presetName);
    const presetGuard = baseGuards ? openChildGuard(baseGuards, presetDirectory) : undefined;
    const presetGuards = presetGuard ? [...baseGuards!, presetGuard] : undefined;
    try {
      const sampleNames = (
        presetGuards
          ? readDirectorySecurely(presetDirectory, presetGuards)
          : readdirSync(presetDirectory)
      )
        .filter((name) => name.startsWith("sample-"))
        .sort();
      for (const sample of sampleNames) {
        const label = `${labelPrefix}${presetName}/${sample}`;
        const directory = join(presetDirectory, sample);
        const sampleGuard = presetGuards ? openChildGuard(presetGuards, directory) : undefined;
        const sampleGuards = sampleGuard ? [...presetGuards!, sampleGuard] : undefined;
        try {
          if (sampleGuards) {
            overlaySampleGuardHook?.(directory);
            revalidateDirectoryGuards(sampleGuards);
            validatePrivateCorpusTree(directory, sampleGuards, true);
          }
          try {
            const security = sampleGuards
              ? {
                  sampleRoot: directory,
                  guards: sampleGuards,
                  budget: {
                    totalBytes: 0,
                    files: new Map<string, Pick<BigIntStats, "dev" | "ino" | "size">>(),
                  },
                }
              : undefined;
            const meta = loadMeta(directory, security);
            const preset = registry.byName(meta.preset);
            if (!preset) throw new CorpusError(`preset '${meta.preset}' not found in registry`);
            if (preset.name !== presetName)
              throw new CorpusError(
                `meta.yaml preset '${meta.preset}' does not match directory preset '${presetName}'`,
              );
            await runSample(directory, meta, preset, security);
            result.passed += 1;
            result.lines.push(`  PASS: ${label}`);
          } catch (error) {
            if (error instanceof CorpusSecurityError) throw error;
            result.failed += 1;
            result.lines.push(
              redactDiagnostic(
                `  FAIL: ${label}: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
          if (sampleGuards) revalidateDirectoryGuards(sampleGuards);
        } finally {
          if (sampleGuard) closeDirectoryGuards([sampleGuard]);
        }
      }
      if (presetGuards) revalidateDirectoryGuards(presetGuards);
    } finally {
      if (presetGuard) closeDirectoryGuards([presetGuard]);
    }
  }
  if (baseGuards) revalidateDirectoryGuards(baseGuards);
}

function overlayAliasesShipped(overlay: string): boolean {
  const overlayInfo = lstatBigIntOrNull(overlay);
  const shippedInfo = lstatBigIntOrNull(ROOT);
  return (
    (!!overlayInfo &&
      !!shippedInfo &&
      overlayInfo.dev === shippedInfo.dev &&
      overlayInfo.ino === shippedInfo.ino) ||
    realpathSync(overlay) === realpathSync(ROOT)
  );
}

export async function testCorpus(
  presetFilter?: string | null,
  root?: string,
): Promise<{ passed: number; failed: number; lines: string[] }> {
  const registry = loadRegistry();
  const result = { passed: 0, failed: 0, lines: [] as string[] };
  if (root !== undefined) {
    if (!existsSync(root)) throw new CorpusError("No corpus directory found.");
    await runCorpusRoot(root, "", presetFilter, registry, result);
    return result;
  }

  // The shipped corpus remains trusted package data with its pre-overlay read semantics.
  if (!existsSync(ROOT)) throw new CorpusError("No corpus directory found.");
  await runCorpusRoot(ROOT, "", presetFilter, registry, result);

  const dataHome = resolveDataHome();
  const overlay = join(dataHome, "corpus");
  if (!lstatBigIntOrNull(overlay)) return result;

  const baseGuards = openAncestryGuards(overlay, new Set([dataHome, overlay]));
  try {
    if (overlayAliasesShipped(overlay))
      throw new CorpusSecurityError("configured corpus overlay aliases the shipped corpus");
    validatePrivateCorpusTree(overlay, baseGuards);
    await runCorpusRoot(overlay, "captured/", presetFilter, registry, result, baseGuards);
    validatePrivateCorpusTree(overlay, baseGuards);
    revalidateDirectoryGuards(baseGuards);
  } finally {
    closeDirectoryGuards(baseGuards);
  }
  return result;
}
function nextSample(directory: string): string {
  const count = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith("sample-")).length
    : 0;
  return join(directory, `sample-${String(count + 1).padStart(3, "0")}`);
}
function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function prepareSampleArtifacts(files: Record<string, string>): PreparedTextArtifact[] {
  const entries = Object.entries(files);
  for (const [name] of entries) assertSafeName(name);
  return preflightTextArtifacts(
    entries.map(([name, content]) => ({ path: name, content })),
    {
      perArtifactBytes: CORPUS_ARTIFACT_MAX_BYTES,
      aggregateBytes: CORPUS_AGGREGATE_MAX_BYTES,
    },
  );
}

function atomicPreparedSample(
  directory: string,
  prepared: readonly PreparedTextArtifact[],
): string {
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, ".capture-tmp-"));
  try {
    chmodSync(temporary, 0o700);
    writePreparedTextArtifacts(
      prepared.map((artifact) => ({
        path: join(temporary, artifact.path),
        bytes: artifact.bytes,
      })),
    );
    fsyncDirectory(temporary);
    const final = nextSample(directory);
    renameSync(temporary, final);
    fsyncDirectory(directory);
    return final;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function atomicSample(directory: string, files: Record<string, string>): string {
  return atomicPreparedSample(directory, prepareSampleArtifacts(files));
}
function guardedAtomicSample(
  directory: string,
  prepared: readonly PreparedTextArtifact[],
  directoryGuards: readonly DirectoryGuard[],
): string {
  revalidateDirectoryGuards(directoryGuards);
  const temporary = mkdtempSync(join(directory, ".capture-tmp-"));
  let temporaryGuard: DirectoryGuard | undefined;
  let published = false;
  try {
    revalidateDirectoryGuards(directoryGuards);
    temporaryGuard = openChildGuard(directoryGuards, temporary);
    const guards = [...directoryGuards, temporaryGuard];
    for (const artifact of prepared) {
      revalidateDirectoryGuards(guards);
      writePreparedTextArtifacts([
        {
          path: join(temporary, artifact.path),
          bytes: artifact.bytes,
        },
      ]);
      revalidateDirectoryGuards(guards);
    }
    validatePrivateCorpusTree(temporary, guards);
    fsyncSync(temporaryGuard.descriptor);
    revalidateDirectoryGuards(guards);

    const sampleNames = readDirectorySecurely(directory, directoryGuards).filter((name) =>
      name.startsWith("sample-"),
    );
    const final = join(directory, `sample-${String(sampleNames.length + 1).padStart(3, "0")}`);
    if (lstatBigIntOrNull(final))
      throw new CorpusSecurityError("next corpus sample path is already occupied");
    revalidateDirectoryGuards(guards);
    renameSync(temporary, final);
    published = true;
    temporaryGuard.path = final;
    revalidateDirectoryGuards(guards);
    fsyncSync(directoryGuards.at(-1)!.descriptor);
    revalidateDirectoryGuards(guards);
    validatePrivateCorpusTree(final, guards);
    return final;
  } finally {
    if (temporaryGuard) {
      if (!published) {
        try {
          const guards = [...directoryGuards, temporaryGuard];
          revalidateDirectoryGuards(guards);
          validatePrivateCorpusTree(temporary, guards);
          rmSync(temporary, { recursive: true });
        } catch {
          // Never remove a temporary pathname unless its retained private identity is provable.
        }
      }
      closeDirectoryGuards([temporaryGuard]);
    }
  }
}

function publishCapturedSample(
  presetName: string,
  files: Record<string, string>,
  explicitRoot?: string,
): string {
  // Encode and cap every retained byte before opening or creating configured data-home ancestry.
  const prepared = prepareSampleArtifacts(files);
  if (explicitRoot !== undefined)
    return atomicPreparedSample(join(explicitRoot, presetName), prepared);

  assertSafeName(presetName);
  if (presetName.includes(sep))
    throw new CorpusSecurityError("capture preset name cannot contain a platform separator");
  const dataHome = resolveDataHome();
  const directory = join(dataHome, "corpus", presetName);
  const guards = ensureCaptureDirectoryGuards(dataHome, presetName);
  try {
    return guardedAtomicSample(directory, prepared, guards);
  } finally {
    closeDirectoryGuards(guards);
  }
}

/** @internal Test-only entrypoint for capture publication after browser/result preparation. */
export function __publishCapturedSampleForTest(
  presetName: string,
  files: Record<string, string>,
  explicitRoot?: string,
): string {
  return publishCapturedSample(presetName, files, explicitRoot);
}

export async function captureCorpus(
  url: string,
  options: {
    preset?: string | null | undefined;
    expectFailure?: string | null | undefined;
    root?: string | undefined;
    signal?: AbortSignal | undefined;
    allowPrivateNetwork?: boolean | undefined;
  } = {},
): Promise<string> {
  let requested: string;
  try {
    requested = validateRequestUrl(url);
  } catch (error) {
    if (error instanceof EnvelopeBuildError && error.failureClass === "invalid_request")
      throw sanitizeErrorInPlace(new AgentscrapeUsageError(error.message));
    throw sanitizeErrorInPlace(error);
  }
  return withBrowserNetworkPolicy(options.allowPrivateNetwork, async () => {
    if (options.expectFailure && !FAILURE_TYPES[options.expectFailure])
      throw new Error(
        `unknown --expect-failure type '${options.expectFailure}'. Known types: ${Object.keys(FAILURE_TYPES).sort().join(", ")}`,
      );
    const registry = loadRegistry();
    const preset = options.preset
      ? registry.byName(options.preset)
      : matchPreset(requested, registry.presets);
    if (!preset)
      throw new Error(
        options.preset
          ? `preset '${options.preset}' not found`
          : "no matching preset found. Use --preset to specify one.",
      );
    if (preset.mode !== "content")
      throw new Error(
        `capture-corpus only supports content mode (preset '${preset.name}' is ${preset.mode})`,
      );
    const session = `agentscrape-capture-${process.pid}`;
    let result: ScrapeResult | undefined;
    let outcome: unknown = null;
    let rendered = "";
    try {
      throwIfAborted(options.signal);
      result = await scrapeWithPreset(requested, preset, { session, signal: options.signal });
    } catch (error) {
      if (error instanceof AgentscrapeNetworkPolicyError) throw error;
      outcome = error;
    } finally {
      if (currentBrowserNetworkPolicy()) {
        try {
          const html = await runAgentBrowser(
            ["eval", "document.documentElement.outerHTML"],
            session,
            undefined,
            undefined,
            options.signal,
          );
          if (html.exitCode === 0 && !html.truncated) rendered = html.stdout;
        } catch {
          /* best effort */
        }
        await closeSessionBestEffort(session);
      }
    }
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (outcome) {
      if (!options.expectFailure) throw outcome;
      const meta: Meta = {
        version: 1,
        preset: preset.name,
        mode: preset.mode,
        url: redactUrl(requested),
        expect: "failure",
        failure: {
          type: options.expectFailure,
          message_captured: redactDiagnostic(
            outcome instanceof Error ? outcome.message : String(outcome),
          ),
        },
      };
      verifyFailure(meta, outcome);
      return publishCapturedSample(
        preset.name,
        {
          "meta.yaml": stringifyYaml(meta),
          ...(rendered ? { "page.html": rendered } : {}),
        },
        options.root,
      );
    }
    if (options.expectFailure)
      throw new Error(`expected failure type '${options.expectFailure}' but the scrape succeeded`);
    if (!result) throw new Error("scrape returned no result");
    const meta: Meta = {
      version: 1,
      preset: preset.name,
      mode: preset.mode,
      url: redactUrl(requested),
      expect: "success",
      structured: plain(result.structured),
    };
    return publishCapturedSample(
      preset.name,
      {
        "meta.yaml": stringifyYaml(meta),
        ...(result.full_html ? { "page.html": result.full_html } : {}),
        ...(result.selected_html ? { "selected.html": result.selected_html } : {}),
        ...(result.markdown ? { "expected.md": result.markdown } : {}),
      },
      options.root,
    );
  });
}
export { CorpusError, CorpusSecurityError, loadMeta, runSample };

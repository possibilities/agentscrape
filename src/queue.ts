import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fetchMarkdown, resetBrowserUnavailableCache } from "./api";
import { AgentscrapeUpstreamDownError, cancellationError, throwIfAborted } from "./errors";
import { resolveQueuePaths } from "./queue-paths";
import { isSensitiveName, JWT_RE } from "./redaction";
import { runProcess } from "./subprocess";

export { resolveDataHome } from "./queue-paths";

const queuePaths = resolveQueuePaths();
export const DATA_HOME = queuePaths.dataHome;
export const QUEUE_DIR = queuePaths.queue;
export const FAILED_DIR = queuePaths.failed;
export const RECONCILIATION_DIR = queuePaths.reconciliation;
const JOB_FIELDS = new Set(["url", "destination", "summarize", "frontmatter"]);
const RECORD_FIELDS = new Set([...JOB_FIELDS, "indexer", "source"]);
const FROZEN_LABELS = new Set(["agentbrain", "research-cache"]);
const MAX_RECORD_BYTES = 256_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 500;
const JOB_STATES = new Set([
  "queued",
  "running",
  "retry_wait",
  "blocked",
  "failed",
  "completed",
  "excluded",
  "cancelled",
]);

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncWithImmediateRetry(operation: () => void, context: string): void {
  try {
    operation();
  } catch (first) {
    try {
      operation();
    } catch (second) {
      throw secondaryFailure(first, second, context);
    }
  }
}
function syncRegularFileAndParent(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw new Error(`final destination is not a stable regular file: ${path}`);
    fsyncSync(descriptor);
    const current = lstatSync(path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error(`final destination changed while synchronizing: ${path}`);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}
function currentUid(): number {
  const getuid = process.getuid;
  if (!getuid) throw new Error("queue ownership checks require a POSIX runtime");
  return getuid.call(process);
}
function assertContained(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw new Error("reconciliation path escapes its private root");
}
function privateDirectory(path: string): void {
  assertContained(RECONCILIATION_DIR, path);
  const rootExisted = existsSync(RECONCILIATION_DIR);
  mkdirSync(RECONCILIATION_DIR, { recursive: true, mode: 0o700 });
  if (!rootExisted) fsyncDirectory(dirname(RECONCILIATION_DIR));
  let current = RECONCILIATION_DIR;
  const rel = relative(RECONCILIATION_DIR, path);
  for (const part of ["", ...(rel ? rel.split(sep) : [])]) {
    if (part) {
      const parent = current;
      current = join(current, part);
      if (!existsSync(current)) {
        mkdirSync(current, { mode: 0o700 });
        fsyncDirectory(parent);
      }
    }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid())
      throw new Error("reconciliation directories must be owned real mode-0700 directories");
    if ((info.mode & 0o777) !== 0o700) {
      chmodSync(current, 0o700);
      fsyncDirectory(dirname(current));
    }
  }
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
interface SourceIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}
interface SourceSnapshot {
  raw: Buffer;
  identity: SourceIdentity;
}
function sourceIdentity(info: ReturnType<typeof fstatSync>, raw: Uint8Array): SourceIdentity {
  const value = info as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
    sha256: digest(raw),
  };
}
function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof SourceIdentity] === right[key as keyof SourceIdentity],
  );
}
function captureSource(path: string): SourceSnapshot | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error) ?? "")) return null;
    throw error;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) return null;
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (
      !pathname.isFile() ||
      pathname.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== pathname.dev ||
      after.ino !== pathname.ino ||
      after.size !== pathname.size ||
      after.mtimeNs !== pathname.mtimeNs ||
      after.ctimeNs !== pathname.ctimeNs
    )
      return null;
    return { raw, identity: sourceIdentity(after, raw) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error) ?? "")) return null;
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

interface ClaimOwner {
  version: 1;
  pid: number;
  token: string;
  owner: string;
  operation: "process" | "reconcile";
  area: "pending" | "failed";
  name: string;
  reconciliation_root: { dev: string; ino: string };
  source: SourceIdentity;
}
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}
interface ClaimEvidence {
  value: ClaimOwner;
  bytes: Buffer;
  slotInfo: FileIdentity;
  ownerInfo: FileIdentity;
  ownerPath: string;
}
interface HeldClaim {
  value: ClaimOwner;
  bytes: Buffer;
  slotPath: string;
  ownerPath: string;
  snapshot: SourceSnapshot;
}
type ClaimResult =
  | { status: "claimed"; claim: HeldClaim }
  | { status: "busy" | "blocked" | "gone" };
const CLAIMS_DIR = join(RECONCILIATION_DIR, "claims");
const CLAIM_OWNERS_DIR = join(CLAIMS_DIR, "owners");
const CLAIM_SLOTS_DIR = join(CLAIMS_DIR, "slots");
const CLAIM_QUARANTINE_DIR = join(CLAIMS_DIR, "quarantine");
const RETIRE_QUARANTINE_DIR = join(RECONCILIATION_DIR, "retirement-quarantine");

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function strictPrivateFile(path: string): { info: FileIdentity; bytes: Buffer } | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const descriptorInfo = fstatSync(descriptor, { bigint: true });
    const pathnameInfo = lstatSync(path, { bigint: true });
    if (
      !descriptorInfo.isFile() ||
      !pathnameInfo.isFile() ||
      pathnameInfo.isSymbolicLink() ||
      descriptorInfo.dev !== pathnameInfo.dev ||
      descriptorInfo.ino !== pathnameInfo.ino ||
      descriptorInfo.uid !== BigInt(currentUid()) ||
      (descriptorInfo.mode & 0o777n) !== 0o600n ||
      descriptorInfo.size > 16_384n
    )
      return null;
    return {
      info: { dev: pathnameInfo.dev, ino: pathnameInfo.ino },
      bytes: readFileSync(descriptor),
    };
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}
function validOwner(value: unknown, expectedSlotName: string): value is ClaimOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, any>;
  const sourceKeys = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256"];
  return (
    Object.keys(owner).join(",") ===
      "version,pid,token,owner,operation,area,name,reconciliation_root,source" &&
    owner.version === 1 &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid >= 1 &&
    typeof owner.token === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.token) &&
    owner.owner === `${owner.token}.json` &&
    ["process", "reconcile"].includes(owner.operation) &&
    ["pending", "failed"].includes(owner.area) &&
    typeof owner.name === "string" &&
    owner.name.length > 0 &&
    owner.name.length <= 255 &&
    digest(`${owner.area}\0${owner.name}`) === expectedSlotName &&
    owner.reconciliation_root &&
    Object.keys(owner.reconciliation_root).join(",") === "dev,ino" &&
    [owner.reconciliation_root.dev, owner.reconciliation_root.ino].every(
      (item) => typeof item === "string" && /^\d+$/.test(item),
    ) &&
    owner.source &&
    Object.keys(owner.source).join(",") === sourceKeys.join(",") &&
    sourceKeys.every(
      (key) =>
        typeof owner.source[key] === "string" &&
        (key === "sha256"
          ? /^[0-9a-f]{64}$/.test(owner.source[key])
          : /^\d+$/.test(owner.source[key])),
    )
  );
}
function inspectClaim(slotPath: string, slotName: string): ClaimEvidence | null {
  const slot = strictPrivateFile(slotPath);
  if (!slot) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot.bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !validOwner(parsed, slotName) ||
    `${JSON.stringify(parsed)}\n` !== slot.bytes.toString("utf8")
  )
    return null;
  const value = parsed;
  const root = lstatSync(RECONCILIATION_DIR, { bigint: true });
  if (
    value.reconciliation_root.dev !== String(root.dev) ||
    value.reconciliation_root.ino !== String(root.ino)
  )
    return null;
  const ownerPath = join(CLAIM_OWNERS_DIR, value.owner);
  const owner = strictPrivateFile(ownerPath);
  if (!owner) return null;
  if (
    owner.bytes.compare(slot.bytes) !== 0 ||
    owner.info.dev !== slot.info.dev ||
    owner.info.ino !== slot.info.ino
  )
    return null;
  return {
    value,
    bytes: slot.bytes,
    slotInfo: { dev: slot.info.dev, ino: slot.info.ino },
    ownerInfo: { dev: owner.info.dev, ino: owner.info.ino },
    ownerPath,
  };
}
function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}
function removeExactFile(path: string, identity: FileIdentity): boolean {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, identity)) return false;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return true;
  } catch {
    return false;
  }
}
function boundedErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}
function secondaryFailure(primary: unknown, secondary: unknown, context: string): AggregateError {
  return new AggregateError(
    [primary, secondary],
    `${context}: ${boundedErrorText(primary)}; secondary failure: ${boundedErrorText(secondary)}`,
    { cause: primary },
  );
}
function unlinkExactClaimFile(path: string, identity: FileIdentity, description: string): void {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${description} could not be inspected`, { cause: error });
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, identity))
    throw new Error(`${description} ownership changed`);
  try {
    unlinkSync(path);
  } catch (error) {
    throw new Error(`${description} could not be removed`, { cause: error });
  }
  try {
    fsyncDirectory(dirname(path));
  } catch (error) {
    throw new Error(`${description} removal could not be synchronized`, { cause: error });
  }
}
function restoreQuarantined(path: string, slotPath: string): void {
  try {
    linkSync(path, slotPath);
    fsyncDirectory(dirname(slotPath));
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch {
    // A competing fixed slot wins. Keep the quarantined evidence rather than replace it.
  }
}
function releaseClaim(claim: HeldClaim): void {
  const slotName = basename(claim.slotPath);
  const observed = inspectClaim(claim.slotPath, slotName);
  if (
    !observed ||
    observed.value.token !== claim.value.token ||
    observed.bytes.compare(claim.bytes) !== 0 ||
    observed.ownerPath !== claim.ownerPath
  )
    throw new Error(`claim release ownership mismatch for ${claim.value.name}`);

  // The owner is the durable backstop for a slot unlink that a crash could undo. Do not remove
  // it until the slot directory confirms that the fixed arbitration name is durably absent.
  unlinkExactClaimFile(claim.slotPath, observed.slotInfo, `claim slot for ${claim.value.name}`);
  unlinkExactClaimFile(claim.ownerPath, observed.ownerInfo, `claim owner for ${claim.value.name}`);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function releaseClaimWithSecondary(claim: HeldClaim, primary: unknown): void {
  try {
    releaseClaim(claim);
  } catch (secondary) {
    throw secondaryFailure(primary, secondary, "claim release also failed");
  }
}
function releaseClaimPreserving(claim: HeldClaim, primary: unknown): never {
  releaseClaimWithSecondary(claim, primary);
  throw primary;
}
function sourceStillClaimed(path: string, claim: HeldClaim): boolean {
  const current = captureSource(path);
  return current !== null && sameIdentity(current.identity, claim.snapshot.identity);
}
function acquireClaim(
  operation: ClaimOwner["operation"],
  area: ClaimOwner["area"],
  name: string,
  path: string,
  expectedSha256?: string,
): ClaimResult {
  privateDirectory(CLAIM_OWNERS_DIR);
  privateDirectory(CLAIM_SLOTS_DIR);
  privateDirectory(CLAIM_QUARANTINE_DIR);
  const snapshot = captureSource(path);
  if (!snapshot || (expectedSha256 && snapshot.identity.sha256 !== expectedSha256))
    return { status: "gone" };
  const token = randomUUID();
  const owner = `${token}.json`;
  const ownerPath = join(CLAIM_OWNERS_DIR, owner);
  const slotName = digest(`${area}\0${name}`);
  const slotPath = join(CLAIM_SLOTS_DIR, slotName);
  const root = lstatSync(RECONCILIATION_DIR, { bigint: true });
  const value: ClaimOwner = {
    version: 1,
    pid: process.pid,
    token,
    owner,
    operation,
    area,
    name,
    reconciliation_root: { dev: String(root.dev), ino: String(root.ino) },
    source: snapshot.identity,
  };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const descriptor = openSync(ownerPath, "wx", 0o600);
  const created = fstatSync(descriptor, { bigint: true });
  const ownerInfo = { dev: created.dev, ino: created.ino };
  let ownerComplete = false;
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    ownerComplete = true;
  } finally {
    closeSync(descriptor);
    if (!ownerComplete) removeExactFile(ownerPath, ownerInfo);
  }
  try {
    fsyncDirectory(CLAIM_OWNERS_DIR);
  } catch (error) {
    removeExactFile(ownerPath, ownerInfo);
    throw error;
  }
  const staleOwners: ClaimEvidence[] = [];
  for (;;) {
    let publishedClaim: HeldClaim | null = null;
    try {
      linkSync(ownerPath, slotPath);
      publishedClaim = { value, bytes, slotPath, ownerPath, snapshot };
      fsyncDirectory(CLAIM_SLOTS_DIR);
      const published = inspectClaim(slotPath, slotName);
      if (
        !published ||
        published.value.token !== token ||
        published.bytes.compare(bytes) !== 0 ||
        published.ownerPath !== ownerPath
      )
        throw new Error(`published claim validation failed for ${name}`);
      if (!sourceStillClaimed(path, publishedClaim)) {
        releaseClaim(publishedClaim);
        return { status: "gone" };
      }
      for (const stale of staleOwners) {
        if (processIsDead(stale.value.pid)) removeExactFile(stale.ownerPath, stale.ownerInfo);
      }
      return { status: "claimed", claim: publishedClaim };
    } catch (error) {
      if (publishedClaim) releaseClaimPreserving(publishedClaim, error);
      if (errorCode(error) !== "EEXIST") {
        removeExactFile(ownerPath, ownerInfo);
        throw error;
      }
    }
    const observed = inspectClaim(slotPath, slotName);
    if (!observed) {
      removeExactFile(ownerPath, ownerInfo);
      return { status: "blocked" };
    }
    if (!processIsDead(observed.value.pid)) {
      removeExactFile(ownerPath, ownerInfo);
      return { status: "busy" };
    }
    const quarantine = join(CLAIM_QUARANTINE_DIR, `${slotName}.${randomUUID()}.stale`);
    try {
      renameSync(slotPath, quarantine);
      fsyncDirectory(CLAIM_SLOTS_DIR);
      fsyncDirectory(CLAIM_QUARANTINE_DIR);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      removeExactFile(ownerPath, ownerInfo);
      throw error;
    }
    const moved = strictPrivateFile(quarantine);
    if (
      !moved ||
      moved.info.dev !== observed.slotInfo.dev ||
      moved.info.ino !== observed.slotInfo.ino ||
      moved.bytes.compare(observed.bytes) !== 0
    ) {
      restoreQuarantined(quarantine, slotPath);
      continue;
    }
    removeExactFile(quarantine, { dev: moved.info.dev, ino: moved.info.ino });
    staleOwners.push(observed);
  }
}
function retireClaimedSource(path: string, claim: HeldClaim): boolean {
  privateDirectory(RETIRE_QUARANTINE_DIR);
  if (!sourceStillClaimed(path, claim)) return false;
  const quarantine = join(
    RETIRE_QUARANTINE_DIR,
    `${claim.value.area}-${digest(claim.value.name).slice(0, 16)}-${randomUUID()}`,
  );
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  // Persist the rename's target entry before the source entry's removal. A crash must not
  // durably lose both names after the public source moves into private quarantine.
  fsyncDirectory(RETIRE_QUARANTINE_DIR);
  fsyncDirectory(dirname(path));
  const moved = lstatSync(quarantine, { bigint: true });
  if (
    !moved.isFile() ||
    moved.isSymbolicLink() ||
    String(moved.dev) !== claim.snapshot.identity.dev ||
    String(moved.ino) !== claim.snapshot.identity.ino
  ) {
    // The pathname changed in the narrow conditional rename gap. Preserve that evidence privately.
    return false;
  }
  const movedSnapshot = captureSource(quarantine);
  const expected = claim.snapshot.identity;
  const actual = movedSnapshot?.identity;
  // rename(2) changes ctime on macOS. The nofollow snapshot above proves the moved inode is
  // stable, so compare the durable content identity and intentionally ignore original ctime.
  if (
    !actual ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.sha256 !== expected.sha256
  )
    return false;
  const quarantineInfo = lstatSync(quarantine, { bigint: true });
  if (
    !quarantineInfo.isFile() ||
    quarantineInfo.isSymbolicLink() ||
    String(quarantineInfo.dev) !== actual.dev ||
    String(quarantineInfo.ino) !== actual.ino ||
    String(quarantineInfo.size) !== actual.size ||
    String(quarantineInfo.mtimeNs) !== actual.mtimeNs ||
    String(quarantineInfo.ctimeNs) !== actual.ctimeNs
  )
    return false;
  unlinkSync(quarantine);
  fsyncDirectory(RETIRE_QUARANTINE_DIR);
  return true;
}
function publishBytesNoClobber(directory: string, destination: string, raw: Uint8Array): void {
  const temporary = join(directory, `.agentscrape-publish-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, raw);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporary, destination);
    unlinkSync(temporary);
    temporaryExists = false;
    syncWithImmediateRetry(
      () => fsyncDirectory(directory),
      `publication sync failed for ${basename(destination)}`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) {
      unlinkSync(temporary);
      fsyncDirectory(directory);
    }
  }
}
function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > maximumBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}
function failedCollisionName(stem: string, extension: string, unique: string): string {
  const suffix = `--failed-${unique}${extension}`;
  return `${truncateUtf8(stem, 255 - Buffer.byteLength(suffix))}${suffix}`;
}
function publishFailed(name: string, claim: HeldClaim): void {
  const raw = claim.snapshot.raw;
  const extension = name.endsWith(".yaml") ? ".yaml" : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const identity = `${claim.snapshot.identity.sha256.slice(0, 12)}-${claim.value.token.slice(0, 8)}`;
  for (let attempt = 0; ; attempt += 1) {
    const candidate =
      attempt === 0
        ? name
        : failedCollisionName(
            stem,
            extension,
            attempt === 1 ? identity : `${identity}-${randomUUID().slice(0, 8)}`,
          );
    try {
      publishBytesNoClobber(FAILED_DIR, join(FAILED_DIR, candidate), raw);
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

function envDelay(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0.1 && value <= 3600 ? value : fallback;
}
export function retryDelay(attempt: number, initial = 1, maximum = 60): number {
  return Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
}
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text : text.slice(end + 4).replace(/^\n+/, "");
}
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
}
function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function publicDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${path} must be a real directory`);
  if (!existed) fsyncDirectory(dirname(path));
}
export async function processQueue(options: { signal?: AbortSignal } = {}): Promise<{
  processed: number;
  failed: number;
  frozen: number;
}> {
  publicDirectory(QUEUE_DIR);
  publicDirectory(FAILED_DIR);
  let processed = 0;
  let failed = 0;
  let frozen = 0;
  const names = readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    throwIfAborted(options.signal);
    const path = join(QUEUE_DIR, name);
    const result = acquireClaim("process", "pending", name, path);
    if (result.status === "blocked") throw new Error(`claim evidence blocks queue record: ${name}`);
    if (result.status !== "claimed") continue;
    const { claim } = result;
    let operationError: unknown;
    let operationFailed = false;
    try {
      throwIfAborted(options.signal);
      let job: Record<string, unknown>;
      try {
        const parsed = parseYaml(claim.snapshot.raw.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("job must be a mapping");
        job = parsed as Record<string, unknown>;
      } catch {
        publishFailed(name, claim);
        retireClaimedSource(path, claim);
        failed += 1;
        continue;
      }
      if ("indexer" in job) {
        frozen += 1;
        continue;
      }
      if (
        Object.keys(job).some((key) => !JOB_FIELDS.has(key)) ||
        !validUrl(job.url) ||
        typeof job.destination !== "string" ||
        !job.destination.trim() ||
        job.destination.length > 4096 ||
        ("summarize" in job && typeof job.summarize !== "boolean") ||
        ("frontmatter" in job &&
          (!job.frontmatter ||
            typeof job.frontmatter !== "object" ||
            Array.isArray(job.frontmatter)))
      ) {
        publishFailed(name, claim);
        retireClaimedSource(path, claim);
        failed += 1;
        continue;
      }
      try {
        const destination = expandHome(job.destination);
        const initial = envDelay("AGENTSCRAPE_PROCESS_QUEUE_RETRY_INITIAL_DELAY_SECONDS", 1);
        const maximum = Math.max(
          initial,
          envDelay("AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_DELAY_SECONDS", 60),
        );
        let attempt = 1;
        while (true) {
          resetBrowserUnavailableCache();
          try {
            await fetchMarkdown(job.url, { destination, signal: options.signal });
            break;
          } catch (error) {
            if (!(error instanceof AgentscrapeUpstreamDownError)) throw error;
            await sleep(retryDelay(attempt++, initial, maximum) * 1000, options.signal);
          }
        }
        const frontmatter = { ...(job.frontmatter as Record<string, unknown> | undefined) };
        if (job.summarize) {
          const body = stripFrontmatter(readFileSync(destination, "utf8"));
          const summaryResult = await runProcess(["summaryctl", "short-summary"], {
            timeoutMs: 120_000,
            maxOutputBytes: 64_000,
            stdin: body,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          const summary = summaryResult.stdout.trim();
          if (summaryResult.exitCode !== 0 || !summary) throw new Error("summary command failed");
          frontmatter.summary = summary;
        }
        if (Object.keys(frontmatter).length) {
          const body = stripFrontmatter(readFileSync(destination, "utf8"));
          writeFileSync(
            destination,
            `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`,
          );
        }
        syncRegularFileAndParent(destination);
        retireClaimedSource(path, claim);
        processed += 1;
      } catch {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        publishFailed(name, claim);
        retireClaimedSource(path, claim);
        failed += 1;
      }
    } catch (error) {
      operationError = error;
      operationFailed = true;
    } finally {
      if (operationFailed) releaseClaimPreserving(claim, operationError);
      releaseClaim(claim);
    }
  }
  return { processed, failed, frozen };
}

interface RecordInfo {
  area: "pending" | "failed";
  path: string;
  filename: string;
  sha256: string;
  byte_size: number;
  record_id: string;
  classification: string;
  planned_outcome: "import" | "unsupported" | "excluded";
  reason: string;
  evidence: Record<string, unknown> | null;
  ingress: string | null;
}
function unsupported(
  area: RecordInfo["area"],
  path: string,
  raw: Uint8Array,
  reason: string,
): RecordInfo {
  return {
    area,
    path,
    filename: basename(path),
    sha256: digest(raw),
    byte_size: raw.byteLength,
    record_id: digest(
      Buffer.concat([Buffer.from(`${area}\0${basename(path)}\0`), Buffer.from(raw)]),
    ),
    classification: "unsupported",
    planned_outcome: "unsupported",
    reason,
    evidence: null,
    ingress: null,
  };
}
function redact(value: unknown, name = "", depth = 0): unknown {
  if (depth > 6) throw new Error("frontmatter_too_deep");
  if (name && isSensitiveName(name)) return "[REDACTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("frontmatter_invalid_number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 1000) throw new Error("frontmatter_too_large");
    return value
      .replace(JWT_RE, "$1[REDACTED]$2")
      .replace(
        /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
        "[REDACTED]",
      );
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new Error("frontmatter_too_large");
    return value.map((item) => redact(item, "", depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 50) throw new Error("frontmatter_too_large");
    return Object.fromEntries(
      entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, redact(item, key, depth + 1)]),
    );
  }
  throw new Error("frontmatter_unsupported_value");
}
function normalizeLegacyYaml(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLegacyYaml);
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== "string") throw new Error("frontmatter_invalid_mapping");
      result[key] = normalizeLegacyYaml(item);
    }
    return result;
  }
  return value;
}
function classify(area: RecordInfo["area"], path: string, raw: Uint8Array): RecordInfo {
  const fail = (reason: string) => unsupported(area, path, raw, reason);
  if (raw.byteLength > MAX_RECORD_BYTES) return fail("record_too_large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return fail("invalid_utf8");
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { mapAsMap: true });
  } catch {
    return fail("malformed_yaml");
  }
  if (!(parsed instanceof Map)) return fail("record_not_mapping");
  if ([...parsed.keys()].some((key) => typeof key !== "string")) return fail("non_string_field");
  let value: unknown;
  try {
    value = normalizeLegacyYaml(parsed);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "frontmatter_invalid_mapping");
  }
  const job = value as Record<string, unknown>;
  if (Object.keys(job).some((key) => !RECORD_FIELDS.has(key))) return fail("unsupported_fields");
  if (!validUrl(job.url)) return fail("invalid_url");
  if (
    typeof job.destination !== "string" ||
    !job.destination.trim() ||
    job.destination.length > 4096
  )
    return fail("invalid_destination");
  if ("summarize" in job && typeof job.summarize !== "boolean") return fail("invalid_summarize");
  if (
    job.frontmatter !== undefined &&
    (!job.frontmatter || typeof job.frontmatter !== "object" || Array.isArray(job.frontmatter))
  )
    return fail("invalid_frontmatter");
  if (
    job.source !== undefined &&
    (typeof job.source !== "string" || !job.source.trim() || job.source.length > 100)
  )
    return fail("invalid_source");
  let frontmatter: unknown;
  try {
    frontmatter = redact(job.frontmatter ?? {});
  } catch (error) {
    return fail(error instanceof Error ? error.message : "unsafe_frontmatter");
  }
  const evidence = {
    url: job.url,
    destination: job.destination,
    frontmatter,
    source: typeof job.source === "string" ? job.source.trim() : null,
    summarize: job.summarize === true,
  };
  if (JSON.stringify(evidence).length > 4500) return fail("evidence_too_large");
  let classification = "scrape-only";
  let planned: RecordInfo["planned_outcome"] = "excluded";
  let reason = "standalone_scrape";
  let ingress: string | null = null;
  if (typeof job.indexer === "string" && FROZEN_LABELS.has(job.indexer)) {
    if (!evidence.source) return fail("indexed_record_missing_source");
    classification = `${job.indexer}-indexer`;
    planned = "import";
    reason = "frozen_indexer";
    ingress = evidence.source;
  } else if (job.indexer !== undefined) return fail("unsupported_indexer");
  else if (evidence.summarize && (frontmatter as Record<string, unknown>).url === job.url) {
    classification = "saved-link";
    planned = "import";
    reason = "saved_link_shape";
    ingress = evidence.source ?? "agentscrape-legacy";
  }
  if (ingress && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(ingress)) ingress = "agentscrape-legacy";
  return { ...fail(reason), classification, planned_outcome: planned, reason, evidence, ingress };
}
interface RecordCandidate {
  area: RecordInfo["area"];
  path: string;
  filename: string;
  sha256: string;
  raw: Buffer;
}
function recordCandidates(): RecordCandidate[] {
  const candidates: RecordCandidate[] = [];
  for (const [area, directory] of [
    ["pending", QUEUE_DIR],
    ["failed", FAILED_DIR],
  ] as const) {
    let entries: Dirent<string>[];
    try {
      const directoryInfo = lstatSync(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new Error(`queue ${area} path must be a real directory`);
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".yaml") || !entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const snapshot = captureSource(path);
      if (!snapshot) continue;
      candidates.push({
        area,
        path,
        filename: entry.name,
        sha256: snapshot.identity.sha256,
        raw: snapshot.raw,
      });
      if (candidates.length > 5000)
        throw new Error("queue inventory exceeds the 5000-record safety limit");
    }
  }
  return candidates.sort(
    (a, b) => a.filename.localeCompare(b.filename) || a.area.localeCompare(b.area),
  );
}
function outcomePath(record: RecordInfo): string {
  return join(RECONCILIATION_DIR, "outcomes", `${record.record_id}.json`);
}
function archiveRecord(record: RecordInfo): string {
  const prefix = `${record.record_id.slice(0, 16)}-`;
  const exactLeaf = `${prefix}${record.filename}`;
  if (Buffer.byteLength(exactLeaf) <= 255) return `archive/${record.area}/${exactLeaf}`;
  const extensionIndex = record.filename.lastIndexOf(".");
  const extension = extensionIndex > 0 ? record.filename.slice(extensionIndex) : "";
  const stem = extension ? record.filename.slice(0, extensionIndex) : record.filename;
  const suffix = `--${digest(record.filename).slice(0, 16)}${extension}`;
  const leaf = `${prefix}${truncateUtf8(
    stem,
    255 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
  )}${suffix}`;
  return `archive/${record.area}/${leaf}`;
}
function validReceipt(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  return (
    keys.every((key) => ["status", "job_id", "idempotency_key", "state"].includes(key)) &&
    keys.includes("status") &&
    keys.includes("job_id") &&
    keys.includes("idempotency_key") &&
    (receipt.status === "queued" || receipt.status === "duplicate") &&
    Number.isSafeInteger(receipt.job_id) &&
    Number(receipt.job_id) >= 1 &&
    typeof receipt.idempotency_key === "string" &&
    receipt.idempotency_key.length >= 1 &&
    receipt.idempotency_key.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    receipt.idempotency_key.trim() === receipt.idempotency_key &&
    (receipt.state === undefined ||
      (typeof receipt.state === "string" && JOB_STATES.has(receipt.state)))
  );
}
function privateParentsValid(path: string): boolean {
  const rel = relative(RECONCILIATION_DIR, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  let current = RECONCILIATION_DIR;
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== currentUid() ||
        (info.mode & 0o777) !== 0o700
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
interface OutcomeFileSnapshot {
  dev: bigint;
  ino: bigint;
  bytes: Buffer;
}
function readDescriptorBytes(descriptor: number, size: bigint): Buffer {
  if (size > 16_384n) throw new Error("reconciliation outcome exceeds its size limit");
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("reconciliation outcome changed while reading");
    offset += count;
  }
  return bytes;
}
function inspectOpenOutcome(
  path: string,
  descriptor: number,
  expected?: OutcomeFileSnapshot,
): OutcomeFileSnapshot {
  const opened = fstatSync(descriptor, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  if (
    !opened.isFile() ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    opened.uid !== BigInt(currentUid()) ||
    named.uid !== BigInt(currentUid()) ||
    (opened.mode & 0o777n) !== 0o600n ||
    (named.mode & 0o777n) !== 0o600n ||
    (expected !== undefined && (opened.dev !== expected.dev || opened.ino !== expected.ino))
  )
    throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
  const bytes = readDescriptorBytes(descriptor, opened.size);
  const after = fstatSync(descriptor, { bigint: true });
  const current = lstatSync(path, { bigint: true });
  if (
    !after.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    after.size !== opened.size ||
    after.uid !== opened.uid ||
    (after.mode & 0o777n) !== 0o600n ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.size !== opened.size ||
    current.uid !== BigInt(currentUid()) ||
    (current.mode & 0o777n) !== 0o600n ||
    (expected !== undefined && bytes.compare(expected.bytes) !== 0)
  )
    throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
  return { dev: opened.dev, ino: opened.ino, bytes };
}
function readOutcome(record: RecordInfo, synchronize = false): Record<string, unknown> | null {
  const path = outcomePath(record);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(`invalid reconciliation outcome: ${basename(path)}`, { cause: error });
  }
  try {
    if (!privateParentsValid(dirname(path)))
      throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
    const file = inspectOpenOutcome(path, descriptor);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`mismatched reconciliation outcome: ${basename(path)}`);
    const value = parsed as Record<string, any>;
    const receiptRequired = ["imported", "duplicate"].includes(value.outcome);
    const outcomeMatchesPlan =
      value.outcome === "drained" ||
      (record.planned_outcome === "import" && ["imported", "duplicate"].includes(value.outcome)) ||
      value.outcome === record.planned_outcome;
    const expectedEvidence = record.evidence ?? undefined;
    const expectedArchiveRecord = value.outcome === "excluded" ? null : archiveRecord(record);
    if (
      value.schema_version !== 1 ||
      value.record_id !== record.record_id ||
      !value.legacy_record ||
      typeof value.legacy_record !== "object" ||
      value.legacy_record.area !== record.area ||
      value.legacy_record.filename !== record.filename ||
      value.legacy_record.sha256 !== record.sha256 ||
      value.legacy_record.byte_size !== record.byte_size ||
      value.classification !== record.classification ||
      value.reason !== record.reason ||
      JSON.stringify(value.evidence) !== JSON.stringify(expectedEvidence) ||
      value.archive_record !== expectedArchiveRecord ||
      !outcomeMatchesPlan ||
      !["imported", "drained", "duplicate", "unsupported", "excluded"].includes(value.outcome) ||
      (receiptRequired && !validReceipt(value.agentbrain_receipt)) ||
      (!receiptRequired && value.agentbrain_receipt !== undefined)
    )
      throw new Error(`mismatched reconciliation outcome: ${basename(path)}`);
    const receipt = value.agentbrain_receipt as Record<string, unknown> | undefined;
    if (
      receipt &&
      ((value.outcome === "imported" && receipt.status !== "queued") ||
        (value.outcome === "duplicate" && receipt.status !== "duplicate"))
    )
      throw new Error(`mismatched reconciliation outcome: ${basename(path)}`);
    if (synchronize) {
      inspectOpenOutcome(path, descriptor, file);
      syncWithImmediateRetry(
        () => fsyncSync(descriptor),
        `outcome file sync failed for ${basename(path)}`,
      );
      inspectOpenOutcome(path, descriptor, file);
      if (!privateParentsValid(dirname(path)))
        throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
      syncWithImmediateRetry(
        () => fsyncDirectory(dirname(path)),
        `outcome directory sync failed for ${basename(path)}`,
      );
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}
function publicRecord(
  record: RecordInfo,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    record_id: record.record_id,
    area: record.area,
    filename: record.filename,
    classification: record.classification,
    planned_outcome: record.planned_outcome,
    reason: record.reason,
    ...(existing ? { outcome: existing.outcome, reconciled: true } : {}),
  };
}
function publishOutcome(
  record: RecordInfo,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const path = outcomePath(record);
  assertContained(RECONCILIATION_DIR, path);
  privateDirectory(dirname(path));
  try {
    publishBytesNoClobber(dirname(path), path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    return value;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = readOutcome(record, true);
    if (!existing) throw new Error(`outcome publication disappeared for ${record.filename}`);
    return existing;
  }
}
async function submit(record: RecordInfo, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const evidence = record.evidence!;
  const notes = JSON.stringify({
    legacy_agentscrape: {
      destination: evidence.destination,
      frontmatter: evidence.frontmatter,
      source: evidence.source,
      summarize: evidence.summarize,
    },
  });
  const result = await runProcess(
    [
      "agentbrain",
      "submit",
      String(evidence.url),
      "--kind",
      "url",
      "--ingress",
      record.ingress!,
      "--collection",
      "saved-links",
      "--notes",
      notes,
      "--json",
    ],
    {
      timeoutMs: 30_000,
      maxOutputBytes: 256_000,
      ...(signal ? { signal } : {}),
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `agentbrain submit exited ${result.exitCode}; stdout_chars=${result.stdout.length}; stderr_chars=${result.stderr.length}`,
    );
  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw new Error("agentbrain submit returned invalid JSON");
  }
  const data = envelope.data;
  const candidate =
    data && typeof data === "object" && !Array.isArray(data)
      ? {
          status: (data as Record<string, unknown>).status,
          job_id: (data as Record<string, unknown>).job_id,
          idempotency_key: (data as Record<string, unknown>).idempotency_key,
          ...((data as Record<string, unknown>).state === undefined
            ? {}
            : { state: (data as Record<string, unknown>).state }),
        }
      : null;
  if (
    envelope.schema_version !== 1 ||
    envelope.ok !== true ||
    envelope.command !== "submit" ||
    !validReceipt(candidate)
  )
    throw new Error("agentbrain submit returned an invalid acknowledgement");
  return candidate;
}
function validArchive(path: string, expectedSha256: string): boolean {
  if (!privateParentsValid(dirname(path))) return false;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.uid !== BigInt(currentUid()) ||
      (opened.mode & 0o777n) !== 0o600n
    )
      return false;
    const raw = readFileSync(descriptor);
    if (digest(raw) !== expectedSha256) return false;
    fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}
function archive(record: RecordInfo, manifest: Record<string, any>, claim: HeldClaim): void {
  if (manifest.outcome === "excluded") return;
  const directory = join(RECONCILIATION_DIR, "archive", record.area);
  privateDirectory(directory);
  const destination = join(RECONCILIATION_DIR, ...archiveRecord(record).split("/"));
  assertContained(RECONCILIATION_DIR, destination);
  try {
    publishBytesNoClobber(directory, destination, claim.snapshot.raw);
  } catch (error) {
    if (errorCode(error) !== "EEXIST" || !validArchive(destination, record.sha256))
      throw new Error(`archive collision for ${record.filename}`);
    fsyncDirectory(directory);
  }
  retireClaimedSource(record.path, claim);
}
export async function reconcileQueue(
  options: {
    apply?: boolean | undefined;
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const candidates = recordCandidates();
  throwIfAborted(options.signal);
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 5000)
    throw new Error("reconciliation limit must be an integer between 0 and 5000");
  if (!options.apply) {
    const selected = candidates.slice(0, limit).map((candidate) => {
      const record = classify(candidate.area, candidate.path, candidate.raw);
      return publicRecord(record, readOutcome(record));
    });
    return {
      schema_version: 1,
      mode: "inventory",
      total_records: candidates.length,
      selected_records: selected.length,
      remaining_records: Math.max(0, candidates.length - selected.length),
      records: selected,
    };
  }
  let chosen = 0;
  let already = 0;
  let errors = 0;
  let remaining = 0;
  let claimedElsewhere = 0;
  const results: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    let claimResult: ClaimResult;
    try {
      claimResult = acquireClaim(
        "reconcile",
        candidate.area,
        candidate.filename,
        candidate.path,
        candidate.sha256,
      );
    } catch (error) {
      errors += 1;
      remaining += 1;
      results.push({
        area: candidate.area,
        filename: candidate.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (claimResult.status !== "claimed") {
      if (claimResult.status === "busy") {
        claimedElsewhere += 1;
        remaining += 1;
      } else if (claimResult.status === "blocked") {
        errors += 1;
        remaining += 1;
        results.push({
          area: candidate.area,
          filename: candidate.filename,
          error: "claim evidence blocks this record",
        });
      } else if (captureSource(candidate.path) !== null) {
        // The inventoried generation vanished, but its public name now holds fresh work.
        remaining += 1;
      }
      continue;
    }
    const { claim } = claimResult;
    let record: RecordInfo | undefined;
    let handledError: unknown;
    let fatalError: unknown;
    try {
      record = classify(candidate.area, candidate.path, claim.snapshot.raw);
      const existing = readOutcome(record, true);
      if (existing) {
        already += 1;
        archive(record, existing, claim);
        results.push(publicRecord(record, existing));
        continue;
      }
      if (chosen >= limit) {
        remaining += 1;
        continue;
      }
      chosen += 1;
      const receipt =
        record.planned_outcome === "import" ? await submit(record, options.signal) : null;
      const outcome = receipt
        ? receipt.status === "queued"
          ? "imported"
          : "duplicate"
        : record.planned_outcome;
      const proposed = {
        schema_version: 1,
        record_id: record.record_id,
        legacy_record: {
          area: record.area,
          filename: record.filename,
          sha256: record.sha256,
          byte_size: record.byte_size,
        },
        classification: record.classification,
        outcome,
        reason: record.reason,
        archive_record: outcome === "excluded" ? null : archiveRecord(record),
        ...(record.evidence ? { evidence: record.evidence } : {}),
        ...(receipt ? { agentbrain_receipt: receipt } : {}),
      };
      const manifest = publishOutcome(record, proposed);
      archive(record, manifest, claim);
      results.push(publicRecord(record, manifest));
    } catch (error) {
      if (options.signal?.aborted) fatalError = cancellationError(options.signal);
      else {
        handledError = error;
        errors += 1;
        remaining += 1;
        results.push({
          ...(record
            ? publicRecord(record)
            : { area: candidate.area, filename: candidate.filename }),
          error: errorMessage(error),
        });
      }
    } finally {
      if (fatalError !== undefined) releaseClaimPreserving(claim, fatalError);
      if (handledError !== undefined) releaseClaimWithSecondary(claim, handledError);
      else releaseClaim(claim);
    }
  }
  const counts: Record<string, number> = {};
  for (const result of results) {
    const value = String(result.outcome ?? "error");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return {
    schema_version: 1,
    mode: "apply",
    total_records: candidates.length,
    selected_records: chosen,
    already_reconciled: already,
    claimed_elsewhere: claimedElsewhere,
    remaining_records: remaining,
    counts,
    records: results,
    errors,
  };
}

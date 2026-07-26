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
export const FROZEN_DIR = queuePaths.frozen;
export const RETRY_DIR = queuePaths.retry;
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
  area: "pending" | "failed" | "frozen" | "retry" | "generation";
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
  displayName: string;
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
    ["pending", "failed", "frozen", "retry", "generation"].includes(owner.area) &&
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
    throw new Error(`claim release ownership mismatch for ${claim.displayName}`);

  // The owner is the durable backstop for a slot unlink that a crash could undo. Do not remove
  // it until the slot directory confirms that the fixed arbitration name is durably absent.
  unlinkExactClaimFile(claim.slotPath, observed.slotInfo, `claim slot for ${claim.displayName}`);
  unlinkExactClaimFile(claim.ownerPath, observed.ownerInfo, `claim owner for ${claim.displayName}`);
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
interface HeldGenerationClaims {
  generation: HeldClaim;
  legacy?: HeldClaim;
}
type GenerationClaimResult =
  | { status: "claimed"; claims: HeldGenerationClaims }
  | { status: "busy" | "blocked" | "gone" };
function releaseGenerationClaims(
  claims: HeldGenerationClaims,
  primary?: unknown,
  throwPrimary = true,
): void {
  const errors: unknown[] = [];
  try {
    releaseClaim(claims.generation);
  } catch (error) {
    errors.push(error);
  }
  if (claims.legacy) {
    try {
      releaseClaim(claims.legacy);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    if (primary !== undefined && throwPrimary) throw primary;
    return;
  }
  const all = primary === undefined ? errors : [primary, ...errors];
  throw new AggregateError(
    all,
    `claim release also failed: ${all.map(boundedErrorText).join("; ")}`,
    primary === undefined ? undefined : { cause: primary },
  );
}
function sourceMatchesSnapshot(path: string, snapshot: SourceSnapshot): boolean {
  const current = captureSource(path);
  return current !== null && sameIdentity(current.identity, snapshot.identity);
}
function sourceStillClaimed(path: string, claim: HeldClaim): boolean {
  return sourceMatchesSnapshot(path, claim.snapshot);
}
function assertClaimHeld(claim: HeldClaim): void {
  const observed = inspectClaim(claim.slotPath, basename(claim.slotPath));
  if (
    !observed ||
    observed.value.token !== claim.value.token ||
    observed.bytes.compare(claim.bytes) !== 0 ||
    observed.ownerPath !== claim.ownerPath
  )
    throw new Error(`claim ownership changed for ${claim.value.name}`);
}
function acquireClaim(
  operation: ClaimOwner["operation"],
  area: ClaimOwner["area"],
  name: string,
  path: string,
  expectedSha256?: string,
  displayName = basename(path),
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
      publishedClaim = { value, bytes, slotPath, ownerPath, snapshot, displayName };
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
function acquireGenerationClaim(
  operation: ClaimOwner["operation"],
  id: string,
  path: string,
  expectedSha256: string,
  displayName: string,
  legacyName?: string,
): GenerationClaimResult {
  let legacy: HeldClaim | undefined;
  if (legacyName !== undefined) {
    const legacyResult = acquireClaim(
      operation,
      "pending",
      legacyName,
      path,
      expectedSha256,
      displayName,
    );
    if (legacyResult.status !== "claimed") return legacyResult;
    legacy = legacyResult.claim;
  }
  let generationResult: ClaimResult;
  try {
    generationResult = acquireClaim(operation, "generation", id, path, expectedSha256, displayName);
  } catch (error) {
    if (legacy) releaseClaimPreserving(legacy, error);
    throw error;
  }
  if (generationResult.status !== "claimed") {
    if (legacy) releaseClaim(legacy);
    return generationResult;
  }
  return {
    status: "claimed",
    claims: { generation: generationResult.claim, ...(legacy ? { legacy } : {}) },
  };
}
function retireCapturedSource(path: string, snapshot: SourceSnapshot, claim: HeldClaim): boolean {
  privateDirectory(RETIRE_QUARANTINE_DIR);
  assertClaimHeld(claim);
  if (!sourceMatchesSnapshot(path, snapshot)) return false;
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
    String(moved.dev) !== snapshot.identity.dev ||
    String(moved.ino) !== snapshot.identity.ino
  ) {
    // The pathname changed in the narrow conditional rename gap. Preserve that evidence privately.
    return false;
  }
  const movedSnapshot = captureSource(quarantine);
  const expected = snapshot.identity;
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
  assertClaimHeld(claim);
  unlinkSync(quarantine);
  fsyncDirectory(RETIRE_QUARANTINE_DIR);
  return true;
}
function retireClaimedSource(path: string, claim: HeldClaim): boolean {
  return retireCapturedSource(path, claim.snapshot, claim);
}
function retireExactOrThrow(path: string, snapshot: SourceSnapshot, claim: HeldClaim): void {
  if (!retireCapturedSource(path, snapshot, claim))
    throw new Error(`could not exactly retire logical predecessor: ${basename(path)}`);
}
const PUBLICATION_TEMP_PREFIX = ".agentscrape-publish-";
const PUBLICATION_TEMP_PATTERN =
  /^\.agentscrape-publish-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const MAX_STATE_DIRECTORY_ENTRIES = 5000;
const MAX_PUBLICATION_TEMP_BYTES = 1_000_000n;

function recoverPublicationTemps(directory: string): Set<string> {
  const entries = directoryEntries(directory);
  if (entries.length > MAX_STATE_DIRECTORY_ENTRIES)
    throw new Error(`state directory exceeds its bounded recovery limit: ${directory}`);
  const retained = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.startsWith(PUBLICATION_TEMP_PREFIX)) continue;
    if (!PUBLICATION_TEMP_PATTERN.test(entry.name))
      throw new Error(`malformed publication temporary blocks state directory: ${entry.name}`);
    const temporary = join(directory, entry.name);
    let descriptor: number;
    try {
      descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new Error(`invalid publication temporary: ${entry.name}`, { cause: error });
    }
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      let named: ReturnType<typeof lstatSync>;
      try {
        named = lstatSync(temporary, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
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
        opened.size > MAX_PUBLICATION_TEMP_BYTES ||
        opened.nlink !== named.nlink ||
        (opened.nlink !== 1n && opened.nlink !== 2n)
      )
        throw new Error(`invalid publication temporary: ${entry.name}`);
      if (opened.nlink === 1n) {
        const after = fstatSync(descriptor, { bigint: true });
        let current: ReturnType<typeof lstatSync>;
        try {
          current = lstatSync(temporary, { bigint: true });
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          throw error;
        }
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs ||
          after.ctimeNs !== opened.ctimeNs ||
          after.nlink !== 1n ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.size !== opened.size ||
          current.mtimeNs !== opened.mtimeNs ||
          current.ctimeNs !== opened.ctimeNs ||
          current.uid !== BigInt(currentUid()) ||
          (current.mode & 0o777n) !== 0o600n ||
          current.nlink !== 1n ||
          current.isSymbolicLink()
        )
          throw new Error(`publication temporary changed during recovery: ${entry.name}`);
        retained.add(entry.name);
        continue;
      }
      const peers: string[] = [];
      for (const candidate of entries) {
        if (candidate.name === entry.name || candidate.name.startsWith(PUBLICATION_TEMP_PREFIX))
          continue;
        const candidatePath = join(directory, candidate.name);
        try {
          const info = lstatSync(candidatePath, { bigint: true });
          if (
            info.isFile() &&
            !info.isSymbolicLink() &&
            info.dev === opened.dev &&
            info.ino === opened.ino
          )
            peers.push(candidatePath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      if (peers.length !== 1)
        throw new Error(`ambiguous linked publication temporary: ${entry.name}`);
      let peer: ReturnType<typeof lstatSync>;
      let current: ReturnType<typeof lstatSync>;
      try {
        peer = lstatSync(peers[0]!, { bigint: true });
        current = lstatSync(temporary, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          try {
            current = lstatSync(temporary, { bigint: true });
          } catch (currentError) {
            if (errorCode(currentError) === "ENOENT") continue;
            throw currentError;
          }
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.uid === BigInt(currentUid()) &&
            (current.mode & 0o777n) === 0o600n &&
            current.nlink === 1n &&
            current.dev === opened.dev &&
            current.ino === opened.ino
          ) {
            retained.add(entry.name);
            continue;
          }
        }
        throw error;
      }
      if (
        !peer.isFile() ||
        peer.isSymbolicLink() ||
        peer.uid !== BigInt(currentUid()) ||
        (peer.mode & 0o777n) !== 0o600n ||
        peer.nlink !== 2n ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.uid !== BigInt(currentUid()) ||
        (current.mode & 0o777n) !== 0o600n ||
        current.nlink !== 2n ||
        peer.dev !== opened.dev ||
        peer.ino !== opened.ino ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        throw new Error(`invalid linked publication temporary: ${entry.name}`);
      try {
        unlinkSync(temporary);
        fsyncDirectory(directory);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    } finally {
      closeSync(descriptor);
    }
  }
  return retained;
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
function publishFailedRaw(name: string, raw: Buffer, identity: string): void {
  const extension = name.endsWith(".yaml") ? ".yaml" : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
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
function publishFailed(name: string, claim: HeldClaim): void {
  publishFailedRaw(
    name,
    claim.snapshot.raw,
    `${claim.snapshot.identity.sha256.slice(0, 12)}-${claim.value.token.slice(0, 8)}`,
  );
}

function envDelay(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0.1 && value <= 3600 ? value : fallback;
}
function envMaxAttempts(): number {
  const raw = process.env.AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS;
  if (raw === undefined) return 5;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)
    throw new Error(
      "AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS must be an integer between 1 and 100",
    );
  return Number(raw);
}
export function retryDelay(attempt: number, initial = 1, maximum = 60): number {
  return Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
}
interface RetryPolicy {
  initialDelaySeconds: number;
  maxDelaySeconds: number;
  maxAttempts: number;
}
interface FrozenEnvelope {
  version: 1;
  state: "frozen";
  generationId: string;
  logicalArea: "pending";
  originalFilename: string;
  rawByteSize: number;
  rawSha256: string;
  rawBase64: string;
}
interface RetryEnvelope {
  version: 1;
  state: "retry";
  generationId: string;
  logicalArea: "pending";
  originalFilename: string;
  rawByteSize: number;
  rawSha256: string;
  rawBase64: string;
  completedFailures: number;
  nextAttemptAtMs: number;
  policy: RetryPolicy;
}
function generationId(name: string, raw: Uint8Array): string {
  return digest(Buffer.concat([Buffer.from(`pending\0${name}\0`), Buffer.from(raw)]));
}
function validOriginalName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name === basename(name) &&
    !name.includes("\0") &&
    Buffer.byteLength(name) <= 255 &&
    name.endsWith(".yaml")
  );
}
function rawFieldsValid(value: Record<string, unknown>): Buffer | null {
  if (
    !validOriginalName(value.originalFilename) ||
    !Number.isSafeInteger(value.rawByteSize) ||
    Number(value.rawByteSize) < 0 ||
    Number(value.rawByteSize) > MAX_RECORD_BYTES ||
    typeof value.rawSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.rawSha256) ||
    typeof value.rawBase64 !== "string"
  )
    return null;
  const raw = Buffer.from(value.rawBase64, "base64");
  if (
    raw.byteLength !== value.rawByteSize ||
    raw.toString("base64") !== value.rawBase64 ||
    digest(raw) !== value.rawSha256 ||
    generationId(value.originalFilename, raw) !== value.generationId
  )
    return null;
  return raw;
}
function privateEnvelopeBytes(path: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`invalid private queue envelope: ${basename(path)}`, { cause: error });
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
      named.uid !== BigInt(currentUid()) ||
      (opened.mode & 0o777n) !== 0o600n ||
      (named.mode & 0o777n) !== 0o600n ||
      opened.nlink !== 1n ||
      named.nlink !== 1n ||
      opened.size > 1_000_000n
    )
      throw new Error(`invalid private queue envelope: ${basename(path)}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.uid !== opened.uid ||
      (after.mode & 0o777n) !== 0o600n ||
      after.nlink !== 1n ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeNs !== opened.mtimeNs ||
      current.ctimeNs !== opened.ctimeNs ||
      current.uid !== opened.uid ||
      (current.mode & 0o777n) !== 0o600n ||
      current.nlink !== 1n ||
      current.isSymbolicLink()
    )
      throw new Error(`private queue envelope changed while reading: ${basename(path)}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
function parseCanonicalEnvelope(path: string): { value: Record<string, unknown>; bytes: Buffer } {
  const bytes = privateEnvelopeBytes(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`malformed private queue envelope: ${basename(path)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    `${JSON.stringify(parsed)}\n` !== bytes.toString("utf8")
  )
    throw new Error(`noncanonical private queue envelope: ${basename(path)}`);
  return { value: parsed as Record<string, unknown>, bytes };
}
function frozenName(id: string): string {
  return `${id}.json`;
}
function retryName(id: string, completedFailures: number): string {
  return `${id}--attempt-${completedFailures}.json`;
}
function frozenEnvelope(name: string, raw: Buffer): FrozenEnvelope {
  const id = generationId(name, raw);
  return {
    version: 1,
    state: "frozen",
    generationId: id,
    logicalArea: "pending",
    originalFilename: name,
    rawByteSize: raw.byteLength,
    rawSha256: digest(raw),
    rawBase64: raw.toString("base64"),
  };
}
function readFrozenEnvelope(path: string): { envelope: FrozenEnvelope; raw: Buffer } {
  const { value } = parseCanonicalEnvelope(path);
  if (
    Object.keys(value).join(",") !==
      "version,state,generationId,logicalArea,originalFilename,rawByteSize,rawSha256,rawBase64" ||
    value.version !== 1 ||
    value.state !== "frozen" ||
    value.logicalArea !== "pending" ||
    typeof value.generationId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.generationId) ||
    basename(path) !== frozenName(value.generationId)
  )
    throw new Error(`invalid frozen envelope: ${basename(path)}`);
  const raw = rawFieldsValid(value);
  if (!raw) throw new Error(`mismatched frozen envelope: ${basename(path)}`);
  return { envelope: value as unknown as FrozenEnvelope, raw };
}
function retryEnvelope(
  name: string,
  raw: Buffer,
  completedFailures: number,
  nextAttemptAtMs: number,
  policy: RetryPolicy,
): RetryEnvelope {
  return {
    version: 1,
    state: "retry",
    generationId: generationId(name, raw),
    logicalArea: "pending",
    originalFilename: name,
    rawByteSize: raw.byteLength,
    rawSha256: digest(raw),
    rawBase64: raw.toString("base64"),
    completedFailures,
    nextAttemptAtMs,
    policy,
  };
}
function readRetryEnvelope(path: string): { envelope: RetryEnvelope; raw: Buffer } {
  const { value } = parseCanonicalEnvelope(path);
  const policy = value.policy as Record<string, unknown> | undefined;
  if (
    Object.keys(value).join(",") !==
      "version,state,generationId,logicalArea,originalFilename,rawByteSize,rawSha256,rawBase64,completedFailures,nextAttemptAtMs,policy" ||
    value.version !== 1 ||
    value.state !== "retry" ||
    value.logicalArea !== "pending" ||
    typeof value.generationId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.generationId) ||
    !Number.isSafeInteger(value.completedFailures) ||
    Number(value.completedFailures) < 1 ||
    Number(value.completedFailures) > 100 ||
    !Number.isSafeInteger(value.nextAttemptAtMs) ||
    Number(value.nextAttemptAtMs) < 0 ||
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).join(",") !== "initialDelaySeconds,maxDelaySeconds,maxAttempts" ||
    typeof policy.initialDelaySeconds !== "number" ||
    !Number.isFinite(policy.initialDelaySeconds) ||
    policy.initialDelaySeconds < 0.1 ||
    policy.initialDelaySeconds > 3600 ||
    typeof policy.maxDelaySeconds !== "number" ||
    !Number.isFinite(policy.maxDelaySeconds) ||
    policy.maxDelaySeconds < policy.initialDelaySeconds ||
    policy.maxDelaySeconds > 3600 ||
    !Number.isSafeInteger(policy.maxAttempts) ||
    Number(policy.maxAttempts) < 1 ||
    Number(policy.maxAttempts) > 100 ||
    Number(value.completedFailures) >= Number(policy.maxAttempts) ||
    basename(path) !== retryName(value.generationId, Number(value.completedFailures))
  )
    throw new Error(`invalid retry envelope: ${basename(path)}`);
  const raw = rawFieldsValid(value);
  if (!raw) throw new Error(`mismatched retry envelope: ${basename(path)}`);
  return { envelope: value as unknown as RetryEnvelope, raw };
}
function synchronizePrivateEnvelope(path: string, expected: Buffer): void {
  const before = privateEnvelopeBytes(path);
  if (before.compare(expected) !== 0)
    throw new Error(`private queue envelope changed: ${basename(path)}`);
  syncWithImmediateRetry(
    () => syncRegularFileAndParent(path),
    `private queue envelope sync failed for ${basename(path)}`,
  );
  if (privateEnvelopeBytes(path).compare(expected) !== 0)
    throw new Error(`private queue envelope changed: ${basename(path)}`);
}
function publishCanonicalEnvelope(
  directory: string,
  path: string,
  value: FrozenEnvelope | RetryEnvelope,
): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  try {
    publishBytesNoClobber(directory, path, bytes);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    synchronizePrivateEnvelope(path, bytes);
  }
}
function directoryEntries(directory: string): Dirent<string>[] {
  try {
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== currentUid() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Error(`${directory} must be an owned real mode-0700 directory`);
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}
interface CapturedRetry {
  path: string;
  envelope: RetryEnvelope;
  raw: Buffer;
  snapshot: SourceSnapshot;
}
interface RetryDirectoryIdentity {
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
}
interface RetryCatalog {
  groups: Map<string, CapturedRetry[]>;
  malformed: Array<{ path: string; generationId?: string; error: unknown }>;
  directoryIdentity: RetryDirectoryIdentity;
}
function retryGenerationFromName(name: string): string | undefined {
  return /^([0-9a-f]{64})--attempt-/.exec(name)?.[1];
}
function retryDirectoryIdentity(): RetryDirectoryIdentity {
  const info = lstatSync(RETRY_DIR, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("retry queue must be a real directory");
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}
function sameRetryDirectoryIdentity(
  left: RetryDirectoryIdentity,
  right: RetryDirectoryIdentity,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof RetryDirectoryIdentity] === right[key as keyof RetryDirectoryIdentity],
  );
}
function scanRetryCatalog(): RetryCatalog {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retainedPublicationTemps = recoverPublicationTemps(RETRY_DIR);
    const before = retryDirectoryIdentity();
    const groups = new Map<string, CapturedRetry[]>();
    const malformed: RetryCatalog["malformed"] = [];
    for (const entry of directoryEntries(RETRY_DIR)) {
      if (retainedPublicationTemps.has(entry.name)) continue;
      const path = join(RETRY_DIR, entry.name);
      if (!entry.name.endsWith(".json")) {
        const generationId = retryGenerationFromName(entry.name);
        malformed.push({
          path,
          ...(generationId ? { generationId } : {}),
          error: new Error(`unexpected retry directory entry: ${entry.name}`),
        });
        continue;
      }
      try {
        const snapshot = captureSource(path);
        if (!snapshot) throw new Error(`retry envelope disappeared: ${entry.name}`);
        const value = readRetryEnvelope(path);
        const canonical = Buffer.from(`${JSON.stringify(value.envelope)}\n`);
        if (snapshot.raw.compare(canonical) !== 0)
          throw new Error(`retry envelope changed while scanning: ${entry.name}`);
        const group = groups.get(value.envelope.generationId) ?? [];
        group.push({ path, ...value, snapshot });
        groups.set(value.envelope.generationId, group);
      } catch (error) {
        const generationId = retryGenerationFromName(entry.name);
        malformed.push({ path, ...(generationId ? { generationId } : {}), error });
      }
    }
    for (const group of groups.values())
      group.sort(
        (left, right) => left.envelope.completedFailures - right.envelope.completedFailures,
      );
    const directoryIdentity = retryDirectoryIdentity();
    if (sameRetryDirectoryIdentity(before, directoryIdentity))
      return { groups, malformed, directoryIdentity };
    if (attempt === 2) {
      malformed.push({
        path: RETRY_DIR,
        error: new Error("retry directory changed during its bounded scan"),
      });
      return { groups, malformed, directoryIdentity };
    }
  }
  throw new Error("retry catalog bounded scan exhausted unexpectedly");
}
function samePolicy(left: RetryPolicy, right: RetryPolicy): boolean {
  return (
    left.initialDelaySeconds === right.initialDelaySeconds &&
    left.maxDelaySeconds === right.maxDelaySeconds &&
    left.maxAttempts === right.maxAttempts
  );
}
function validateRetryChain(id: string, catalog: RetryCatalog): CapturedRetry[] {
  const malformed = catalog.malformed.find((item) => item.generationId === id);
  if (malformed)
    throw new Error(`malformed retry predecessor blocks generation ${id}`, {
      cause: malformed.error,
    });
  const values = catalog.groups.get(id) ?? [];
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]!;
    if (current.envelope.generationId !== id)
      throw new Error(`mismatched retry generation: ${basename(current.path)}`);
    if (index > 0) {
      const previous = values[index - 1]!;
      if (
        current.envelope.completedFailures !== previous.envelope.completedFailures + 1 ||
        current.envelope.originalFilename !== previous.envelope.originalFilename ||
        current.raw.compare(previous.raw) !== 0 ||
        !samePolicy(current.envelope.policy, previous.envelope.policy)
      )
        throw new Error(`invalid retry chain for generation ${id}`);
    }
  }
  return values;
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
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid())
    throw new Error(`${path} must be an owned real directory`);
  if ((info.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
    fsyncDirectory(dirname(path));
  } else if (!existed) fsyncDirectory(dirname(path));
}
interface QueueResult {
  processed: number;
  failed: number;
  frozen: number;
  retry_scheduled: number;
  retry_waiting: number;
  retry_exhausted: number;
}
function parseStandaloneJob(raw: Buffer): Record<string, unknown> {
  if (raw.byteLength > MAX_RECORD_BYTES) throw new Error("job exceeds its size limit");
  const parsed = parseYaml(raw.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("job must be a mapping");
  const job = parsed as Record<string, unknown>;
  if (
    Object.keys(job).some((key) => !JOB_FIELDS.has(key)) ||
    !validUrl(job.url) ||
    typeof job.destination !== "string" ||
    !job.destination.trim() ||
    job.destination.length > 4096 ||
    ("summarize" in job && typeof job.summarize !== "boolean") ||
    ("frontmatter" in job &&
      (!job.frontmatter || typeof job.frontmatter !== "object" || Array.isArray(job.frontmatter)))
  )
    throw new Error("invalid standalone queue job");
  return job;
}
async function executeJob(
  job: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const destination = expandHome(String(job.destination));
  resetBrowserUnavailableCache();
  await fetchMarkdown(String(job.url), { destination, signal });
  const frontmatter = { ...(job.frontmatter as Record<string, unknown> | undefined) };
  if (job.summarize) {
    const body = stripFrontmatter(readFileSync(destination, "utf8"));
    const summaryResult = await runProcess(["summaryctl", "short-summary"], {
      timeoutMs: 120_000,
      maxOutputBytes: 64_000,
      stdin: body,
      ...(signal ? { signal } : {}),
    });
    const summary = summaryResult.stdout.trim();
    if (summaryResult.exitCode !== 0 || !summary) throw new Error("summary command failed");
    frontmatter.summary = summary;
  }
  if (Object.keys(frontmatter).length) {
    const body = stripFrontmatter(readFileSync(destination, "utf8"));
    writeFileSync(destination, `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`);
  }
  syncRegularFileAndParent(destination);
}
function terminalFailedName(name: string, id: string): string {
  const extension = name.endsWith(".yaml") ? ".yaml" : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const suffix = `--failed-${id}${extension}`;
  return `${truncateUtf8(stem, 255 - Buffer.byteLength(suffix))}${suffix}`;
}
function terminalGenerationFromName(name: string): string | undefined {
  return /--failed-([0-9a-f]{64})\.yaml$/.exec(name)?.[1];
}
function strictTerminalEvidenceAtPath(path: string, raw: Buffer): "absent" | "exact" | "different" {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "different";
  }
  try {
    const inspect = (): Buffer | null => {
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
          named.uid !== BigInt(currentUid()) ||
          (opened.mode & 0o777n) !== 0o600n ||
          (named.mode & 0o777n) !== 0o600n ||
          opened.nlink !== 1n ||
          named.nlink !== 1n ||
          opened.size !== BigInt(raw.byteLength)
        )
          return null;
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          if (count === 0) return null;
          offset += count;
        }
        const after = fstatSync(descriptor, { bigint: true });
        const current = lstatSync(path, { bigint: true });
        if (
          bytes.compare(raw) !== 0 ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs ||
          after.ctimeNs !== opened.ctimeNs ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.size !== opened.size ||
          current.mtimeNs !== opened.mtimeNs ||
          current.ctimeNs !== opened.ctimeNs ||
          current.nlink !== 1n ||
          (current.mode & 0o777n) !== 0o600n
        )
          return null;
        return bytes;
      } catch {
        return null;
      }
    };
    if (!inspect()) return "different";
    try {
      syncWithImmediateRetry(
        () => fsyncSync(descriptor),
        `terminal evidence file sync failed for ${basename(path)}`,
      );
      if (!inspect()) return "different";
      syncWithImmediateRetry(
        () => fsyncDirectory(dirname(path)),
        `terminal evidence directory sync failed for ${basename(path)}`,
      );
    } catch {
      return "different";
    }
    return inspect() ? "exact" : "different";
  } finally {
    closeSync(descriptor);
  }
}
function terminalEvidence(name: string, id: string, raw: Buffer): "absent" | "exact" | "different" {
  return strictTerminalEvidenceAtPath(join(FAILED_DIR, terminalFailedName(name, id)), raw);
}
function publishTerminal(name: string, id: string, raw: Buffer): void {
  const destination = join(FAILED_DIR, terminalFailedName(name, id));
  try {
    publishBytesNoClobber(FAILED_DIR, destination, raw);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (terminalEvidence(name, id, raw) !== "exact")
      throw new Error(`terminal failed evidence collision: ${basename(destination)}`);
    syncWithImmediateRetry(
      () => syncRegularFileAndParent(destination),
      `terminal evidence sync failed for ${basename(destination)}`,
    );
  }
  if (strictTerminalEvidenceAtPath(destination, raw) !== "exact")
    throw new Error(`terminal failed evidence is not strict and durable: ${basename(destination)}`);
}
function capturedPolicy(): RetryPolicy {
  const initialDelaySeconds = envDelay("AGENTSCRAPE_PROCESS_QUEUE_RETRY_INITIAL_DELAY_SECONDS", 1);
  return {
    initialDelaySeconds,
    maxDelaySeconds: Math.max(
      initialDelaySeconds,
      envDelay("AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_DELAY_SECONDS", 60),
    ),
    maxAttempts: envMaxAttempts(),
  };
}
function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("queue clock must return a non-negative safe integer millisecond timestamp");
  return value;
}
function scheduleRetry(
  name: string,
  raw: Buffer,
  completedFailures: number,
  policy: RetryPolicy,
  nowMs: number,
): void {
  const delayMs = Math.ceil(
    retryDelay(completedFailures, policy.initialDelaySeconds, policy.maxDelaySeconds) * 1000,
  );
  if (!Number.isSafeInteger(delayMs) || !Number.isSafeInteger(nowMs + delayMs))
    throw new Error("retry due timestamp exceeds the safe integer range");
  const value = retryEnvelope(name, raw, completedFailures, nowMs + delayMs, policy);
  publishCanonicalEnvelope(
    RETRY_DIR,
    join(RETRY_DIR, retryName(value.generationId, completedFailures)),
    value,
  );
}
function exactReadyDuplicate(
  name: string,
  raw: Buffer,
  id: string,
): { path: string; snapshot: SourceSnapshot } | null {
  const path = join(QUEUE_DIR, name);
  const snapshot = captureSource(path);
  if (!snapshot) return null;
  if (generationId(name, snapshot.raw) !== id) return null;
  if (snapshot.raw.compare(raw) !== 0)
    throw new Error(`same-generation ready predecessor differs: ${name}`);
  return { path, snapshot };
}
function retryGroupStillStable(group: CapturedRetry[]): boolean {
  return group.every((item) => sourceMatchesSnapshot(item.path, item.snapshot));
}
function currentRetryChain(id: string, catalog: RetryCatalog): CapturedRetry[] {
  const initial = validateRetryChain(id, catalog);
  if (
    retryGroupStillStable(initial) &&
    sameRetryDirectoryIdentity(catalog.directoryIdentity, retryDirectoryIdentity())
  )
    return initial;
  const refreshed = scanRetryCatalog();
  if (refreshed.malformed.length > 0) throw refreshed.malformed[0]!.error;
  catalog.groups = refreshed.groups;
  catalog.malformed = refreshed.malformed;
  catalog.directoryIdentity = refreshed.directoryIdentity;
  return validateRetryChain(id, catalog);
}
function synchronizeRetryChain(values: CapturedRetry[]): void {
  for (const value of values)
    synchronizePrivateEnvelope(value.path, Buffer.from(`${JSON.stringify(value.envelope)}\n`));
}
function terminalBlocksOrMatches(name: string, id: string, raw: Buffer): boolean {
  const terminal = terminalEvidence(name, id, raw);
  if (terminal === "different") throw new Error(`terminal failed evidence collision for ${name}`);
  return terminal === "exact";
}

export async function processQueue(
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<QueueResult> {
  publicDirectory(QUEUE_DIR);
  publicDirectory(FROZEN_DIR);
  publicDirectory(RETRY_DIR);
  publicDirectory(FAILED_DIR);
  recoverPublicationTemps(FROZEN_DIR);
  recoverPublicationTemps(FAILED_DIR);
  const result: QueueResult = {
    processed: 0,
    failed: 0,
    frozen: 0,
    retry_scheduled: 0,
    retry_waiting: 0,
    retry_exhausted: 0,
  };
  const now = options.now ?? Date.now;
  const initialRetries = scanRetryCatalog();
  let retryError: unknown = initialRetries.malformed[0]?.error;
  const names = readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();

  // Ready work is intentionally independent: one outage schedules a retry without head-of-line
  // blocking later ready jobs. Every physical form of one generation uses the same claim slot.
  for (const name of names) {
    throwIfAborted(options.signal);
    const path = join(QUEUE_DIR, name);
    const captured = captureSource(path);
    if (!captured) continue;
    const id = generationId(name, captured.raw);
    const claimResult = acquireGenerationClaim(
      "process",
      id,
      path,
      captured.identity.sha256,
      name,
      name,
    );
    if (claimResult.status === "blocked")
      throw new Error(`claim evidence blocks queue record or generation: ${name}`);
    if (claimResult.status !== "claimed") continue;
    const { claims } = claimResult;
    const claim = claims.generation;
    let primary: unknown;
    try {
      throwIfAborted(options.signal);
      if (terminalBlocksOrMatches(name, id, claim.snapshot.raw)) {
        retireClaimedSource(path, claim);
        result.failed += 1;
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        const value = parseYaml(claim.snapshot.raw.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        parsed = value as Record<string, unknown>;
      } catch {
        publishFailed(name, claim);
        retireClaimedSource(path, claim);
        result.failed += 1;
        continue;
      }
      if ("indexer" in parsed) {
        if (claim.snapshot.raw.byteLength > MAX_RECORD_BYTES || !validOriginalName(name)) {
          publishFailed(name, claim);
          retireClaimedSource(path, claim);
          result.failed += 1;
          continue;
        }
        const envelope = frozenEnvelope(name, claim.snapshot.raw);
        const frozenPath = join(FROZEN_DIR, frozenName(id));
        publishCanonicalEnvelope(FROZEN_DIR, frozenPath, envelope);
        readFrozenEnvelope(frozenPath);
        retireClaimedSource(path, claim);
        result.frozen += 1;
        continue;
      }
      let job: Record<string, unknown>;
      try {
        job = parseStandaloneJob(claim.snapshot.raw);
      } catch {
        publishFailed(name, claim);
        retireClaimedSource(path, claim);
        result.failed += 1;
        continue;
      }
      try {
        // Refresh after winning the generation claim: a peer may have durably published retry
        // state after our invocation-wide scan but before releasing this logical generation.
        const retries = currentRetryChain(id, initialRetries);
        if (retries.length > 0) {
          const highest = retries.at(-1)!;
          if (
            highest.envelope.originalFilename !== name ||
            highest.raw.compare(claim.snapshot.raw) !== 0
          )
            throw new Error(`retry policy chain does not match ready generation ${id}`);
          synchronizeRetryChain(retries);
          retireClaimedSource(path, claim);
          continue;
        }
      } catch (error) {
        retryError ??= error;
        continue;
      }
      try {
        await executeJob(job, options.signal);
        throwIfAborted(options.signal);
        retireClaimedSource(path, claim);
        result.processed += 1;
      } catch (error) {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        if (error instanceof AgentscrapeUpstreamDownError) {
          const policy = capturedPolicy();
          if (policy.maxAttempts === 1) {
            publishTerminal(name, id, claim.snapshot.raw);
            retireClaimedSource(path, claim);
            result.failed += 1;
            result.retry_exhausted += 1;
          } else {
            scheduleRetry(name, claim.snapshot.raw, 1, policy, checkedNow(now));
            retireClaimedSource(path, claim);
            result.retry_scheduled += 1;
          }
        } else {
          publishFailed(name, claim);
          retireClaimedSource(path, claim);
          result.failed += 1;
        }
      }
    } catch (error) {
      primary = error;
    } finally {
      releaseGenerationClaims(claims, primary);
    }
  }

  // A malformed private envelope never blocks unrelated ready work, but it blocks every retry
  // provider call in this invocation because the complete retry chain cannot be proven.
  if (initialRetries.malformed.length > 0) throw retryError;

  // Only generations present at invocation start are retry candidates. Newly scheduled retries
  // are always left durable for a later invocation, including a zero-delay test policy.
  for (const [id, initialGroup] of initialRetries.groups) {
    throwIfAborted(options.signal);
    const candidate = initialGroup.at(-1)!;
    const claimResult = acquireGenerationClaim(
      "process",
      id,
      candidate.path,
      candidate.snapshot.identity.sha256,
      basename(candidate.path),
    );
    if (claimResult.status === "blocked") {
      retryError ??= new Error(`claim evidence blocks retry generation: ${id}`);
      continue;
    }
    if (claimResult.status !== "claimed") continue;
    const { claims } = claimResult;
    const claim = claims.generation;
    let primary: unknown;
    try {
      throwIfAborted(options.signal);
      const values = currentRetryChain(id, initialRetries);
      if (values.length === 0) continue;
      synchronizeRetryChain(values);
      const current = values.at(-1)!;
      if (current.path !== candidate.path) continue;
      const terminal = terminalEvidence(current.envelope.originalFilename, id, current.raw);
      if (terminal === "different")
        throw new Error(
          `terminal failed evidence collision for ${current.envelope.originalFilename}`,
        );
      if (terminal === "exact") {
        for (const value of values) retireExactOrThrow(value.path, value.snapshot, claim);
        const ready = exactReadyDuplicate(current.envelope.originalFilename, current.raw, id);
        if (ready) retireExactOrThrow(ready.path, ready.snapshot, claim);
        result.failed += 1;
        // A terminal may represent exhaustion or a permanent provider error. Without a strict
        // reason marker recovery is deliberately conservative and never invents exhaustion.
        continue;
      }
      // Collapse every proven stale physical predecessor as soon as this canonical state wins.
      // In particular, a not-yet-due retry must not leave a stale ready pathname keeping
      // QueueDirectories active until its delay expires. The highest retry remains authoritative.
      for (const predecessor of values.slice(0, -1))
        retireExactOrThrow(predecessor.path, predecessor.snapshot, claim);
      const ready = exactReadyDuplicate(current.envelope.originalFilename, current.raw, id);
      if (ready) retireExactOrThrow(ready.path, ready.snapshot, claim);
      if (checkedNow(now) < current.envelope.nextAttemptAtMs) {
        result.retry_waiting += 1;
        continue;
      }
      let job: Record<string, unknown>;
      try {
        job = parseStandaloneJob(current.raw);
      } catch (error) {
        throw new Error(`retry contains an invalid original job: ${basename(current.path)}`, {
          cause: error,
        });
      }
      try {
        await executeJob(job, options.signal);
        throwIfAborted(options.signal);
        retireCapturedSource(current.path, current.snapshot, claim);
        result.processed += 1;
      } catch (error) {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        if (error instanceof AgentscrapeUpstreamDownError) {
          const completed = current.envelope.completedFailures + 1;
          if (completed >= current.envelope.policy.maxAttempts) {
            publishTerminal(current.envelope.originalFilename, id, current.raw);
            retireCapturedSource(current.path, current.snapshot, claim);
            result.failed += 1;
            result.retry_exhausted += 1;
          } else {
            scheduleRetry(
              current.envelope.originalFilename,
              current.raw,
              completed,
              current.envelope.policy,
              checkedNow(now),
            );
            retireCapturedSource(current.path, current.snapshot, claim);
            result.retry_scheduled += 1;
          }
        } else {
          publishTerminal(current.envelope.originalFilename, id, current.raw);
          retireCapturedSource(current.path, current.snapshot, claim);
          result.failed += 1;
        }
      }
    } catch (error) {
      primary = error;
      retryError ??= error;
    } finally {
      releaseGenerationClaims(claims, primary, false);
    }
  }
  if (retryError !== undefined) throw retryError;
  return result;
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
  physicalArea: ClaimOwner["area"];
  path: string;
  filename: string;
  physicalFilename: string;
  sha256: string;
  claimSha256: string;
  raw: Buffer;
  generationId?: string;
  deterministicTerminal?: boolean;
}
function recordCandidates(): RecordCandidate[] {
  recoverPublicationTemps(FROZEN_DIR);
  recoverPublicationTemps(FAILED_DIR);
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
      const terminalGeneration =
        area === "failed" ? terminalGenerationFromName(entry.name) : undefined;
      candidates.push({
        area,
        physicalArea: area,
        path,
        filename: entry.name,
        physicalFilename: entry.name,
        sha256: snapshot.identity.sha256,
        claimSha256: snapshot.identity.sha256,
        raw: snapshot.raw,
        ...(area === "pending"
          ? { generationId: generationId(entry.name, snapshot.raw) }
          : terminalGeneration
            ? { generationId: terminalGeneration, deterministicTerminal: true }
            : {}),
      });
    }
  }
  for (const entry of directoryEntries(FROZEN_DIR)) {
    if (!entry.name.endsWith(".json")) continue;
    const path = join(FROZEN_DIR, entry.name);
    const snapshot = captureSource(path);
    const { envelope, raw } = readFrozenEnvelope(path);
    if (!snapshot) throw new Error(`frozen envelope disappeared: ${entry.name}`);
    const canonical = Buffer.from(`${JSON.stringify(envelope)}\n`);
    if (snapshot.raw.compare(canonical) !== 0)
      throw new Error(`frozen envelope changed while scanning: ${entry.name}`);
    candidates.push({
      area: "pending",
      physicalArea: "frozen",
      path,
      filename: envelope.originalFilename,
      physicalFilename: entry.name,
      sha256: envelope.rawSha256,
      claimSha256: snapshot.identity.sha256,
      raw,
      generationId: envelope.generationId,
    });
  }
  if (candidates.length > 5000)
    throw new Error("queue inventory exceeds the 5000-record safety limit");
  const frozenGenerations = new Set(
    candidates
      .filter((candidate) => candidate.physicalArea === "frozen")
      .map((candidate) => candidate.generationId),
  );
  return candidates
    .filter(
      (candidate) =>
        candidate.physicalArea !== "pending" || !frozenGenerations.has(candidate.generationId),
    )
    .sort(
      (a, b) =>
        a.filename.localeCompare(b.filename) ||
        a.area.localeCompare(b.area) ||
        a.physicalArea.localeCompare(b.physicalArea),
    );
}
function generationHasPredecessor(id: string): boolean {
  recoverPublicationTemps(RETRY_DIR);
  recoverPublicationTemps(FROZEN_DIR);
  for (const entry of readdirSync(QUEUE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".yaml")) continue;
    const snapshot = captureSource(join(QUEUE_DIR, entry.name));
    if (snapshot && generationId(entry.name, snapshot.raw) === id) return true;
  }
  for (const entry of directoryEntries(RETRY_DIR))
    if (entry.name.startsWith(`${id}--attempt-`)) return true;
  return directoryEntries(FROZEN_DIR).some((entry) => entry.name === frozenName(id));
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
function archive(
  record: RecordInfo,
  manifest: Record<string, any>,
  claim: HeldClaim,
  physicalPath: string,
  raw: Buffer,
): void {
  if (manifest.outcome === "excluded") return;
  const directory = join(RECONCILIATION_DIR, "archive", record.area);
  privateDirectory(directory);
  const destination = join(RECONCILIATION_DIR, ...archiveRecord(record).split("/"));
  assertContained(RECONCILIATION_DIR, destination);
  try {
    publishBytesNoClobber(directory, destination, raw);
  } catch (error) {
    if (errorCode(error) !== "EEXIST" || !validArchive(destination, record.sha256))
      throw new Error(`archive collision for ${record.filename}`);
    fsyncDirectory(directory);
  }
  retireClaimedSource(physicalPath, claim);
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
      const record = classify(candidate.area, join(QUEUE_DIR, candidate.filename), candidate.raw);
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
    let claimResult: ClaimResult | GenerationClaimResult;
    try {
      claimResult = candidate.generationId
        ? acquireGenerationClaim(
            "reconcile",
            candidate.generationId,
            candidate.path,
            candidate.claimSha256,
            candidate.filename,
            candidate.physicalArea === "pending" ? candidate.physicalFilename : undefined,
          )
        : acquireClaim(
            "reconcile",
            candidate.physicalArea,
            candidate.physicalFilename,
            candidate.path,
            candidate.claimSha256,
            candidate.filename,
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
    const claims = "claims" in claimResult ? claimResult.claims : { generation: claimResult.claim };
    const claim = claims.generation;
    let record: RecordInfo | undefined;
    let handledError: unknown;
    let fatalError: unknown;
    try {
      if (candidate.deterministicTerminal && candidate.generationId) {
        if (strictTerminalEvidenceAtPath(candidate.path, candidate.raw) !== "exact")
          throw new Error(`invalid deterministic terminal evidence: ${candidate.physicalFilename}`);
        if (generationHasPredecessor(candidate.generationId)) {
          remaining += 1;
          continue;
        }
      }
      if (candidate.generationId && !candidate.deterministicTerminal) {
        const retryPredecessor = directoryEntries(RETRY_DIR).some((entry) =>
          entry.name.startsWith(`${candidate.generationId}--attempt-`),
        );
        if (retryPredecessor) {
          remaining += 1;
          continue;
        }
        const terminal = terminalEvidence(
          candidate.filename,
          candidate.generationId,
          candidate.raw,
        );
        if (terminal === "different")
          throw new Error(`terminal failed evidence collision for ${candidate.filename}`);
        if (terminal === "exact") {
          remaining += 1;
          continue;
        }
      }
      if (candidate.physicalArea === "frozen") {
        synchronizePrivateEnvelope(candidate.path, claim.snapshot.raw);
        const ready = exactReadyDuplicate(
          candidate.filename,
          candidate.raw,
          candidate.generationId!,
        );
        if (ready) retireExactOrThrow(ready.path, ready.snapshot, claim);
      }
      record = classify(candidate.area, join(QUEUE_DIR, candidate.filename), candidate.raw);
      const existing = readOutcome(record, true);
      if (existing) {
        already += 1;
        archive(record, existing, claim, candidate.path, candidate.raw);
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
      archive(record, manifest, claim, candidate.path, candidate.raw);
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
      if (fatalError !== undefined) releaseGenerationClaims(claims, fatalError);
      else releaseGenerationClaims(claims, handledError, false);
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

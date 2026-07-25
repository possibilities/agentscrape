import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { convertHtml } from "./html";

const PREPARATION_PREFIX = ".agentscrape-html-prepare-";
const TRANSACTION_PREFIX = ".agentscrape-html-retire-";
const CLEANUP_PREFIX = ".agentscrape-html-cleanup-";
const LOCK_NAME = ".agentscrape-html-convert.lock";
const LOCK_OWNER_PREFIX = ".agentscrape-html-lock-owner-";
const LOCK_QUARANTINE_PREFIX = ".agentscrape-html-lock-quarantine-";
const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 1024;
const MANIFEST_NAME = "manifest.json";
const OUTPUT_NAME = "output";
const RETIRED_NAME = "retired-source";
const CAPTURED_NAME = "captured-destination";
const COMMIT_NAME = "committed";
const COMMIT_PENDING_NAME = "committed.pending";
const COMMIT_CONTENT = "committed\n";
const CLEANUP_NAME = "cleanup-ready";
const CLEANUP_PENDING_NAME = "cleanup-ready.pending";
const CLEANUP_CONTENT = "cleanup-v1\n";
const MAX_MANIFEST_BYTES = 4096;
const UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_ARTIFACTS = new Set([
  MANIFEST_NAME,
  OUTPUT_NAME,
  RETIRED_NAME,
  CAPTURED_NAME,
  COMMIT_NAME,
  COMMIT_PENDING_NAME,
  CLEANUP_NAME,
  CLEANUP_PENDING_NAME,
]);
const PREPARATION_ARTIFACTS = new Set([
  MANIFEST_NAME,
  OUTPUT_NAME,
  CLEANUP_NAME,
  CLEANUP_PENDING_NAME,
]);
const CLEANUP_ARTIFACTS = new Set([MANIFEST_NAME, OUTPUT_NAME, COMMIT_NAME, CLEANUP_NAME]);

export type HtmlConversionTransactionPhase =
  | "afterPreparationDirectoryCreation"
  | "afterPreparationOutputCreation"
  | "afterPreparationOutputWrite"
  | "afterPreparationManifestCreation"
  | "afterPreparationManifestWrite"
  | "afterPreparationFilesSync"
  | "afterPreparationReadyModeTransition"
  | "afterPreparationTransition"
  | "transactionPrepared"
  | "beforeDestinationLink"
  | "afterDestinationLink"
  | "beforeSourceRetirement"
  | "beforeSourceRetirementRename"
  | "afterSourceRetirementRename"
  | "afterSourceRetirementTargetSync"
  | "afterSourceRetirement"
  | "beforeDestinationCaptureRename"
  | "afterDestinationCaptureRename"
  | "afterDestinationCaptureTargetSync"
  | "afterDestinationCapture"
  | "beforeRollbackDestinationQuarantineRename"
  | "afterRollbackDestinationQuarantineRename"
  | "afterRollbackDestinationQuarantineTargetSync"
  | "beforeCommit"
  | "afterCommitPendingCreation"
  | "afterCommitPendingWrite"
  | "afterCommitMarkerLink"
  | "afterCommitPendingRemoval"
  | "afterDurableCommit"
  | "afterCleanupPendingCreation"
  | "afterCleanupPendingWrite"
  | "afterCleanupMarkerLink"
  | "afterCleanupPendingRemoval"
  | "afterCleanupMarker"
  | "afterCleanupTransition"
  | "afterPreparationCleanupModeTransition"
  | "afterCleanupManifestRemoval"
  | "afterCleanupOutputRemoval"
  | "afterCleanupCommitRemoval"
  | "afterCleanupMarkerRemoval";

export interface HtmlConversionTransactionContext {
  source: string;
  destination: string;
  preparationDirectory: string;
  transactionDirectory: string;
  cleanupDirectory: string;
  manifest: string;
  output: string;
  retiredSource: string;
  capturedDestination: string;
  commitMarker: string;
  cleanupMarker: string;
}

export type HtmlConversionTransactionHook = (
  phase: HtmlConversionTransactionPhase,
  context: Readonly<HtmlConversionTransactionContext>,
) => void;

interface Identity {
  device: string;
  inode: string;
  size: string;
}

interface LockMetadata {
  version: 1;
  pid: number;
  token: string;
  owner: string;
  rootDevice: string;
  rootInode: string;
}

interface DirectoryLock {
  root: string;
  fixedPath: string;
  ownerPath: string;
  metadata: LockMetadata;
  inode: Identity;
}

interface Manifest extends Identity {
  version: 1;
  source: string;
  destination: string;
  digest: string;
  outputDevice: string;
  outputInode: string;
  outputSize: string;
  outputDigest: string;
}

interface OpenSource {
  descriptor: number;
  identity: Identity;
  metadata: StableMetadata;
  bytes: Buffer;
  digest: string;
}

interface StableMetadata {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function statMaybe(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Node has no conditional rename/no-replace primitive. A residual same-user insertion between this
 * absence check and rename is part of that already documented limitation; the private mode-0700 UUID
 * transaction namespace minimizes it. Do not emulate source retirement with link+unlink: that would
 * reopen the public-source replacement deletion race ASR-14 exists to close.
 */
function requirePrivateRenameTargetAbsent(path: string, label: string): void {
  if (statMaybe(path) !== null) throw new Error(`${label} already exists: ${path}`);
}

function identity(stat: BigIntStats): Identity {
  return { device: `${stat.dev}`, inode: `${stat.ino}`, size: `${stat.size}` };
}

function sameInode(stat: BigIntStats, expected: Pick<Identity, "device" | "inode">): boolean {
  return `${stat.dev}` === expected.device && `${stat.ino}` === expected.inode;
}

function sameIdentity(stat: BigIntStats, expected: Identity): boolean {
  return sameInode(stat, expected) && `${stat.size}` === expected.size;
}

function metadata(stat: BigIntStats): StableMetadata {
  return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameMetadata(stat: BigIntStats, expected: StableMetadata): boolean {
  return (
    stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs
  );
}

function regular(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDescriptorExactly(descriptor: number, size: bigint): Buffer {
  if (size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("HTML input is too large to read safely");
  const length = Number(size);
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, offset);
    if (count === 0) throw new Error("HTML input shrank while being read");
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(descriptor, extra, 0, 1, length) !== 0)
    throw new Error("HTML input grew while being read");
  return bytes;
}

/**
 * A positioned descriptor read bracketed by both descriptor and path checks. Comparing nanosecond
 * metadata as well as the digest detects same-inode/same-size rewrites and writes during the read.
 */
function readStablePathDescriptor(
  path: string,
  descriptor: number,
  expected: Identity,
  expectedMetadata: StableMetadata | null,
): Buffer {
  const pathBefore = lstatSync(path, { bigint: true });
  const descriptorBefore = fstatSync(descriptor, { bigint: true });
  if (
    !regular(pathBefore) ||
    !regular(descriptorBefore) ||
    !sameIdentity(pathBefore, expected) ||
    !sameIdentity(descriptorBefore, expected) ||
    (expectedMetadata !== null &&
      (!sameMetadata(pathBefore, expectedMetadata) ||
        !sameMetadata(descriptorBefore, expectedMetadata)))
  ) {
    throw new Error(`HTML input changed while being validated: ${path}`);
  }

  const bracketMetadata = metadata(descriptorBefore);
  const bytes = readDescriptorExactly(descriptor, descriptorBefore.size);
  const descriptorAfter = fstatSync(descriptor, { bigint: true });
  const pathAfter = lstatSync(path, { bigint: true });
  if (
    !regular(descriptorAfter) ||
    !regular(pathAfter) ||
    !sameIdentity(descriptorAfter, expected) ||
    !sameIdentity(pathAfter, expected) ||
    !sameMetadata(descriptorAfter, bracketMetadata) ||
    !sameMetadata(pathAfter, bracketMetadata)
  ) {
    throw new Error(`HTML input changed during validation: ${path}`);
  }
  return bytes;
}

function openSource(path: string): OpenSource {
  const before = lstatSync(path, { bigint: true });
  if (!regular(before)) throw new Error(`HTML input must be a regular file: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const expected = identity(before);
    const expectedMetadata = metadata(before);
    if (
      !regular(opened) ||
      !sameIdentity(opened, expected) ||
      !sameMetadata(opened, expectedMetadata)
    )
      throw new Error(`HTML input changed while being opened: ${path}`);
    const bytes = readStablePathDescriptor(path, descriptor, expected, expectedMetadata);
    return {
      descriptor,
      identity: expected,
      metadata: expectedMetadata,
      bytes,
      digest: digest(bytes),
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function validatePublicSource(path: string, source: OpenSource): void {
  const bytes = readStablePathDescriptor(path, source.descriptor, source.identity, source.metadata);
  if (digest(bytes) !== source.digest) throw new Error(`HTML input content changed: ${path}`);
}

function validateRetiredSource(path: string, source: OpenSource): void {
  const before = lstatSync(path, { bigint: true });
  if (!regular(before) || !sameIdentity(before, source.identity))
    throw new Error(`Retired HTML input is not the opened generation: ${path}`);
  const bytes = readStablePathDescriptor(
    path,
    source.descriptor,
    source.identity,
    metadata(before),
  );
  if (digest(bytes) !== source.digest)
    throw new Error(`Retired HTML input content changed: ${path}`);
}

/** Read one regular file without following a final-component symlink. */
export function readRegularFileNoFollow(path: string): string {
  const source = openSource(path);
  try {
    return source.bytes.toString("utf8");
  } finally {
    closeSync(source.descriptor);
  }
}

function strictMode(stat: BigIntStats, mode: bigint): boolean {
  return (stat.mode & 0o777n) === mode;
}

function ownedTransactionArtifact(stat: BigIntStats): boolean {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function assertPrivateDirectory(path: string, mode: bigint): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !strictMode(stat, mode) ||
    !ownedTransactionArtifact(stat)
  ) {
    throw new Error(`Unsafe HTML transaction directory: ${path}`);
  }
  return stat;
}

function assertPrivateTransactionDirectory(path: string): void {
  assertPrivateDirectory(path, 0o700n);
}

function assertStrictRegular(path: string, mode: bigint): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!regular(stat) || !strictMode(stat, mode) || !ownedTransactionArtifact(stat))
    throw new Error(`Unsafe HTML transaction artifact: ${path}`);
  return stat;
}

function writeStrictFile(
  path: string,
  content: string | Buffer,
  afterCreation?: () => void,
  afterWrite?: () => void,
): BigIntStats {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    afterCreation?.();
    writeFileSync(descriptor, content);
    afterWrite?.();
    fsyncSync(descriptor);
    return fstatSync(descriptor, { bigint: true });
  } finally {
    closeSync(descriptor);
  }
}

function transactionContext(
  directory: string,
  source: string,
  destination: string,
): HtmlConversionTransactionContext {
  const suffix = randomUUID();
  const transactionDirectory = join(directory, `${TRANSACTION_PREFIX}${suffix}`);
  return {
    source,
    destination,
    preparationDirectory: join(directory, `${PREPARATION_PREFIX}${suffix}`),
    transactionDirectory,
    cleanupDirectory: join(directory, `${CLEANUP_PREFIX}${suffix}`),
    manifest: join(transactionDirectory, MANIFEST_NAME),
    output: join(transactionDirectory, OUTPUT_NAME),
    retiredSource: join(transactionDirectory, RETIRED_NAME),
    capturedDestination: join(transactionDirectory, CAPTURED_NAME),
    commitMarker: join(transactionDirectory, COMMIT_NAME),
    cleanupMarker: join(transactionDirectory, CLEANUP_NAME),
  };
}

function validateBasename(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 255 ||
    value.includes("\0") ||
    basename(value) !== value
  ) {
    throw new Error(`Invalid HTML transaction ${field}`);
  }
  return value;
}

function parseManifest(content: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Invalid HTML transaction manifest JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid HTML transaction manifest");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "destination",
    "device",
    "digest",
    "inode",
    "outputDevice",
    "outputDigest",
    "outputInode",
    "outputSize",
    "size",
    "source",
    "version",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    throw new Error("Invalid HTML transaction manifest fields");
  if (record.version !== 1) throw new Error("Unsupported HTML transaction manifest version");
  const source = validateBasename(record.source, "source");
  const destination = validateBasename(record.destination, "destination");
  const extension = extname(source);
  if (
    ![".html", ".htm"].includes(extension.toLowerCase()) ||
    destination !== `${source.slice(0, -extension.length)}.md`
  ) {
    throw new Error("Invalid HTML transaction source/destination pair");
  }
  const decimal = /^(?:0|[1-9][0-9]*)$/;
  const hexadecimal = /^[0-9a-f]{64}$/;
  for (const field of ["device", "inode", "size", "outputDevice", "outputInode", "outputSize"])
    if (typeof record[field] !== "string" || !decimal.test(record[field]))
      throw new Error(`Invalid HTML transaction ${field}`);
  for (const field of ["digest", "outputDigest"])
    if (typeof record[field] !== "string" || !hexadecimal.test(record[field]))
      throw new Error(`Invalid HTML transaction ${field}`);
  return {
    version: 1,
    source,
    destination,
    device: record.device as string,
    inode: record.inode as string,
    size: record.size as string,
    digest: record.digest as string,
    outputDevice: record.outputDevice as string,
    outputInode: record.outputInode as string,
    outputSize: record.outputSize as string,
    outputDigest: record.outputDigest as string,
  };
}

function readStrictBounded(
  path: string,
  maximumBytes: number,
): { stat: BigIntStats; text: string } {
  const stat = assertStrictRegular(path, 0o600n);
  if (stat.size > BigInt(maximumBytes))
    throw new Error(`HTML transaction artifact is too large: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = readStablePathDescriptor(path, descriptor, identity(stat), metadata(stat));
    return { stat, text: bytes.toString("utf8") };
  } finally {
    closeSync(descriptor);
  }
}

function canonicalLockContent(metadata: LockMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

function parseLockMetadata(
  content: string,
  rootIdentity: Pick<Identity, "device" | "inode">,
): LockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Invalid HTML conversion lock JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid HTML conversion lock");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["owner", "pid", "rootDevice", "rootInode", "token", "version"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    throw new Error("Invalid HTML conversion lock fields");
  if (record.version !== LOCK_VERSION) throw new Error("Unsupported HTML conversion lock version");
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0)
    throw new Error("Invalid HTML conversion lock PID");
  if (typeof record.token !== "string" || !UUID_SUFFIX.test(record.token))
    throw new Error("Invalid HTML conversion lock token");
  if (record.owner !== `${LOCK_OWNER_PREFIX}${record.token}`)
    throw new Error("Invalid HTML conversion lock owner name");
  const decimal = /^(?:0|[1-9][0-9]*)$/;
  if (
    typeof record.rootDevice !== "string" ||
    !decimal.test(record.rootDevice) ||
    typeof record.rootInode !== "string" ||
    !decimal.test(record.rootInode)
  )
    throw new Error("Invalid HTML conversion lock root identity");
  if (record.rootDevice !== rootIdentity.device || record.rootInode !== rootIdentity.inode)
    throw new Error("HTML conversion lock belongs to a different root generation");
  const metadata: LockMetadata = {
    version: 1,
    pid: record.pid as number,
    token: record.token,
    owner: record.owner,
    rootDevice: record.rootDevice,
    rootInode: record.rootInode,
  };
  if (content !== canonicalLockContent(metadata))
    throw new Error("HTML conversion lock is not canonically encoded");
  return metadata;
}

function readLockFile(
  path: string,
  rootIdentity: Pick<Identity, "device" | "inode">,
): { stat: BigIntStats; metadata: LockMetadata } {
  let read: { stat: BigIntStats; text: string };
  try {
    read = readStrictBounded(path, MAX_LOCK_BYTES);
  } catch (error) {
    throw new Error(`Unsafe HTML conversion lock artifact: ${path}`, { cause: error });
  }
  return { stat: read.stat, metadata: parseLockMetadata(read.text, rootIdentity) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    // EPERM proves that a process occupies the PID even though we may not signal it. PID reuse is
    // deliberately treated the same way: availability is sacrificed rather than stealing a lock
    // from an unrelated live process that inherited a crashed owner's PID.
    if (errorCode(error) === "EPERM") return true;
    throw new Error(`Could not determine HTML conversion lock owner PID ${pid}`, { cause: error });
  }
}

function validateClaim(
  root: string,
  fixedPath: string,
  rootIdentity: Pick<Identity, "device" | "inode">,
): { stat: BigIntStats; metadata: LockMetadata; ownerPath: string } {
  const claim = readLockFile(fixedPath, rootIdentity);
  const ownerPath = join(root, claim.metadata.owner);
  let owner: { stat: BigIntStats; metadata: LockMetadata };
  try {
    owner = readLockFile(ownerPath, rootIdentity);
  } catch (error) {
    throw new Error("HTML conversion lock has no valid canonical owner file", { cause: error });
  }
  if (
    !sameInode(owner.stat, identity(claim.stat)) ||
    canonicalLockContent(owner.metadata) !== canonicalLockContent(claim.metadata)
  )
    throw new Error("HTML conversion lock claim and owner identities differ");
  return { ...claim, ownerPath };
}

function unlinkOwnedLockPath(path: string, expected: Identity, metadata: LockMetadata): void {
  const current = readLockFile(path, {
    device: metadata.rootDevice,
    inode: metadata.rootInode,
  });
  if (
    !sameInode(current.stat, expected) ||
    canonicalLockContent(current.metadata) !== canonicalLockContent(metadata)
  )
    throw new Error(`HTML conversion lock artifact changed before removal: ${path}`);
  unlinkSync(path);
}

function removeUnclaimedOwner(lock: DirectoryLock): void {
  if (statMaybe(lock.ownerPath) === null) return;
  unlinkOwnedLockPath(lock.ownerPath, lock.inode, lock.metadata);
  syncDirectory(lock.root);
}

/** While holding the fixed claim, remove only canonical, validated artifacts whose PID is dead. */
function cleanDeadLockDebris(lock: DirectoryLock): void {
  let removed = false;
  for (const name of readdirSync(lock.root)) {
    const ownerSuffix = name.startsWith(LOCK_OWNER_PREFIX)
      ? name.slice(LOCK_OWNER_PREFIX.length)
      : null;
    const quarantineSuffix = name.startsWith(LOCK_QUARANTINE_PREFIX)
      ? name.slice(LOCK_QUARANTINE_PREFIX.length)
      : null;
    if (
      (ownerSuffix === null || !UUID_SUFFIX.test(ownerSuffix)) &&
      (quarantineSuffix === null || !UUID_SUFFIX.test(quarantineSuffix))
    )
      continue;
    if (name === lock.metadata.owner) continue;
    const path = join(lock.root, name);
    try {
      const artifact = readLockFile(path, {
        device: lock.metadata.rootDevice,
        inode: lock.metadata.rootInode,
      });
      if (ownerSuffix !== null && artifact.metadata.owner !== name) continue;
      if (processIsAlive(artifact.metadata.pid)) continue;
      unlinkOwnedLockPath(path, identity(artifact.stat), artifact.metadata);
      removed = true;
    } catch {
      // Malformed, foreign, symlinked, replaced, and live/PID-reused evidence is preserved.
    }
  }
  if (removed) syncDirectory(lock.root);
}

function reclaimDeadClaim(
  root: string,
  fixedPath: string,
  observed: { stat: BigIntStats; metadata: LockMetadata },
): void {
  const quarantinePath = join(root, `${LOCK_QUARANTINE_PREFIX}${randomUUID()}`);
  requirePrivateRenameTargetAbsent(quarantinePath, "HTML conversion lock quarantine");
  renameSync(fixedPath, quarantinePath);
  let quarantined: { stat: BigIntStats; metadata: LockMetadata };
  try {
    quarantined = readLockFile(quarantinePath, {
      device: observed.metadata.rootDevice,
      inode: observed.metadata.rootInode,
    });
  } catch (error) {
    throw new Error("HTML conversion lock changed during dead-owner quarantine", { cause: error });
  }
  if (
    !sameInode(quarantined.stat, identity(observed.stat)) ||
    canonicalLockContent(quarantined.metadata) !== canonicalLockContent(observed.metadata)
  ) {
    // Another reclaimer may have installed a live claim after our observation. Restore that exact
    // quarantined inode under the fixed name with a no-clobber link; never delete it as stale.
    try {
      linkSync(quarantinePath, fixedPath);
      syncDirectory(root);
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw new Error("Replaced HTML conversion lock could not be restored", { cause: error });
    }
    throw new Error("HTML conversion lock changed during dead-owner reclaim; evidence preserved");
  }
  unlinkOwnedLockPath(quarantinePath, identity(observed.stat), observed.metadata);
  syncDirectory(root);
}

function acquireDirectoryLock(root: string, rootStat: BigIntStats): DirectoryLock {
  const rootIdentity = identity(rootStat);
  const fixedPath = join(root, LOCK_NAME);
  const token = randomUUID();
  const metadata: LockMetadata = {
    version: 1,
    pid: process.pid,
    token,
    owner: `${LOCK_OWNER_PREFIX}${token}`,
    rootDevice: rootIdentity.device,
    rootInode: rootIdentity.inode,
  };
  const ownerPath = join(root, metadata.owner);
  const ownerStat = writeStrictFile(ownerPath, canonicalLockContent(metadata));
  const lock: DirectoryLock = {
    root,
    fixedPath,
    ownerPath,
    metadata,
    inode: identity(ownerStat),
  };
  syncDirectory(root);
  let claimed = false;

  try {
    for (;;) {
      try {
        linkSync(ownerPath, fixedPath);
        claimed = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        let observed: ReturnType<typeof validateClaim>;
        try {
          observed = validateClaim(root, fixedPath, rootIdentity);
        } catch (claimError) {
          throw new Error(`Unsafe occupied HTML conversion lock: ${fixedPath}`, {
            cause: claimError,
          });
        }
        if (processIsAlive(observed.metadata.pid))
          throw new Error(
            `Active HTML conversion already holds directory lock: ${root} (pid ${observed.metadata.pid})`,
          );
        reclaimDeadClaim(root, fixedPath, observed);
        continue;
      }

      syncDirectory(root);
      const claim = validateClaim(root, fixedPath, rootIdentity);
      if (
        !sameInode(claim.stat, lock.inode) ||
        canonicalLockContent(claim.metadata) !== canonicalLockContent(metadata)
      )
        throw new Error("HTML conversion lock ownership changed during acquisition");
      cleanDeadLockDebris(lock);
      return lock;
    }
  } catch (primary) {
    const secondary: unknown[] = [];
    try {
      if (claimed) releaseDirectoryLock(lock);
      else removeUnclaimedOwner(lock);
    } catch (error) {
      secondary.push(error);
    }
    attachSecondary(primary, secondary, "HTML conversion lock acquisition cleanup");
  }
}

function releaseDirectoryLock(lock: DirectoryLock): void {
  const claim = validateClaim(lock.root, lock.fixedPath, {
    device: lock.metadata.rootDevice,
    inode: lock.metadata.rootInode,
  });
  if (
    !sameInode(claim.stat, lock.inode) ||
    canonicalLockContent(claim.metadata) !== canonicalLockContent(lock.metadata)
  )
    throw new Error("HTML conversion lock ownership changed before release");
  unlinkOwnedLockPath(lock.fixedPath, lock.inode, lock.metadata);
  syncDirectory(lock.root);
  unlinkOwnedLockPath(lock.ownerPath, lock.inode, lock.metadata);
  syncDirectory(lock.root);
}

function readManifest(path: string): Manifest {
  return parseManifest(readStrictBounded(path, MAX_MANIFEST_BYTES).text);
}

function validateOutput(path: string, manifest: Manifest): BigIntStats {
  const expected: Identity = {
    device: manifest.outputDevice,
    inode: manifest.outputInode,
    size: manifest.outputSize,
  };
  const before = assertStrictRegular(path, 0o600n);
  if (!sameIdentity(before, expected))
    throw new Error(`HTML transaction output identity changed: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = readStablePathDescriptor(path, descriptor, expected, metadata(before));
    if (digest(bytes) !== manifest.outputDigest)
      throw new Error(`HTML transaction output content changed: ${path}`);
  } finally {
    closeSync(descriptor);
  }
  return before;
}

function assertExpectedArtifacts(path: string, expected: ReadonlySet<string>): string[] {
  assertPrivateTransactionDirectory(path);
  const names = readdirSync(path);
  for (const name of names)
    if (!expected.has(name))
      throw new Error(`Unexpected HTML transaction artifact: ${join(path, name)}`);
  return names;
}

function validateStrictMarker(path: string, content: string, label: string): BigIntStats {
  const marker = assertStrictRegular(path, 0o600n);
  if (readStrictBounded(path, Buffer.byteLength(content)).text !== content)
    throw new Error(`Invalid HTML transaction ${label}: ${path}`);
  return marker;
}

type MarkerKind = "commit" | "cleanup";

function markerPaths(
  directory: string,
  kind: MarkerKind,
): { finalPath: string; pendingPath: string; content: string; label: string } {
  const commit = kind === "commit";
  return {
    finalPath: join(directory, commit ? COMMIT_NAME : CLEANUP_NAME),
    pendingPath: join(directory, commit ? COMMIT_PENDING_NAME : CLEANUP_PENDING_NAME),
    content: commit ? COMMIT_CONTENT : CLEANUP_CONTENT,
    label: commit ? "commit marker" : "cleanup marker",
  };
}

/**
 * Resolve the fixed pending-name marker protocol. A malformed final marker is always fatal. A lone
 * malformed pending marker has no authority and is removed, leaving the transaction pre-marker.
 */
function repairMarker(directory: string, kind: MarkerKind, synchronizeDirectory = true): boolean {
  const { finalPath, pendingPath, content, label } = markerPaths(directory, kind);
  const final = statMaybe(finalPath);
  const pending = statMaybe(pendingPath);
  if (final !== null) {
    const finalMarker = validateStrictMarker(finalPath, content, label);
    if (pending !== null) {
      const pendingMarker = validateStrictMarker(pendingPath, content, `${label} pending artifact`);
      if (!sameInode(pendingMarker, identity(finalMarker)))
        throw new Error(`HTML transaction ${label} pending identity differs from final marker`);
      unlinkSync(pendingPath);
      if (synchronizeDirectory) syncDirectory(directory);
    }
    return true;
  }
  if (pending === null) return false;

  let pendingMarker: BigIntStats;
  try {
    pendingMarker = validateStrictMarker(pendingPath, content, `${label} pending artifact`);
  } catch {
    // A pending artifact is deliberately non-authoritative until it has complete valid contents.
    // Only its exact fixed private name is removed.
    unlinkSync(pendingPath);
    if (synchronizeDirectory) syncDirectory(directory);
    return false;
  }

  // A crash after the write hook may leave complete bytes that were not yet file-fsynced. Recovery
  // must make those validated bytes durable before allowing their inode to acquire the final name.
  const descriptor = openSync(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, identity(pendingMarker)))
      throw new Error(`HTML transaction ${label} pending identity changed before recovery`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const pendingAfterSync = lstatSync(pendingPath, { bigint: true });
  if (!sameIdentity(pendingAfterSync, identity(pendingMarker)))
    throw new Error(`HTML transaction ${label} pending identity changed during recovery`);

  try {
    linkSync(pendingPath, finalPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const finalMarker = validateStrictMarker(finalPath, content, label);
  pendingMarker = validateStrictMarker(pendingPath, content, `${label} pending artifact`);
  if (!sameInode(pendingMarker, identity(finalMarker)))
    throw new Error(`HTML transaction ${label} publication identity changed`);
  if (synchronizeDirectory) syncDirectory(directory);
  unlinkSync(pendingPath);
  if (synchronizeDirectory) syncDirectory(directory);
  return true;
}

function publishMarker(
  directory: string,
  context: HtmlConversionTransactionContext,
  kind: MarkerKind,
  hook?: HtmlConversionTransactionHook,
  synchronizeDirectory = true,
): void {
  if (repairMarker(directory, kind, synchronizeDirectory)) return;
  const { finalPath, pendingPath, content } = markerPaths(directory, kind);
  const phasePrefix = kind === "commit" ? "Commit" : "Cleanup";
  const descriptor = openSync(
    pendingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    hook?.(`after${phasePrefix}PendingCreation` as HtmlConversionTransactionPhase, context);
    writeFileSync(descriptor, content);
    hook?.(`after${phasePrefix}PendingWrite` as HtmlConversionTransactionPhase, context);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  linkSync(pendingPath, finalPath);
  hook?.(`after${phasePrefix}MarkerLink` as HtmlConversionTransactionPhase, context);
  if (synchronizeDirectory) syncDirectory(directory);
  const finalMarker = validateStrictMarker(
    finalPath,
    content,
    kind === "commit" ? "commit marker" : "cleanup marker",
  );
  const pendingMarker = validateStrictMarker(pendingPath, content, "pending marker artifact");
  if (!sameInode(pendingMarker, identity(finalMarker)))
    throw new Error("HTML transaction marker publication identity changed");
  unlinkSync(pendingPath);
  hook?.(`after${phasePrefix}PendingRemoval` as HtmlConversionTransactionPhase, context);
  if (synchronizeDirectory) syncDirectory(directory);
}

function validateTransactionSurface(context: HtmlConversionTransactionContext): Manifest {
  assertExpectedArtifacts(context.transactionDirectory, TRANSACTION_ARTIFACTS);
  const manifest = readManifest(context.manifest);
  if (
    manifest.source !== basename(context.source) ||
    manifest.destination !== basename(context.destination)
  ) {
    throw new Error(
      `HTML transaction paths do not match their directory: ${context.transactionDirectory}`,
    );
  }
  validateOutput(context.output, manifest);
  const retired = statMaybe(context.retiredSource);
  if (retired !== null && !regular(retired))
    throw new Error(`Unsafe retired HTML transaction source: ${context.retiredSource}`);
  const captured = statMaybe(context.capturedDestination);
  if (
    captured !== null &&
    sameInode(captured, {
      device: manifest.outputDevice,
      inode: manifest.outputInode,
    }) &&
    !regular(captured)
  )
    throw new Error(`Unsafe captured HTML transaction output: ${context.capturedDestination}`);
  if (statMaybe(context.commitMarker) !== null)
    validateStrictMarker(context.commitMarker, COMMIT_CONTENT, "commit marker");
  if (statMaybe(context.cleanupMarker) !== null)
    validateStrictMarker(context.cleanupMarker, CLEANUP_CONTENT, "cleanup marker");
  return manifest;
}

function contextFromManifestDirectory(
  directory: string,
  transactionDirectory: string,
): {
  context: HtmlConversionTransactionContext;
  manifest: Manifest;
} {
  assertExpectedArtifacts(transactionDirectory, TRANSACTION_ARTIFACTS);
  const manifestPath = join(transactionDirectory, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);
  const suffix = basename(transactionDirectory).slice(TRANSACTION_PREFIX.length);
  const context: HtmlConversionTransactionContext = {
    source: join(directory, manifest.source),
    destination: join(directory, manifest.destination),
    preparationDirectory: join(directory, `${PREPARATION_PREFIX}${suffix}`),
    transactionDirectory,
    cleanupDirectory: join(directory, `${CLEANUP_PREFIX}${suffix}`),
    manifest: manifestPath,
    output: join(transactionDirectory, OUTPUT_NAME),
    retiredSource: join(transactionDirectory, RETIRED_NAME),
    capturedDestination: join(transactionDirectory, CAPTURED_NAME),
    commitMarker: join(transactionDirectory, COMMIT_NAME),
    cleanupMarker: join(transactionDirectory, CLEANUP_NAME),
  };
  validateTransactionSurface(context);
  return { context, manifest };
}

function restoreCapturedForeign(
  context: HtmlConversionTransactionContext,
  captured: BigIntStats,
): void {
  const symbolicTarget = captured.isSymbolicLink()
    ? readlinkSync(context.capturedDestination)
    : null;
  const capturedIdentity = identity(captured);
  const capturedDirectory = captured.isDirectory() && !captured.isSymbolicLink();
  const destination = statMaybe(context.destination);

  if (capturedDirectory) {
    if (destination !== null)
      throw new Error("A concurrent destination prevents safe directory restoration");
    // Node exposes no rename-no-replace operation for directories. Check absence again immediately
    // before rename to minimize the namespace race. POSIX rename can still replace a competing empty
    // directory created in that narrow window; the API cannot close that limitation. The inode check
    // immediately afterwards detects a subsequent replacement without deliberately clobbering one.
    if (statMaybe(context.destination) !== null)
      throw new Error("A concurrent destination prevents safe directory restoration");
    try {
      renameSync(context.capturedDestination, context.destination);
    } catch (error) {
      throw new Error("Captured destination directory could not be restored", { cause: error });
    }
    const restored = lstatSync(context.destination, { bigint: true });
    if (!restored.isDirectory() || !sameInode(restored, capturedIdentity))
      throw new Error("Captured destination directory was not restored safely");
    // Persist the public directory name before recording removal of its transaction-side name.
    syncDirectory(resolve(context.destination, ".."));
    syncDirectory(context.transactionDirectory);
    return;
  }

  if (destination === null) {
    try {
      // link(2) may follow a source symlink on some platforms, so reproduce only its link text.
      // For regular files and non-directory special nodes, a hard link is no-clobber and preserves
      // the exact inode when the filesystem supports linking that node type.
      if (symbolicTarget === null) linkSync(context.capturedDestination, context.destination);
      else symlinkSync(symbolicTarget, context.destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        throw new Error("A concurrent destination prevents safe restoration", { cause: error });
      throw error;
    }
    // The replacement public link must be durable before transaction evidence is removed.
    syncDirectory(resolve(context.destination, ".."));
  } else if (
    symbolicTarget === null
      ? !sameInode(destination, capturedIdentity)
      : !destination.isSymbolicLink() || readlinkSync(context.destination) !== symbolicTarget
  ) {
    throw new Error("A concurrent destination prevents safe restoration");
  }
  const restored = lstatSync(context.destination, { bigint: true });
  const safelyRestored =
    symbolicTarget === null
      ? sameInode(restored, capturedIdentity)
      : restored.isSymbolicLink() && readlinkSync(context.destination) === symbolicTarget;
  if (!safelyRestored) throw new Error("Captured destination was not restored safely");
  unlinkSync(context.capturedDestination);
  syncDirectory(context.transactionDirectory);
}

/**
 * Leave a clearly foreign public inode in place. An apparently owned regular inode is still renamed
 * into quarantine before deletion, so a post-check replacement is inspected rather than unlinked by
 * its public name.
 */
function rollbackDestination(
  context: HtmlConversionTransactionContext,
  outputIdentity: Identity,
  hook?: HtmlConversionTransactionHook,
): void {
  const existingCapture = statMaybe(context.capturedDestination);
  if (existingCapture !== null) {
    // This may be the result of a crash immediately after quarantine: finish target-before-source
    // durability before inspecting or removing the captured name.
    syncDirectory(context.transactionDirectory);
    syncDirectory(resolve(context.destination, ".."));
    if (sameInode(existingCapture, outputIdentity)) {
      if (!regular(existingCapture)) throw new Error("Owned captured output is not regular");
      unlinkSync(context.capturedDestination);
      syncDirectory(context.transactionDirectory);
    } else {
      restoreCapturedForeign(context, existingCapture);
      return;
    }
  }

  const publicDestination = statMaybe(context.destination);
  if (publicDestination === null || !sameInode(publicDestination, outputIdentity)) return;
  if (!regular(publicDestination)) throw new Error("Owned public output is not regular");

  hook?.("beforeRollbackDestinationQuarantineRename", context);
  // Recheck even though the preexisting-capture branch above already handled the earlier snapshot.
  requirePrivateRenameTargetAbsent(
    context.capturedDestination,
    "HTML rollback quarantine destination",
  );
  try {
    renameSync(context.destination, context.capturedDestination);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  hook?.("afterRollbackDestinationQuarantineRename", context);
  // A preserving cross-directory rename is recorded at its target before its public source parent.
  syncDirectory(context.transactionDirectory);
  hook?.("afterRollbackDestinationQuarantineTargetSync", context);
  syncDirectory(resolve(context.destination, ".."));
  const captured = lstatSync(context.capturedDestination, { bigint: true });
  if (sameInode(captured, outputIdentity)) {
    if (!regular(captured)) throw new Error("Owned captured output is not regular");
    unlinkSync(context.capturedDestination);
    syncDirectory(context.transactionDirectory);
    return;
  }
  restoreCapturedForeign(context, captured);
}

class MissingSourceEvidenceError extends Error {}

type SourceEvidencePolicy = "live-operation" | "crash-recovery";

function linkRetiredSourceNoClobber(
  context: HtmlConversionTransactionContext,
  retired: BigIntStats,
): void {
  try {
    linkSync(context.retiredSource, context.source);
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      throw new Error("A concurrent source prevents safe restoration", { cause: error });
    throw error;
  }
  syncDirectory(resolve(context.source, ".."));
  const restored = lstatSync(context.source, { bigint: true });
  if (!sameInode(restored, identity(retired)))
    throw new Error("Retired source was not restored safely");
}

/**
 * Prove a source generation by identity and a stable no-follow digest read. Source files are user
 * inputs, not converter-created artifacts, so their uid is deliberately irrelevant.
 */
function validateManifestSourceGeneration(path: string, manifest: Manifest): BigIntStats {
  const source = lstatSync(path, { bigint: true });
  if (!regular(source) || !sameIdentity(source, manifest))
    throw new Error("Source identity cannot be proven from the manifest");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = readStablePathDescriptor(path, descriptor, manifest, metadata(source));
    if (digest(bytes) !== manifest.digest)
      throw new Error("Source content cannot be proven from the manifest");
  } finally {
    closeSync(descriptor);
  }
  return source;
}

/** Resolve source preservation, but retain all evidence whenever its generation is uncertain. */
function restoreRetiredSource(
  context: HtmlConversionTransactionContext,
  manifest: Manifest,
  policy: SourceEvidencePolicy,
): void {
  const retired = statMaybe(context.retiredSource);
  const current = statMaybe(context.source);
  if (retired === null) {
    if (current === null)
      throw new MissingSourceEvidenceError(
        "Public and retired HTML sources are both absent; preserving output evidence",
      );
    if (policy === "crash-recovery") {
      // After a crash there is no open descriptor proving what the public name represents.
      validateManifestSourceGeneration(context.source, manifest);
    } else if (!regular(current)) {
      // The live operation still holds the original descriptor and private output. A concurrently
      // replaced regular public source is preserved while stale publication is rolled back.
      throw new Error("Public HTML source is not a safe regular generation");
    }
    return;
  }

  // This may be the result of a crash immediately after retirement: finish target-before-source
  // durability before deciding whether the generation can be restored.
  syncDirectory(context.transactionDirectory);
  syncDirectory(resolve(context.source, ".."));
  if (!regular(retired)) throw new Error("Retired HTML source is not a safe regular generation");

  let proven = true;
  try {
    validateManifestSourceGeneration(context.retiredSource, manifest);
  } catch {
    proven = false;
  }

  if (!proven) {
    if (current === null) linkRetiredSourceNoClobber(context, retired);
    throw new Error("Retired HTML source differs from the manifest generation");
  }

  if (current === null) linkRetiredSourceNoClobber(context, retired);
  else if (!regular(current) || !sameInode(current, identity(retired)))
    throw new Error("A different public source generation prevents safe restoration");
  else syncDirectory(resolve(context.source, ".."));

  const restored = lstatSync(context.source, { bigint: true });
  if (!sameInode(restored, identity(retired)))
    throw new Error("Retired source was not restored safely");
  // The public link is durable before the retired transaction link is removed.
  unlinkSync(context.retiredSource);
  syncDirectory(context.transactionDirectory);
}

function attachSecondary(primary: unknown, secondary: unknown[], action: string): never {
  if (secondary.length === 0) throw primary;
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  throw new AggregateError(
    [primaryError, ...secondary],
    `${primaryError.message}; ${action} failed`,
    {
      cause: primaryError,
    },
  );
}

function rollbackUncommitted(
  context: HtmlConversionTransactionContext,
  manifest: Manifest,
  destinationMayBeOwned: boolean,
  sourceEvidencePolicy: SourceEvidencePolicy,
  hook?: HtmlConversionTransactionHook,
): void {
  let sourceFailure: unknown = null;
  try {
    restoreRetiredSource(context, manifest, sourceEvidencePolicy);
  } catch (error) {
    sourceFailure = error;
  }

  // With no source copy anywhere, even the public output is preservation evidence.
  if (sourceFailure instanceof MissingSourceEvidenceError) throw sourceFailure;

  const failures: unknown[] = sourceFailure === null ? [] : [sourceFailure];
  if (destinationMayBeOwned || statMaybe(context.capturedDestination) !== null) {
    try {
      rollbackDestination(
        context,
        {
          device: manifest.outputDevice,
          inode: manifest.outputInode,
          size: manifest.outputSize,
        },
        hook,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (sourceFailure === null && failures.length === 0) {
    try {
      transitionToCleanup(context, hook);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "HTML transaction rollback failed");
}

function cleanupContext(
  directory: string,
  cleanupDirectory: string,
): HtmlConversionTransactionContext {
  const suffix = basename(cleanupDirectory).slice(CLEANUP_PREFIX.length);
  const transactionDirectory = join(directory, `${TRANSACTION_PREFIX}${suffix}`);
  return {
    source: "",
    destination: "",
    preparationDirectory: join(directory, `${PREPARATION_PREFIX}${suffix}`),
    transactionDirectory,
    cleanupDirectory,
    manifest: join(transactionDirectory, MANIFEST_NAME),
    output: join(transactionDirectory, OUTPUT_NAME),
    retiredSource: join(transactionDirectory, RETIRED_NAME),
    capturedDestination: join(transactionDirectory, CAPTURED_NAME),
    commitMarker: join(transactionDirectory, COMMIT_NAME),
    cleanupMarker: join(transactionDirectory, CLEANUP_NAME),
  };
}

/** Sweep only an explicitly marked private cleanup directory; this never examines public paths. */
function sweepCleanup(
  directory: string,
  cleanupDirectory: string,
  hook?: HtmlConversionTransactionHook,
  hookContext = cleanupContext(directory, cleanupDirectory),
): void {
  const names = assertExpectedArtifacts(cleanupDirectory, CLEANUP_ARTIFACTS);
  const markerPath = join(cleanupDirectory, CLEANUP_NAME);
  if (!names.includes(CLEANUP_NAME)) {
    if (names.length !== 0)
      throw new Error(
        `Unmarked HTML cleanup directory is not an empty tombstone: ${cleanupDirectory}`,
      );
    rmdirSync(cleanupDirectory);
    syncDirectory(directory);
    return;
  }
  validateStrictMarker(markerPath, CLEANUP_CONTENT, "cleanup marker");

  // Validate the complete private surface before deleting any part of it.
  for (const name of names) {
    if (name !== CLEANUP_NAME) assertStrictRegular(join(cleanupDirectory, name), 0o600n);
  }
  const removals: ReadonlyArray<readonly [string, HtmlConversionTransactionPhase]> = [
    [MANIFEST_NAME, "afterCleanupManifestRemoval"],
    [OUTPUT_NAME, "afterCleanupOutputRemoval"],
    [COMMIT_NAME, "afterCleanupCommitRemoval"],
  ];
  for (const [name, phase] of removals) {
    const path = join(cleanupDirectory, name);
    if (statMaybe(path) === null) continue;
    unlinkSync(path);
    syncDirectory(cleanupDirectory);
    hook?.(phase, hookContext);
  }
  // Marker-last makes a markerless nonempty cleanup surface malformed, while an empty one is a
  // harmless tombstone after a crash between this unlink and rmdir.
  validateStrictMarker(markerPath, CLEANUP_CONTENT, "cleanup marker");
  unlinkSync(markerPath);
  syncDirectory(cleanupDirectory);
  hook?.("afterCleanupMarkerRemoval", hookContext);
  rmdirSync(cleanupDirectory);
  syncDirectory(directory);
}

function transitionToCleanup(
  context: HtmlConversionTransactionContext,
  hook?: HtmlConversionTransactionHook,
): void {
  const directory = resolve(context.transactionDirectory, "..");
  const before = lstatSync(context.transactionDirectory, { bigint: true });
  assertExpectedArtifacts(context.transactionDirectory, TRANSACTION_ARTIFACTS);
  if (statMaybe(context.retiredSource) !== null || statMaybe(context.capturedDestination) !== null)
    throw new Error("HTML transaction still contains preservation evidence");

  publishMarker(context.transactionDirectory, context, "cleanup", hook);
  hook?.("afterCleanupMarker", context);

  const beforeRename = lstatSync(context.transactionDirectory, { bigint: true });
  if (!sameInode(beforeRename, identity(before)))
    throw new Error("HTML transaction directory identity changed before cleanup transition");
  if (statMaybe(context.cleanupDirectory) !== null)
    throw new Error(`HTML cleanup destination already exists: ${context.cleanupDirectory}`);
  renameSync(context.transactionDirectory, context.cleanupDirectory);
  syncDirectory(directory);
  hook?.("afterCleanupTransition", context);
  sweepCleanup(directory, context.cleanupDirectory, hook, context);
}

function finalizeCommitted(
  context: HtmlConversionTransactionContext,
  manifest: Manifest,
  hook?: HtmlConversionTransactionHook,
): void {
  repairMarker(context.transactionDirectory, "commit");
  repairMarker(context.transactionDirectory, "cleanup");
  validateTransactionSurface(context);
  const marker = validateStrictMarker(context.commitMarker, COMMIT_CONTENT, "commit marker");
  const output = validateOutput(context.output, manifest);
  const destination = lstatSync(context.destination, { bigint: true });
  if (!regular(destination) || !sameInode(destination, identity(output)))
    throw new Error("Committed destination no longer matches retained output");
  if (statMaybe(context.capturedDestination) !== null)
    throw new Error("Committed transaction contains captured destination evidence");
  if (statMaybe(context.retiredSource) !== null) {
    validateManifestSourceGeneration(context.retiredSource, manifest);
    // An already-open uncooperative writable descriptor can mutate the retired inode after this
    // final digest. POSIX provides neither a mandatory lock nor a conditional unlink; this point
    // defines generation selection for such a writer.
    unlinkSync(context.retiredSource);
    syncDirectory(context.transactionDirectory);
  }
  validateOutput(context.output, manifest);
  assertStrictRegular(context.manifest, 0o600n);
  const markerNow = assertStrictRegular(context.commitMarker, 0o600n);
  if (!sameInode(markerNow, identity(marker))) throw new Error("Commit marker identity changed");
  transitionToCleanup(context, hook);
}

function canonicalPreparationSuffix(preparationDirectory: string): string {
  const name = basename(preparationDirectory);
  const suffix = name.slice(PREPARATION_PREFIX.length);
  if (!name.startsWith(PREPARATION_PREFIX) || !UUID_SUFFIX.test(suffix))
    throw new Error(`Unsafe noncanonical HTML preparation directory: ${preparationDirectory}`);
  return suffix;
}

function canonicalCleanupSuffix(cleanupDirectory: string): string {
  const name = basename(cleanupDirectory);
  const suffix = name.slice(CLEANUP_PREFIX.length);
  if (!name.startsWith(CLEANUP_PREFIX) || !UUID_SUFFIX.test(suffix))
    throw new Error(`Unsafe noncanonical HTML cleanup directory: ${cleanupDirectory}`);
  return suffix;
}

function preparationCleanupContext(
  directory: string,
  preparationDirectory: string,
): HtmlConversionTransactionContext {
  const suffix = canonicalPreparationSuffix(preparationDirectory);
  const cleanupDirectory = join(directory, `${CLEANUP_PREFIX}${suffix}`);
  return {
    ...cleanupContext(directory, cleanupDirectory),
    preparationDirectory,
    manifest: join(preparationDirectory, MANIFEST_NAME),
    output: join(preparationDirectory, OUTPUT_NAME),
    cleanupMarker: join(preparationDirectory, CLEANUP_NAME),
  };
}

/** Mode 0300 prevents enumeration, so validate every permitted known path before transition. */
function validateKnownPreparationArtifacts(directory: string): void {
  for (const name of PREPARATION_ARTIFACTS) {
    const path = join(directory, name);
    const artifact = statMaybe(path);
    if (artifact === null) continue;
    const strict = assertStrictRegular(path, 0o600n);
    if (name === MANIFEST_NAME && strict.size > BigInt(MAX_MANIFEST_BYTES))
      throw new Error(`HTML preparation manifest is too large: ${path}`);
    if (name === CLEANUP_NAME) validateStrictMarker(path, CLEANUP_CONTENT, "cleanup marker");
  }
}

function validateEnumerablePreparationArtifacts(
  preparationDirectory: string,
  validatePending = true,
): string[] {
  const names = assertExpectedArtifacts(preparationDirectory, PREPARATION_ARTIFACTS);
  for (const name of names) {
    const path = join(preparationDirectory, name);
    if (name === CLEANUP_NAME) validateStrictMarker(path, CLEANUP_CONTENT, "cleanup marker");
    else if (name === CLEANUP_PENDING_NAME) {
      // A partial pending marker is non-authoritative but must still be a strict owned regular file;
      // repair may remove only that validated fixed-name artifact.
      assertStrictRegular(path, 0o600n);
      if (validatePending)
        validateStrictMarker(path, CLEANUP_CONTENT, "cleanup marker pending artifact");
    } else {
      const artifact = assertStrictRegular(path, 0o600n);
      if (name === MANIFEST_NAME && artifact.size > BigInt(MAX_MANIFEST_BYTES))
        throw new Error(`HTML preparation manifest is too large: ${path}`);
    }
  }
  return names;
}

/** Move a marked mode-0700 preparation into the marker-last cleanup sweep. */
function finishReadyPreparationCleanup(
  directory: string,
  preparationDirectory: string,
  initial: BigIntStats,
  context: HtmlConversionTransactionContext,
  hook?: HtmlConversionTransactionHook,
): void {
  hook?.("afterCleanupMarker", context);

  const names = validateEnumerablePreparationArtifacts(preparationDirectory);
  if (!names.includes(CLEANUP_NAME) || names.includes(CLEANUP_PENDING_NAME))
    throw new Error(
      `HTML preparation cleanup marker is not fully published: ${preparationDirectory}`,
    );
  const beforeRename = lstatSync(preparationDirectory, { bigint: true });
  if (!sameInode(beforeRename, identity(initial)))
    throw new Error("HTML preparation directory identity changed before cleanup transition");
  if (statMaybe(context.cleanupDirectory) !== null)
    throw new Error(`HTML cleanup destination already exists: ${context.cleanupDirectory}`);
  renameSync(preparationDirectory, context.cleanupDirectory);
  const afterRename = lstatSync(context.cleanupDirectory, { bigint: true });
  if (!sameInode(afterRename, identity(initial)))
    throw new Error("HTML preparation directory identity changed during cleanup transition");
  syncDirectory(directory);
  hook?.("afterCleanupTransition", context);
  sweepCleanup(directory, context.cleanupDirectory, hook, context);
}

/**
 * Exact mode 0300 plus a canonical UUID cleanup name is the transitional private-cleanup token.
 * The rename and parent fsync make that token durable before mode 0700 permits enumeration.
 */
function recoverTransitionalPreparationCleanup(
  directory: string,
  cleanupDirectory: string,
  hook?: HtmlConversionTransactionHook,
  context = cleanupContext(directory, cleanupDirectory),
): void {
  canonicalCleanupSuffix(cleanupDirectory);
  const initial = assertPrivateDirectory(cleanupDirectory, 0o300n);
  validateKnownPreparationArtifacts(cleanupDirectory);

  chmodSync(cleanupDirectory, 0o700);
  syncDirectory(cleanupDirectory);
  syncDirectory(directory);
  hook?.("afterPreparationCleanupModeTransition", context);

  // Enumerate and validate the complete surface before marker repair can remove even a pending
  // artifact. If the pre-rename marker names were not durable, publish them in the now-syncable
  // cleanup namespace. This authority can mutate only this private directory.
  validateEnumerablePreparationArtifacts(cleanupDirectory, false);
  publishMarker(cleanupDirectory, context, "cleanup", hook);
  const names = validateEnumerablePreparationArtifacts(cleanupDirectory);
  if (!names.includes(CLEANUP_NAME) || names.includes(CLEANUP_PENDING_NAME))
    throw new Error(`HTML cleanup marker is not fully published: ${cleanupDirectory}`);
  const after = lstatSync(cleanupDirectory, { bigint: true });
  if (!sameInode(after, identity(initial)))
    throw new Error("HTML cleanup directory identity changed during mode transition");
  sweepCleanup(directory, cleanupDirectory, hook, context);
}

function recoverPreparation(
  directory: string,
  preparationDirectory: string,
  hook?: HtmlConversionTransactionHook,
): void {
  canonicalPreparationSuffix(preparationDirectory);
  const initial = lstatSync(preparationDirectory, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink() || !ownedTransactionArtifact(initial)) {
    throw new Error(`Unsafe HTML preparation directory: ${preparationDirectory}`);
  }
  const context = preparationCleanupContext(directory, preparationDirectory);

  if (strictMode(initial, 0o300n)) {
    // At mode 0300 only fixed known paths are accessible. Validate them and prepare the marker, but
    // do not chmod: its directory entry cannot portably be fsynced until after the canonical cleanup
    // rename has durably represented private cleanup authority in the parent.
    validateKnownPreparationArtifacts(preparationDirectory);
    publishMarker(preparationDirectory, context, "cleanup", hook, false);
    hook?.("afterCleanupMarker", context);
    const beforeRename = lstatSync(preparationDirectory, { bigint: true });
    if (!sameInode(beforeRename, identity(initial)))
      throw new Error("HTML preparation directory identity changed before cleanup transition");
    if (statMaybe(context.cleanupDirectory) !== null)
      throw new Error(`HTML cleanup destination already exists: ${context.cleanupDirectory}`);
    renameSync(preparationDirectory, context.cleanupDirectory);
    const afterRename = lstatSync(context.cleanupDirectory, { bigint: true });
    if (!sameInode(afterRename, identity(initial)) || !strictMode(afterRename, 0o300n))
      throw new Error(
        "HTML preparation directory identity or mode changed during cleanup transition",
      );
    syncDirectory(directory);
    hook?.("afterCleanupTransition", context);
    recoverTransitionalPreparationCleanup(directory, context.cleanupDirectory, hook, context);
    return;
  }
  if (!strictMode(initial, 0o700n))
    throw new Error(`Unsafe HTML preparation directory mode: ${preparationDirectory}`);

  let names = validateEnumerablePreparationArtifacts(preparationDirectory, false);
  if (names.includes(CLEANUP_NAME) || names.includes(CLEANUP_PENDING_NAME)) {
    const cleanupReady = repairMarker(preparationDirectory, "cleanup");
    if (cleanupReady) {
      finishReadyPreparationCleanup(directory, preparationDirectory, initial, context, hook);
      return;
    }
    names = validateEnumerablePreparationArtifacts(preparationDirectory);
  }

  // An unmarked mode-0700 preparation is authoritative only when the complete strict pair proves
  // both private output and the still-public source. Marking changes only the private namespace.
  if (names.length !== 2 || !names.includes(MANIFEST_NAME) || !names.includes(OUTPUT_NAME))
    throw new Error(`Incomplete ready HTML preparation directory: ${preparationDirectory}`);
  const manifest = readManifest(join(preparationDirectory, MANIFEST_NAME));
  const source = join(directory, manifest.source);
  validateOutput(join(preparationDirectory, OUTPUT_NAME), manifest);
  validateManifestSourceGeneration(source, manifest);

  publishMarker(preparationDirectory, context, "cleanup", hook);
  finishReadyPreparationCleanup(directory, preparationDirectory, initial, context, hook);
}

function recoverTransaction(
  directory: string,
  transactionDirectory: string,
  hook?: HtmlConversionTransactionHook,
): void {
  assertExpectedArtifacts(transactionDirectory, TRANSACTION_ARTIFACTS);
  const cleanupReady = repairMarker(transactionDirectory, "cleanup");
  if (cleanupReady) {
    const suffix = basename(transactionDirectory).slice(TRANSACTION_PREFIX.length);
    const context = cleanupContext(directory, join(directory, `${CLEANUP_PREFIX}${suffix}`));
    transitionToCleanup(context, hook);
    return;
  }
  const committed = repairMarker(transactionDirectory, "commit");
  const { context, manifest } = contextFromManifestDirectory(directory, transactionDirectory);
  if (committed) {
    finalizeCommitted(context, manifest, hook);
    return;
  }
  rollbackUncommitted(context, manifest, true, "crash-recovery", hook);
}

function prepareTransaction(
  directory: string,
  sourcePath: string,
  destination: string,
  source: OpenSource,
  markdown: string,
  hook?: HtmlConversionTransactionHook,
): { context: HtmlConversionTransactionContext; manifest: Manifest } {
  const context = transactionContext(directory, sourcePath, destination);
  const preparationManifest = join(context.preparationDirectory, MANIFEST_NAME);
  const preparationOutput = join(context.preparationDirectory, OUTPUT_NAME);
  // The mkdir mode is the preparation authority token. umask is process-global, so this synchronous
  // zero-umask window must stay narrow: no callback, await, or other operation may run inside it.
  // This cannot protect unrelated work in another JavaScript worker sharing the same process.
  const previousUmask = process.umask(0);
  try {
    mkdirSync(context.preparationDirectory, { mode: 0o300 });
  } finally {
    process.umask(previousUmask);
  }
  try {
    assertPrivateDirectory(context.preparationDirectory, 0o300n);
    syncDirectory(directory);
    hook?.("afterPreparationDirectoryCreation", context);
    const outputBytes = Buffer.from(markdown);
    const output = writeStrictFile(
      preparationOutput,
      outputBytes,
      () => hook?.("afterPreparationOutputCreation", context),
      () => hook?.("afterPreparationOutputWrite", context),
    );
    const manifest: Manifest = {
      version: 1,
      source: basename(sourcePath),
      destination: basename(destination),
      ...source.identity,
      digest: source.digest,
      outputDevice: `${output.dev}`,
      outputInode: `${output.ino}`,
      outputSize: `${output.size}`,
      outputDigest: digest(outputBytes),
    };
    writeStrictFile(
      preparationManifest,
      `${JSON.stringify(manifest)}\n`,
      () => hook?.("afterPreparationManifestCreation", context),
      () => hook?.("afterPreparationManifestWrite", context),
    );
    // Known-path validation is possible with write+execute mode and occurs before the authority
    // token's one-way transition. Both files have already been individually fsynced.
    const validatedManifest = readManifest(preparationManifest);
    if (
      validatedManifest.source !== basename(sourcePath) ||
      validatedManifest.destination !== basename(destination)
    ) {
      throw new Error("HTML preparation paths do not match the requested conversion");
    }
    validateOutput(preparationOutput, validatedManifest);
    validatePublicSource(sourcePath, source);
    hook?.("afterPreparationFilesSync", context);

    chmodSync(context.preparationDirectory, 0o700);
    syncDirectory(context.preparationDirectory);
    syncDirectory(directory);
    hook?.("afterPreparationReadyModeTransition", context);
    const names = assertExpectedArtifacts(context.preparationDirectory, PREPARATION_ARTIFACTS);
    if (names.length !== 2 || !names.includes(MANIFEST_NAME) || !names.includes(OUTPUT_NAME))
      throw new Error("Incomplete HTML preparation transaction");
    validateOutput(preparationOutput, validatedManifest);
    validatePublicSource(sourcePath, source);

    const beforeRename = lstatSync(context.preparationDirectory, { bigint: true });
    if (statMaybe(context.transactionDirectory) !== null)
      throw new Error(
        `HTML transaction destination already exists: ${context.transactionDirectory}`,
      );
    renameSync(context.preparationDirectory, context.transactionDirectory);
    const afterRename = lstatSync(context.transactionDirectory, { bigint: true });
    if (!sameInode(afterRename, identity(beforeRename)))
      throw new Error("HTML preparation directory identity changed during transaction transition");
    syncDirectory(directory);
    validateTransactionSurface(context);
    return { context, manifest: validatedManifest };
  } catch (primary) {
    const cleanupFailures: unknown[] = [];
    if (statMaybe(context.preparationDirectory) !== null) {
      try {
        recoverPreparation(directory, context.preparationDirectory);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    attachSecondary(primary, cleanupFailures, "transaction setup cleanup");
  }
}

function publishConversion(
  sourcePath: string,
  destination: string,
  directory: string,
  hook?: HtmlConversionTransactionHook,
): boolean {
  const source = openSource(sourcePath);
  let prepared: { context: HtmlConversionTransactionContext; manifest: Manifest } | null = null;
  let destinationMayBeOwned = false;
  let committed = false;
  try {
    // Conversion receives exactly the bytes read and hashed from the one no-follow descriptor.
    const markdown = convertHtml(source.bytes.toString("utf8"));
    prepared = prepareTransaction(directory, sourcePath, destination, source, markdown, hook);
    const { context, manifest } = prepared;
    hook?.("afterPreparationTransition", context);
    hook?.("transactionPrepared", context);
    hook?.("beforeDestinationLink", context);
    validatePublicSource(sourcePath, source);
    try {
      linkSync(context.output, destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        transitionToCleanup(context, hook);
        prepared = null;
        return false;
      }
      throw error;
    }
    destinationMayBeOwned = true;
    syncDirectory(directory);
    hook?.("afterDestinationLink", context);
    validatePublicSource(sourcePath, source);

    hook?.("beforeSourceRetirement", context);
    validatePublicSource(sourcePath, source);
    hook?.("beforeSourceRetirementRename", context);
    requirePrivateRenameTargetAbsent(context.retiredSource, "Retired HTML source destination");
    renameSync(sourcePath, context.retiredSource);
    hook?.("afterSourceRetirementRename", context);
    syncDirectory(context.transactionDirectory);
    hook?.("afterSourceRetirementTargetSync", context);
    syncDirectory(directory);
    hook?.("afterSourceRetirement", context);
    validateRetiredSource(context.retiredSource, source);

    const destinationBeforeCapture = statMaybe(destination);
    if (
      destinationBeforeCapture === null ||
      !sameInode(destinationBeforeCapture, {
        device: manifest.outputDevice,
        inode: manifest.outputInode,
      })
    ) {
      throw new Error("Published destination was replaced before capture");
    }
    if (!regular(destinationBeforeCapture))
      throw new Error("Published destination output is not regular");
    hook?.("beforeDestinationCaptureRename", context);
    requirePrivateRenameTargetAbsent(context.capturedDestination, "Captured HTML destination");
    renameSync(destination, context.capturedDestination);
    hook?.("afterDestinationCaptureRename", context);
    syncDirectory(context.transactionDirectory);
    hook?.("afterDestinationCaptureTargetSync", context);
    syncDirectory(directory);
    hook?.("afterDestinationCapture", context);
    const captured = lstatSync(context.capturedDestination, { bigint: true });
    if (
      sameInode(captured, {
        device: manifest.outputDevice,
        inode: manifest.outputInode,
      })
    ) {
      if (!regular(captured)) throw new Error("Captured owned destination is not regular");
    } else {
      restoreCapturedForeign(context, captured);
      throw new Error("Published destination was replaced before commit");
    }
    try {
      linkSync(context.output, destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        throw new Error("A concurrent destination prevents commit", { cause: error });
      throw error;
    }
    syncDirectory(directory);
    unlinkSync(context.capturedDestination);
    syncDirectory(context.transactionDirectory);

    hook?.("beforeCommit", context);
    if (statMaybe(sourcePath) !== null)
      throw new Error("A concurrent source generation prevents commit");
    validateRetiredSource(context.retiredSource, source);
    const output = validateOutput(context.output, manifest);
    const publicDestination = lstatSync(destination, { bigint: true });
    if (!regular(publicDestination) || !sameInode(publicDestination, identity(output)))
      throw new Error("Destination ownership changed before commit");

    publishMarker(context.transactionDirectory, context, "commit", hook);
    syncDirectory(directory);
    committed = true;
    hook?.("afterDurableCommit", context);

    validateRetiredSource(context.retiredSource, source);
    finalizeCommitted(context, manifest, hook);
    prepared = null;
    return true;
  } catch (primary) {
    if (prepared === null) throw primary;
    const secondary: unknown[] = [];
    let commitAuthoritative = committed;
    try {
      commitAuthoritative =
        repairMarker(prepared.context.transactionDirectory, "commit") || commitAuthoritative;
      if (commitAuthoritative) finalizeCommitted(prepared.context, prepared.manifest, hook);
      else
        rollbackUncommitted(
          prepared.context,
          prepared.manifest,
          destinationMayBeOwned,
          "live-operation",
          hook,
        );
    } catch (error) {
      secondary.push(error);
    }
    attachSecondary(
      primary,
      secondary,
      commitAuthoritative ? "committed finalization" : "rollback",
    );
  } finally {
    closeSync(source.descriptor);
  }
}

function convertHtmlDirectoryInternal(
  directory: string,
  hook?: HtmlConversionTransactionHook,
): number {
  const requestedRoot = resolve(directory);
  const requestedRootInfo = lstatSync(requestedRoot, { bigint: true });
  if (!requestedRootInfo.isDirectory() || requestedRootInfo.isSymbolicLink())
    throw new Error(`HTML conversion root must be a real directory: ${directory}`);
  const root = realpathSync(requestedRoot);
  const rootInfo = lstatSync(root, { bigint: true });
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !sameInode(rootInfo, identity(requestedRootInfo))
  )
    throw new Error(`HTML conversion root changed during validation: ${directory}`);

  const visited = new Set<string>();
  let count = 0;

  const walk = (current: string): void => {
    const info = lstatSync(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const canonical = realpathSync(current);
    if (!contained(root, canonical)) throw new Error("HTML conversion path escaped its root");
    const directoryIdentity = `${info.dev}:${info.ino}`;
    if (visited.has(directoryIdentity)) return;
    visited.add(directoryIdentity);

    // Ancestors retain their claims while descendants are traversed, so every lock acquisition is
    // deterministic from ancestor to descendant. Acquire before inspecting any local surface.
    const directoryLock = acquireDirectoryLock(current, info);
    try {
      walkLocked(current);
    } catch (primary) {
      const secondary: unknown[] = [];
      try {
        releaseDirectoryLock(directoryLock);
      } catch (error) {
        secondary.push(error);
      }
      attachSecondary(primary, secondary, "HTML conversion lock release");
    }
    releaseDirectoryLock(directoryLock);
  };

  const walkLocked = (current: string): void => {
    const reservedNames = readdirSync(current)
      .filter(
        (name) =>
          name.startsWith(PREPARATION_PREFIX) ||
          name.startsWith(TRANSACTION_PREFIX) ||
          name.startsWith(CLEANUP_PREFIX),
      )
      .sort((left, right) => {
        const leftPreparation = left.startsWith(PREPARATION_PREFIX);
        const rightPreparation = right.startsWith(PREPARATION_PREFIX);
        if (leftPreparation !== rightPreparation) return leftPreparation ? -1 : 1;
        return left.localeCompare(right);
      });
    for (const name of reservedNames) {
      const path = join(current, name);
      if (name.startsWith(PREPARATION_PREFIX)) recoverPreparation(current, path, hook);
      else if (name.startsWith(TRANSACTION_PREFIX)) recoverTransaction(current, path, hook);
      else {
        const cleanup = lstatSync(path, { bigint: true });
        if (strictMode(cleanup, 0o300n)) recoverTransitionalPreparationCleanup(current, path, hook);
        else sweepCleanup(current, path, hook);
      }
    }

    for (const name of readdirSync(current).sort()) {
      // Prefix names are reserved recovery surfaces, including malformed ones; never traverse them.
      if (
        name === LOCK_NAME ||
        name.startsWith(LOCK_OWNER_PREFIX) ||
        name.startsWith(LOCK_QUARANTINE_PREFIX) ||
        name.startsWith(PREPARATION_PREFIX) ||
        name.startsWith(TRANSACTION_PREFIX) ||
        name.startsWith(CLEANUP_PREFIX)
      )
        continue;
      const path = join(current, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || ![".html", ".htm"].includes(extname(name).toLowerCase())) continue;
      const target = `${path.slice(0, -extname(path).length)}.md`;
      if (publishConversion(path, target, current, hook)) count += 1;
    }
  };

  walk(root);
  return count;
}

/**
 * Non-global callback seam for hermetic transaction race/crash tests. Production and CLI calls do
 * not accept or reach a hook.
 */
export function convertHtmlDirectoryForTest(
  directory: string,
  hook: HtmlConversionTransactionHook,
): number {
  return convertHtmlDirectoryInternal(directory, hook);
}

/**
 * Recursively convert regular HTML files beneath a real directory. Transaction recovery runs before
 * sorted ordinary traversal in every directory; symlinks are skipped and destinations never replace
 * existing paths.
 */
export function convertHtmlDirectory(directory: string): number {
  return convertHtmlDirectoryInternal(directory);
}

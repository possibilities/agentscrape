import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { AgentscrapeArtifactError } from "./errors";
import type { ScrapeResult } from "./handlers/types";

export const RETAINED_TEXT_ARTIFACT_MAX_BYTES = 8_000_000;
export const RETAINED_TEXT_ARTIFACT_AGGREGATE_MAX_BYTES = 16_000_000;

export interface PreparedTextArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export function preflightTextArtifacts(
  artifacts: ReadonlyArray<{ path: string; content: string }>,
  limits: { perArtifactBytes?: number; aggregateBytes?: number } = {},
): PreparedTextArtifact[] {
  const perArtifactBytes = limits.perArtifactBytes ?? RETAINED_TEXT_ARTIFACT_MAX_BYTES;
  const aggregateBytes = limits.aggregateBytes ?? RETAINED_TEXT_ARTIFACT_AGGREGATE_MAX_BYTES;
  const prepared: PreparedTextArtifact[] = [];
  let aggregate = 0;
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.content, "utf8");
    if (bytes.byteLength > perArtifactBytes)
      throw new AgentscrapeArtifactError(
        `text artifact exceeds the ${perArtifactBytes}-byte limit`,
      );
    aggregate += bytes.byteLength;
    if (aggregate > aggregateBytes)
      throw new AgentscrapeArtifactError(
        `text artifacts exceed the ${aggregateBytes}-byte aggregate limit`,
      );
    prepared.push({ path: artifact.path, bytes });
  }
  return prepared;
}

export function prepareHtmlSidecars(
  destination: string,
  result: Pick<ScrapeResult, "full_html" | "selected_html" | "links">,
): PreparedTextArtifact[] {
  if (result.links) return [];
  const directory = dirname(destination);
  const stem = basename(destination, extname(destination));
  return preflightTextArtifacts([
    ...(result.full_html
      ? [{ path: join(directory, `${stem}.raw.html`), content: result.full_html }]
      : []),
    ...(result.selected_html
      ? [{ path: join(directory, `${stem}.selected.html`), content: result.selected_html }]
      : []),
  ]);
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) throw new AgentscrapeArtifactError("text artifact write made no progress");
    offset += count;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

const STABLE_STAT_FIELDS = [
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

function sameStableStat(left: BigIntStats, right: BigIntStats): boolean {
  return STABLE_STAT_FIELDS.every((field) => left[field] === right[field]);
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") throw new Error("POSIX file ownership is required");
  return BigInt(process.getuid());
}

function isPrivateArtifact(stat: BigIntStats, expectedBytes?: number): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === currentUid() &&
    stat.nlink === 1n &&
    (stat.mode & 0o077n) === 0n &&
    (expectedBytes === undefined || stat.size === BigInt(expectedBytes))
  );
}

function requirePublishedIdentity(
  pathname: BigIntStats,
  descriptor: BigIntStats,
  ready: BigIntStats,
  expectedBytes: number,
  afterRename = false,
): void {
  const stableFromReady = STABLE_STAT_FIELDS.every(
    (field) =>
      (afterRename && field === "ctimeNs") ||
      (pathname[field] === ready[field] && descriptor[field] === ready[field]),
  );
  if (
    !isPrivateArtifact(pathname, expectedBytes) ||
    !isPrivateArtifact(descriptor, expectedBytes) ||
    !sameStableStat(pathname, descriptor) ||
    !stableFromReady
  )
    throw new Error("staging artifact identity changed");
}

interface AtomicReplaceHooks {
  readonly beforeRename?: (temporary: string) => void;
}

function atomicReplace(artifact: PreparedTextArtifact, hooks: AtomicReplaceHooks = {}): void {
  const directory = dirname(artifact.path);
  const temporary = join(directory, `.agentscrape-artifact-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let cleanupOwned = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    cleanupOwned = true;
    fchmodSync(descriptor, 0o600);
    writeAll(descriptor, artifact.bytes);
    fsyncSync(descriptor);

    const ready = fstatSync(descriptor, { bigint: true });
    if (!isPrivateArtifact(ready, artifact.bytes.byteLength))
      throw new Error("staging artifact is not private");

    hooks.beforeRename?.(temporary);
    const beforePath = lstatSync(temporary, { bigint: true });
    const beforeDescriptor = fstatSync(descriptor, { bigint: true });
    requirePublishedIdentity(beforePath, beforeDescriptor, ready, artifact.bytes.byteLength);

    renameSync(temporary, artifact.path);

    const finalPath = lstatSync(artifact.path, { bigint: true });
    const finalDescriptor = fstatSync(descriptor, { bigint: true });
    // Darwin updates ctime when an inode is renamed. The post-rename pathname and descriptor
    // must agree on that new ctime; every other field must also remain equal to the ready stat.
    requirePublishedIdentity(finalPath, finalDescriptor, ready, artifact.bytes.byteLength, true);
    fsyncDirectory(directory);
    cleanupOwned = false;
  } catch {
    throw new AgentscrapeArtifactError("failed to retain a text artifact");
  } finally {
    if (cleanupOwned && descriptor !== null) {
      try {
        const pathname = lstatSync(temporary, { bigint: true });
        const opened = fstatSync(descriptor, { bigint: true });
        if (
          isPrivateArtifact(pathname) &&
          isPrivateArtifact(opened) &&
          sameStableStat(pathname, opened)
        )
          unlinkSync(temporary);
      } catch {
        // Never unlink a pathname unless it still names the private inode held open here.
      }
    }
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The fixed publication failure, if any, wins.
      }
    }
  }
}

/** @internal Test-only injection at the final staging-path verification boundary. */
export function __atomicReplaceForTest(
  artifact: PreparedTextArtifact,
  beforeRename: (temporary: string) => void,
): void {
  atomicReplace(artifact, { beforeRename });
}

export function writePreparedTextArtifacts(artifacts: readonly PreparedTextArtifact[]): void {
  for (const artifact of artifacts) atomicReplace(artifact);
}

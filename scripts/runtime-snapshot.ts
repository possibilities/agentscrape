#!/usr/bin/env bun
import { dlopen, type FFIFunction, FFIType, ptr, suffix, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { posix, resolve, sep } from "node:path";

const MANIFEST = ".agentscrape-runtime-manifest.json";
const INSTALL_ARGV = [
  "install",
  "--frozen-lockfile",
  "--production",
  "--ignore-scripts",
  "--backend=copyfile",
] as const;
const MAX_ENTRIES = 20_000;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;
const MAX_PATH_SIZE = 4096;
const MAX_DEPTH = 128;
const MAX_MANIFEST_SIZE = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const METADATA = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const REQUIRED = new Map<string, SnapshotType>([
  ["src", "directory"],
  ["src/cli.ts", "file"],
  ["config", "directory"],
  ["config/presets", "directory"],
  ["config/preset-schema.yaml", "file"],
  ["plist", "directory"],
  ["plist/agentscrape.process-queue.plist", "file"],
  ["scripts", "directory"],
  ["scripts/runtime-snapshot.ts", "file"],
  ["test", "directory"],
  ["test/corpus", "directory"],
  ["package.json", "file"],
  ["bun.lock", "file"],
  ["node_modules", "directory"],
]);

type SnapshotType = "directory" | "file" | "symlink";
type DirectoryEntry = { path: string; type: "directory"; mode: "0500" };
type FileEntry = {
  path: string;
  type: "file";
  mode: "0400" | "0500";
  size: number;
  sha256: string;
};
type SymlinkEntry = { path: string; type: "symlink"; target: string };
type SnapshotEntry = DirectoryEntry | FileEntry | SymlinkEntry;
type Manifest = {
  schema_version: 1;
  kind: "agentscrape-runtime-snapshot";
  sha: string;
  tree: string;
  platform: string;
  architecture: string;
  bun_version: string;
  entrypoint: "src/cli.ts";
  install_argv: typeof INSTALL_ARGV;
  entries: SnapshotEntry[];
};

type Metadata = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  rdev: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};
type Inventory = { root: Metadata; manifest: Metadata; entries: SnapshotEntry[] };

class SnapshotError extends Error {}
class PublishCollisionError extends Error {}

function fail(message: string): never {
  throw new SnapshotError(message);
}

function toMetadata(value: BigIntStats): Metadata {
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    uid: value.uid,
    gid: value.gid,
    rdev: value.rdev,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function metadata(path: string): Metadata {
  return toMetadata(lstatSync(path, { bigint: true }));
}

function sameMetadata(left: Metadata, right: Metadata): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof Metadata] === right[key as keyof Metadata],
  );
}

function fileType(mode: bigint): SnapshotType | "other" {
  const numeric = Number(mode);
  if ((numeric & constants.S_IFMT) === constants.S_IFDIR) return "directory";
  if ((numeric & constants.S_IFMT) === constants.S_IFREG) return "file";
  if ((numeric & constants.S_IFMT) === constants.S_IFLNK) return "symlink";
  return "other";
}

function modeBits(mode: bigint): number {
  return Number(mode & 0o7777n);
}

function validPath(value: string): boolean {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(value, "utf8");
  } catch {
    return false;
  }
  const parts = value.split("/");
  return (
    value.length > 0 &&
    value !== MANIFEST &&
    bytes <= MAX_PATH_SIZE &&
    parts.length <= MAX_DEPTH &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\ufffd") &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    }) &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function resolvedLink(path: string, target: string): string | null {
  if (!target || target.startsWith("/") || target.includes("\\") || target.includes("\ufffd"))
    return null;
  if (Buffer.byteLength(target, "utf8") > MAX_PATH_SIZE) return null;
  if (
    [...target].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return null;
  const parts = target.split("/");
  if (
    parts.length > MAX_DEPTH ||
    parts.some((part) => part === "" || part === ".") ||
    posix.normalize(target) !== target
  )
    return null;
  const resolved = path.split("/").slice(0, -1);
  for (const part of parts) {
    if (part === "..") {
      if (!resolved.length) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const value = resolved.join("/");
  return value && resolved.length <= MAX_DEPTH && Buffer.byteLength(value) <= MAX_PATH_SIZE
    ? value
    : null;
}

function hashStable(path: string, before: Metadata): string {
  const flags = constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  try {
    const openedMetadata = toMetadata(fstatSync(descriptor, { bigint: true }));
    if (!sameMetadata(before, openedMetadata)) fail(`snapshot file changed: ${path}`);
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > MAX_FILE_SIZE || BigInt(bytes.byteLength) !== before.size)
      fail(`snapshot file size is unsafe: ${path}`);
    const after = metadata(path);
    const finished = fstatSync(descriptor, { bigint: true });
    if (
      !sameMetadata(before, after) ||
      finished.dev !== before.dev ||
      finished.ino !== before.ino ||
      finished.mode !== before.mode ||
      finished.nlink !== before.nlink ||
      finished.uid !== before.uid ||
      finished.gid !== before.gid ||
      finished.rdev !== before.rdev ||
      finished.size !== before.size ||
      finished.mtimeNs !== before.mtimeNs ||
      finished.ctimeNs !== before.ctimeNs
    )
      fail(`snapshot file changed: ${path}`);
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function sortedNames(path: string): string[] {
  return readdirSync(path).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function scan(root: string, sealed: boolean, includeManifest: boolean): Inventory {
  const rootBefore = metadata(root);
  if (
    fileType(rootBefore.mode) !== "directory" ||
    rootBefore.uid !== BigInt(process.getuid?.() ?? -1)
  )
    fail("snapshot root is not an owned plain directory");
  if (sealed && modeBits(rootBefore.mode) !== 0o500) fail("snapshot root mode is unsafe");

  let totalSize = 0;
  const entries: SnapshotEntry[] = [];
  let manifestMetadata: Metadata | undefined;
  const walk = (directory: string, prefix: string): void => {
    const directoryBefore = metadata(directory);
    if (fileType(directoryBefore.mode) !== "directory")
      fail(`snapshot directory changed: ${prefix}`);
    for (const name of sortedNames(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = `${directory}${sep}${name}`;
      if (!prefix && name === MANIFEST) {
        if (!includeManifest) fail("snapshot stage already contains a runtime manifest");
        const info = metadata(absolute);
        if (
          fileType(info.mode) !== "file" ||
          info.uid !== BigInt(process.getuid?.() ?? -1) ||
          info.nlink !== 1n ||
          modeBits(info.mode) !== 0o400 ||
          info.size > BigInt(MAX_MANIFEST_SIZE)
        )
          fail("runtime manifest is unsafe");
        manifestMetadata = info;
        continue;
      }
      if (!validPath(path)) fail(`snapshot path is unsafe: ${JSON.stringify(path)}`);
      if (entries.length >= MAX_ENTRIES) fail("snapshot has too many entries");
      const info = metadata(absolute);
      if (info.uid !== BigInt(process.getuid?.() ?? -1))
        fail(`snapshot entry is not owned: ${path}`);
      const type = fileType(info.mode);
      if (type === "directory") {
        if (sealed && modeBits(info.mode) !== 0o500)
          fail(`snapshot directory mode is unsafe: ${path}`);
        entries.push({ path, type, mode: "0500" });
        walk(absolute, path);
        if (!sameMetadata(info, metadata(absolute))) fail(`snapshot directory changed: ${path}`);
      } else if (type === "file") {
        if (info.nlink !== 1n || info.size > BigInt(MAX_FILE_SIZE))
          fail(`snapshot regular file is unsafe: ${path}`);
        const desiredMode = modeBits(info.mode) & 0o100 ? "0500" : "0400";
        if (sealed && modeBits(info.mode) !== Number.parseInt(desiredMode, 8))
          fail(`snapshot file mode is unsafe: ${path}`);
        totalSize += Number(info.size);
        if (totalSize > MAX_TOTAL_SIZE) fail("snapshot is too large");
        entries.push({
          path,
          type,
          mode: desiredMode,
          size: Number(info.size),
          sha256: hashStable(absolute, info),
        });
      } else if (type === "symlink") {
        if (info.nlink !== 1n) fail(`snapshot symlink is unsafe: ${path}`);
        const target = readlinkSync(absolute);
        if (resolvedLink(path, target) === null || !sameMetadata(info, metadata(absolute)))
          fail(`snapshot symlink is unsafe: ${path}`);
        entries.push({ path, type, target });
      } else {
        fail(`snapshot entry type is unsafe: ${path}`);
      }
    }
    if (!sameMetadata(directoryBefore, metadata(directory)))
      fail(`snapshot directory changed: ${prefix || "."}`);
  };
  walk(root, "");
  if (!sameMetadata(rootBefore, metadata(root))) fail("snapshot root changed during inspection");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return {
    root: rootBefore,
    manifest: manifestMetadata ?? fail("runtime manifest is missing"),
    entries,
  };
}

function validateEntries(entries: unknown): SnapshotEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    fail("manifest entries are malformed");
  const result: SnapshotEntry[] = [];
  const paths = new Map<string, SnapshotType>();
  let previous: Buffer | undefined;
  let totalSize = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("manifest entry is malformed");
    const value = raw as Record<string, unknown>;
    const path = value.path;
    const type = value.type;
    if (typeof path !== "string" || !validPath(path)) fail("manifest entry path is unsafe");
    const encoded = Buffer.from(path);
    if (previous && Buffer.compare(encoded, previous) <= 0) fail("manifest entries are not sorted");
    previous = encoded;
    if (type === "directory") {
      if (Object.keys(value).sort().join(",") !== "mode,path,type" || value.mode !== "0500")
        fail(`manifest directory is malformed: ${path}`);
      result.push({ path, type, mode: "0500" });
    } else if (type === "file") {
      if (
        Object.keys(value).sort().join(",") !== "mode,path,sha256,size,type" ||
        (value.mode !== "0400" && value.mode !== "0500") ||
        typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        value.size > MAX_FILE_SIZE ||
        typeof value.sha256 !== "string" ||
        !SHA256.test(value.sha256)
      )
        fail(`manifest file is malformed: ${path}`);
      totalSize += value.size;
      if (totalSize > MAX_TOTAL_SIZE) fail("manifest total size is unsafe");
      result.push({ path, type, mode: value.mode, size: value.size, sha256: value.sha256 });
    } else if (type === "symlink") {
      if (
        Object.keys(value).sort().join(",") !== "path,target,type" ||
        typeof value.target !== "string" ||
        resolvedLink(path, value.target) === null
      )
        fail(`manifest symlink is malformed: ${path}`);
      result.push({ path, type, target: value.target });
    } else {
      fail(`manifest entry type is malformed: ${path}`);
    }
    paths.set(path, type as SnapshotType);
  }
  for (const [path, type] of REQUIRED) {
    if (paths.get(path) !== type) fail(`runtime snapshot is missing required ${type}: ${path}`);
  }
  for (const entry of result) {
    if (entry.type === "symlink") {
      const target = resolvedLink(entry.path, entry.target);
      if (!target || !paths.has(target))
        fail(`runtime snapshot symlink is dangling: ${entry.path}`);
    }
  }
  return result;
}

function manifestFrom(value: unknown, sha: string, tree?: string): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("runtime manifest is malformed");
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",") !==
    "architecture,bun_version,entries,entrypoint,install_argv,kind,platform,schema_version,sha,tree"
  )
    fail("runtime manifest keys are malformed");
  if (
    raw.schema_version !== 1 ||
    raw.kind !== "agentscrape-runtime-snapshot" ||
    raw.sha !== sha ||
    typeof raw.sha !== "string" ||
    !SHA.test(raw.sha) ||
    typeof raw.tree !== "string" ||
    !SHA.test(raw.tree) ||
    (tree !== undefined && raw.tree !== tree) ||
    raw.entrypoint !== "src/cli.ts" ||
    JSON.stringify(raw.install_argv) !== JSON.stringify(INSTALL_ARGV) ||
    ![raw.platform, raw.architecture, raw.bun_version].every(
      (item) => typeof item === "string" && METADATA.test(item),
    )
  )
    fail("runtime manifest identity is malformed");
  return {
    schema_version: 1,
    kind: "agentscrape-runtime-snapshot",
    sha,
    tree: raw.tree,
    platform: raw.platform as string,
    architecture: raw.architecture as string,
    bun_version: raw.bun_version as string,
    entrypoint: "src/cli.ts",
    install_argv: INSTALL_ARGV,
    entries: validateEntries(raw.entries),
  };
}

function readManifest(
  root: string,
  sha: string,
  tree?: string,
): { manifest: Manifest; bytes: Buffer } {
  const path = `${root}${sep}${MANIFEST}`;
  const before = metadata(path);
  if (
    fileType(before.mode) !== "file" ||
    before.uid !== BigInt(process.getuid?.() ?? -1) ||
    before.nlink !== 1n ||
    modeBits(before.mode) !== 0o400 ||
    before.size > BigInt(MAX_MANIFEST_SIZE)
  )
    fail("runtime manifest is unsafe");
  const flags = constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  let bytes: Buffer;
  let opened: Metadata;
  let finished: Metadata;
  try {
    opened = toMetadata(fstatSync(descriptor, { bigint: true }));
    if (!sameMetadata(before, opened)) fail("runtime manifest changed during inspection");
    bytes = readFileSync(descriptor);
    finished = toMetadata(fstatSync(descriptor, { bigint: true }));
  } finally {
    closeSync(descriptor);
  }
  if (
    !sameMetadata(before, opened) ||
    !sameMetadata(before, finished) ||
    !sameMetadata(before, metadata(path)) ||
    BigInt(bytes.byteLength) !== before.size
  )
    fail("runtime manifest changed during inspection");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("runtime manifest is malformed JSON");
  }
  const manifest = manifestFrom(parsed, sha, tree);
  const canonical = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (!bytes.equals(canonical)) fail("runtime manifest is not canonical");
  return { manifest, bytes };
}

function inventoryEquals(left: Inventory, right: Inventory): boolean {
  return (
    sameMetadata(left.root, right.root) &&
    sameMetadata(left.manifest, right.manifest) &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries)
  );
}

function verify(rootValue: string, sha: string, tree?: string): void {
  if (!SHA.test(sha) || (tree !== undefined && !SHA.test(tree))) fail("expected SHA is malformed");
  const root = resolve(rootValue);
  if (root !== rootValue) fail("snapshot root must be a normalized absolute path");
  const firstManifest = readManifest(root, sha, tree);
  const first = scan(root, true, true);
  if (JSON.stringify(first.entries) !== JSON.stringify(firstManifest.manifest.entries))
    fail("runtime snapshot does not match its manifest");
  const second = scan(root, true, true);
  const secondManifest = readManifest(root, sha, tree);
  if (
    !inventoryEquals(first, second) ||
    !firstManifest.bytes.equals(secondManifest.bytes) ||
    JSON.stringify(second.entries) !== JSON.stringify(secondManifest.manifest.entries)
  )
    fail("runtime snapshot changed during verification");
}

function fsyncFile(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_CLOEXEC ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_CLOEXEC ?? 0) |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function prepare(rootValue: string, sha: string, tree: string, bunVersion: string): void {
  if (!SHA.test(sha) || !SHA.test(tree)) fail("snapshot identity is malformed");
  if (![platform(), arch(), bunVersion].every((item) => METADATA.test(item)))
    fail("snapshot metadata is malformed");
  const root = resolve(rootValue);
  if (root !== rootValue) fail("snapshot root must be a normalized absolute path");
  const before = scanForPrepare(root);
  const manifest: Manifest = {
    schema_version: 1,
    kind: "agentscrape-runtime-snapshot",
    sha,
    tree,
    platform: platform(),
    architecture: arch(),
    bun_version: bunVersion,
    entrypoint: "src/cli.ts",
    install_argv: INSTALL_ARGV,
    entries: before,
  };
  validateEntries(manifest.entries);
  const manifestPath = `${root}${sep}${MANIFEST}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
  fsyncFile(manifestPath);

  for (const entry of before) {
    if (entry.type !== "file") continue;
    const absolute = `${root}${sep}${entry.path.split("/").join(sep)}`;
    chmodSync(absolute, Number.parseInt(entry.mode, 8));
    fsyncFile(absolute);
  }
  chmodSync(manifestPath, 0o400);
  fsyncFile(manifestPath);

  const directories = before
    .filter((entry): entry is DirectoryEntry => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) {
    const absolute = `${root}${sep}${entry.path.split("/").join(sep)}`;
    chmodSync(absolute, 0o500);
    fsyncDirectory(absolute);
  }
  chmodSync(root, 0o500);
  fsyncDirectory(root);
  verify(root, sha, tree);
}

function scanForPrepare(root: string): SnapshotEntry[] {
  const rootInfo = metadata(root);
  if (fileType(rootInfo.mode) !== "directory" || rootInfo.uid !== BigInt(process.getuid?.() ?? -1))
    fail("snapshot stage is not an owned plain directory");
  const entries: SnapshotEntry[] = [];
  let totalSize = 0;
  const walk = (directory: string, prefix: string): void => {
    const directoryInfo = metadata(directory);
    for (const name of sortedNames(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = `${directory}${sep}${name}`;
      if (!prefix && name === MANIFEST) fail("snapshot stage already contains a runtime manifest");
      if (!validPath(path)) fail(`snapshot path is unsafe: ${JSON.stringify(path)}`);
      if (entries.length >= MAX_ENTRIES) fail("snapshot has too many entries");
      const info = metadata(absolute);
      if (info.uid !== BigInt(process.getuid?.() ?? -1))
        fail(`snapshot entry is not owned: ${path}`);
      const type = fileType(info.mode);
      if (type === "directory") {
        entries.push({ path, type, mode: "0500" });
        walk(absolute, path);
        if (!sameMetadata(info, metadata(absolute))) fail(`snapshot directory changed: ${path}`);
      } else if (type === "file") {
        if (info.nlink !== 1n || info.size > BigInt(MAX_FILE_SIZE))
          fail(`snapshot regular file is unsafe: ${path}`);
        totalSize += Number(info.size);
        if (totalSize > MAX_TOTAL_SIZE) fail("snapshot is too large");
        entries.push({
          path,
          type,
          mode: modeBits(info.mode) & 0o100 ? "0500" : "0400",
          size: Number(info.size),
          sha256: hashStable(absolute, info),
        });
      } else if (type === "symlink") {
        if (info.nlink !== 1n) fail(`snapshot symlink is unsafe: ${path}`);
        const target = readlinkSync(absolute);
        if (resolvedLink(path, target) === null || !sameMetadata(info, metadata(absolute)))
          fail(`snapshot symlink is unsafe: ${path}`);
        entries.push({ path, type, target });
      } else {
        fail(`snapshot entry type is unsafe: ${path}`);
      }
    }
    if (!sameMetadata(directoryInfo, metadata(directory)))
      fail(`snapshot directory changed: ${prefix || "."}`);
  };
  walk(root, "");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (entry.type === "symlink") {
      const target = resolvedLink(entry.path, entry.target);
      if (!target || !paths.has(target)) fail(`snapshot symlink is dangling: ${entry.path}`);
    }
  }
  return entries;
}

const RENAME_FN: FFIFunction = {
  args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
  returns: FFIType.i32,
};
const ERRNO_FN: FFIFunction = { args: [], returns: FFIType.ptr };

function errnoValue(pointer: unknown): number {
  if (pointer === null) fail("native errno location is unavailable");
  return new DataView(toArrayBuffer(pointer as Parameters<typeof toArrayBuffer>[0], 0, 4)).getInt32(
    0,
    true,
  );
}

function cString(value: string): Buffer {
  if (value.includes("\0")) fail("publish path contains NUL");
  return Buffer.from(`${value}\0`);
}

function publish(stageValue: string, targetValue: string): void {
  const stage = resolve(stageValue);
  const target = resolve(targetValue);
  if (stage !== stageValue || target !== targetValue || stage === target)
    fail("publish paths must be distinct normalized absolute paths");
  const before = metadata(stage);
  if (fileType(before.mode) !== "directory" && fileType(before.mode) !== "file")
    fail("publish stage is not a plain file or directory");

  const stageBytes = cString(stage);
  const targetBytes = cString(target);
  let result: number;
  let errorNumber: number;
  if (process.platform === "darwin") {
    const library = dlopen(`libSystem.${suffix}`, {
      renameatx_np: RENAME_FN,
      __error: ERRNO_FN,
    });
    try {
      result = library.symbols.renameatx_np(-2, ptr(stageBytes), -2, ptr(targetBytes), 0x4);
      errorNumber = result === 0 ? 0 : errnoValue(library.symbols.__error());
    } finally {
      library.close();
    }
  } else if (process.platform === "linux") {
    const library = dlopen(`libc.${suffix}.6`, {
      renameat2: RENAME_FN,
      __errno_location: ERRNO_FN,
    });
    try {
      result = library.symbols.renameat2(-100, ptr(stageBytes), -100, ptr(targetBytes), 0x1);
      errorNumber = result === 0 ? 0 : errnoValue(library.symbols.__errno_location());
    } finally {
      library.close();
    }
  } else {
    fail(`native no-replace publish is unsupported on ${process.platform}`);
  }

  if (result !== 0) {
    if (errorNumber === 17) throw new PublishCollisionError("publish target already exists");
    fail(`native no-replace publish failed with errno ${errorNumber}`);
  }
  let targetInfo: Metadata;
  try {
    metadata(stage);
    fail("native publish reported success but retained the stage pathname");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
  }
  try {
    targetInfo = metadata(target);
  } catch {
    fail("native publish reported success without a target pathname");
  }
  if (before.dev !== targetInfo.dev || before.ino !== targetInfo.ino)
    fail("native publish did not preserve the exact stage inode");
}

function usage(): never {
  console.error(
    "Usage: runtime-snapshot.ts prepare ROOT SHA TREE BUN_VERSION\n       runtime-snapshot.ts verify ROOT SHA [TREE]\n       runtime-snapshot.ts publish STAGE TARGET",
  );
  process.exit(2);
}

try {
  const [command, root, sha, tree, extra] = process.argv.slice(2);
  if (command === "prepare" && root && sha && tree && extra && process.argv.length === 7) {
    prepare(root, sha, tree, extra);
  } else if (
    command === "verify" &&
    root &&
    sha &&
    process.argv.length >= 5 &&
    process.argv.length <= 6
  ) {
    verify(root, sha, tree);
  } else if (command === "publish" && root && sha && process.argv.length === 5) {
    publish(root, sha);
  } else {
    usage();
  }
} catch (error) {
  console.error(
    `agentscrape-runtime-snapshot: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(error instanceof PublishCollisionError ? 17 : 1);
}

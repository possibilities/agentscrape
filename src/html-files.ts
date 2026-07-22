import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { convertHtml } from "./html";

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Read one regular file without following a final-component symlink. */
export function readRegularFileNoFollow(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`HTML input must be a regular file: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error(`HTML input changed while being opened: ${path}`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function publishConversion(source: string, destination: string, directory: string): boolean {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) return false;
  const markdown = convertHtml(readRegularFileNoFollow(source));
  const temporary = join(
    directory,
    `.${destination.slice(destination.lastIndexOf(sep) + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, markdown);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      // Linking a fully-synced temporary file publishes atomically and fails if DEST already exists.
      linkSync(temporary, destination);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EEXIST") return false;
      throw error;
    }
    unlinkSync(temporary);
    syncDirectory(directory);

    const after = lstatSync(source);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      throw new Error(`HTML input changed before removal: ${source}`);
    unlinkSync(source);
    syncDirectory(directory);
    return true;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary name was either published and removed or never created.
    }
    // The temporary file never replaces an existing destination.
  }
}

/**
 * Recursively convert regular HTML files beneath a real directory.
 *
 * Directory and file symlinks are skipped, visited directory identities are cycle-checked, and
 * sibling Markdown is atomically published without replacing an existing path before source HTML
 * is removed.
 */
export function convertHtmlDirectory(directory: string): number {
  const requestedRoot = resolve(directory);
  const rootInfo = lstatSync(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(`HTML conversion root must be a real directory: ${directory}`);
  const root = realpathSync(requestedRoot);
  const visited = new Set<string>();
  let count = 0;

  const walk = (current: string): void => {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const canonical = realpathSync(current);
    if (!contained(root, canonical)) throw new Error("HTML conversion path escaped its root");
    const identity = `${info.dev}:${info.ino}`;
    if (visited.has(identity)) return;
    visited.add(identity);

    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || ![".html", ".htm"].includes(extname(name).toLowerCase())) continue;
      const target = `${path.slice(0, -extname(path).length)}.md`;
      if (publishConversion(path, target, current)) count += 1;
    }
  };

  walk(root);
  return count;
}

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fetchMarkdown, resetBrowserUnavailableCache } from "./api";
import { AgentscrapeUpstreamDownError, cancellationError, throwIfAborted } from "./errors";
import { isSensitiveName, JWT_RE } from "./redaction";
import { runProcess } from "./subprocess";

function validatedDataRoot(name: string, value: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value))
    throw new Error(`${name} must be a non-empty absolute path without NUL bytes`);
  return resolve(value);
}
export function resolveDataHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.AGENTSCRAPE_DATA_HOME !== undefined)
    return validatedDataRoot("AGENTSCRAPE_DATA_HOME", env.AGENTSCRAPE_DATA_HOME);
  if (env.XDG_DATA_HOME !== undefined)
    return join(validatedDataRoot("XDG_DATA_HOME", env.XDG_DATA_HOME), "agentscrape");
  return join(home, ".local", "share", "agentscrape");
}
export const DATA_HOME = resolveDataHome();
export const QUEUE_DIR = join(DATA_HOME, "queue");
export const FAILED_DIR = join(DATA_HOME, "failed");
export const RECONCILIATION_DIR = join(DATA_HOME, "reconciliation");
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
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
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
  const rootInfo = lstatSync(RECONCILIATION_DIR);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("reconciliation root must be a real directory");
  chmodSync(RECONCILIATION_DIR, 0o700);
  let current = RECONCILIATION_DIR;
  const rel = relative(RECONCILIATION_DIR, path);
  for (const part of rel ? rel.split(sep) : []) {
    const parent = current;
    current = join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      fsyncDirectory(parent);
    }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("reconciliation path contains a symlink or non-directory");
    chmodSync(current, 0o700);
  }
}
function stableSource(record: RecordInfo): void {
  const before = lstatSync(record.path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`queue record changed during reconciliation: ${record.filename}`);
  const raw = readFileSync(record.path);
  const after = lstatSync(record.path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    digest(raw) !== record.sha256
  )
    throw new Error(`queue record changed during reconciliation: ${record.filename}`);
  const actualParent = realpathSync(dirname(record.path));
  const expectedParent = realpathSync(record.area === "pending" ? QUEUE_DIR : FAILED_DIR);
  if (actualParent !== expectedParent)
    throw new Error(`queue record escaped its configured directory: ${record.filename}`);
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
function moveFailed(path: string): void {
  mkdirSync(FAILED_DIR, { recursive: true, mode: 0o700 });
  renameSync(path, join(FAILED_DIR, basename(path)));
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
export async function processQueue(options: { signal?: AbortSignal } = {}): Promise<{
  processed: number;
  failed: number;
  frozen: number;
}> {
  mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(FAILED_DIR, { recursive: true, mode: 0o700 });
  let processed = 0;
  let failed = 0;
  let frozen = 0;
  for (const file of readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort()) {
    throwIfAborted(options.signal);
    const path = join(QUEUE_DIR, file);
    let job: Record<string, unknown>;
    try {
      const parsed = parseYaml(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("job must be a mapping");
      job = parsed as Record<string, unknown>;
    } catch {
      moveFailed(path);
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
        (!job.frontmatter || typeof job.frontmatter !== "object" || Array.isArray(job.frontmatter)))
    ) {
      moveFailed(path);
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
        const result = await runProcess(["summaryctl", "short-summary"], {
          timeoutMs: 120_000,
          maxOutputBytes: 64_000,
          stdin: body,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const summary = result.stdout.trim();
        if (result.exitCode !== 0 || !summary) throw new Error("summary command failed");
        frontmatter.summary = summary;
      }
      if (Object.keys(frontmatter).length) {
        const body = stripFrontmatter(readFileSync(destination, "utf8"));
        writeFileSync(destination, `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`);
      }
      rmSync(path);
      processed += 1;
    } catch {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      moveFailed(path);
      failed += 1;
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
function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
function classify(area: RecordInfo["area"], path: string): RecordInfo {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`queue record must be a regular file: ${basename(path)}`);
  const raw = readFileSync(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size)
    throw new Error(`queue record changed while being read: ${basename(path)}`);
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
function records(): RecordInfo[] {
  const paths: Array<{ area: RecordInfo["area"]; path: string }> = [];
  for (const [area, directory] of [
    ["pending", QUEUE_DIR],
    ["failed", FAILED_DIR],
  ] as const) {
    if (!existsSync(directory)) continue;
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new Error(`queue ${area} path must be a real directory`);
    const canonicalDirectory = realpathSync(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".yaml") || !entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (realpathSync(dirname(path)) !== canonicalDirectory) continue;
      paths.push({ area, path });
      if (paths.length > 5000)
        throw new Error("queue inventory exceeds the 5000-record safety limit");
    }
  }
  return paths
    .map(({ area, path }) => classify(area, path))
    .sort((a, b) => a.filename.localeCompare(b.filename) || a.area.localeCompare(b.area));
}
function outcomePath(record: RecordInfo): string {
  return join(RECONCILIATION_DIR, "outcomes", `${record.record_id}.json`);
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
function readOutcome(record: RecordInfo): Record<string, unknown> | null {
  const path = outcomePath(record);
  if (!existsSync(path)) return null;
  privateDirectory(dirname(path));
  if (!regularFile(path)) throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`invalid reconciliation outcome: ${basename(path)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`mismatched reconciliation outcome: ${basename(path)}`);
  const value = parsed as Record<string, any>;
  const receiptRequired = ["imported", "duplicate"].includes(value.outcome);
  if (
    value.schema_version !== 1 ||
    value.record_id !== record.record_id ||
    !value.legacy_record ||
    typeof value.legacy_record !== "object" ||
    value.legacy_record.sha256 !== record.sha256 ||
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
  return value;
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
function privateWrite(path: string, value: unknown): void {
  assertContained(RECONCILIATION_DIR, path);
  privateDirectory(dirname(path));
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
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
function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function archive(record: RecordInfo, manifest: Record<string, any>): void {
  if (manifest.outcome === "excluded" || !existsSync(record.path)) return;
  stableSource(record);
  const directory = join(RECONCILIATION_DIR, "archive", record.area);
  privateDirectory(directory);
  const destination = join(directory, `${record.record_id.slice(0, 16)}-${record.filename}`);
  assertContained(RECONCILIATION_DIR, destination);
  if (existsSync(destination)) {
    if (!regularFile(destination) || digest(readFileSync(destination)) !== record.sha256)
      throw new Error(`archive collision for ${record.filename}`);
    syncFile(destination);
    fsyncDirectory(directory);
    unlinkSync(record.path);
    fsyncDirectory(dirname(record.path));
    return;
  }
  try {
    renameSync(record.path, destination);
    chmodSync(destination, 0o600);
    syncFile(destination);
    fsyncDirectory(directory);
    fsyncDirectory(dirname(record.path));
    return;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EXDEV") throw error;
  }

  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    copyFileSync(record.path, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    syncFile(temporary);
    if (digest(readFileSync(temporary)) !== record.sha256)
      throw new Error(`archive copy verification failed for ${record.filename}`);
    renameSync(temporary, destination);
    fsyncDirectory(directory);
    stableSource(record);
    unlinkSync(record.path);
    fsyncDirectory(dirname(record.path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export async function reconcileQueue(
  options: {
    apply?: boolean | undefined;
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const values = records();
  throwIfAborted(options.signal);
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 5000)
    throw new Error("reconciliation limit must be an integer between 0 and 5000");
  if (!options.apply) {
    const selected = values
      .slice(0, limit)
      .map((record) => publicRecord(record, readOutcome(record)));
    return {
      schema_version: 1,
      mode: "inventory",
      total_records: values.length,
      selected_records: selected.length,
      remaining_records: Math.max(0, values.length - selected.length),
      records: selected,
    };
  }
  let chosen = 0;
  let already = 0;
  let errors = 0;
  let remaining = 0;
  const results: Record<string, unknown>[] = [];
  for (const record of values) {
    throwIfAborted(options.signal);
    const existing = readOutcome(record);
    if (existing) {
      already += 1;
      archive(record, existing);
      results.push(publicRecord(record, existing));
      continue;
    }
    if (chosen >= limit) {
      remaining += 1;
      continue;
    }
    chosen += 1;
    try {
      stableSource(record);
      const receipt =
        record.planned_outcome === "import" ? await submit(record, options.signal) : null;
      stableSource(record);
      const outcome = receipt
        ? receipt.status === "queued"
          ? "imported"
          : "duplicate"
        : record.planned_outcome;
      const manifest = {
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
        archive_record:
          outcome === "excluded"
            ? null
            : `archive/${record.area}/${record.record_id.slice(0, 16)}-${record.filename}`,
        ...(record.evidence ? { evidence: record.evidence } : {}),
        ...(receipt ? { agentbrain_receipt: receipt } : {}),
      };
      privateWrite(outcomePath(record), manifest);
      archive(record, manifest);
      results.push(publicRecord(record, manifest));
    } catch (error) {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      errors += 1;
      results.push({
        ...publicRecord(record),
        error: error instanceof Error ? error.message : String(error),
      });
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
    total_records: values.length,
    selected_records: chosen,
    already_reconciled: already,
    remaining_records: remaining,
    counts,
    records: results,
    errors,
  };
}

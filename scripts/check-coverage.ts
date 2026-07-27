#!/usr/bin/env bun

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_LCOV_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SAFE_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);
const SUMMARY_KEYS = ["LF", "LH", "FNF", "FNH"] as const;
const UTF8_ENCODER = new TextEncoder();

type SummaryKey = (typeof SUMMARY_KEYS)[number];
type RecordCounters = Partial<Record<SummaryKey, number>>;
type RecordPhase = "TN" | "SF" | "FNF" | "FNH" | "DA_OR_LF" | "LH" | "END";

interface RecordState {
  started: boolean;
  phase: RecordPhase;
  testNameSeen: boolean;
  source?: string;
  counters: RecordCounters;
  daLines: Set<number>;
  daHits: number;
}

interface DataEntry {
  line: number;
  hits: number;
}

export interface CoverageMetric {
  found: number;
  hit: number;
}

export interface CoverageTotals {
  records: number;
  lines: CoverageMetric;
  functions: CoverageMetric;
}

export interface CoverageReport extends CoverageTotals {
  lines: CoverageMetric & { percent: string };
  functions: CoverageMetric & { percent: string };
  floor: string;
  pass: boolean;
}

export class CoverageInputError extends Error {
  override readonly name = "CoverageInputError";
}

class CoverageUsageError extends Error {
  override readonly name = "CoverageUsageError";
}

function malformed(lineNumber: number, reason: string): never {
  throw new CoverageInputError(`malformed LCOV at line ${lineNumber}: ${reason}`);
}

function parseCounter(value: string, lineNumber: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    malformed(lineNumber, "summary counter is not an unsigned decimal integer");
  }

  const counter = BigInt(value);
  if (counter > MAX_SAFE_COUNTER) {
    malformed(lineNumber, "summary counter exceeds the safe integer range");
  }
  return Number(counter);
}

function parseDataEntry(value: string, lineNumber: number): DataEntry {
  const match = /^([1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) {
    malformed(lineNumber, "DA must contain a positive line and unsigned hit count");
  }

  const sourceLine = BigInt(match[1] ?? "");
  const hits = BigInt(match[2] ?? "");
  if (sourceLine > MAX_SAFE_COUNTER) {
    malformed(lineNumber, "DA line exceeds the safe integer range");
  }
  if (hits > MAX_SAFE_COUNTER) {
    malformed(lineNumber, "DA hit count exceeds the safe integer range");
  }
  return { line: Number(sourceLine), hits: Number(hits) };
}

function addCounter(total: number, value: number, lineNumber: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    malformed(lineNumber, "aggregate counter exceeds the safe integer range");
  }
  return result;
}

function requiredCounter(counters: RecordCounters, key: SummaryKey, lineNumber: number): number {
  const value = counters[key];
  if (value === undefined) {
    malformed(lineNumber, `record is missing ${key}`);
  }
  return value;
}

function requirePhase(
  record: RecordState,
  expected: RecordPhase,
  lineNumber: number,
  field: string,
): void {
  if (record.phase !== expected) {
    malformed(lineNumber, `${field} field is out of order`);
  }
}

function parseSummaryField(
  record: RecordState,
  key: SummaryKey,
  value: string,
  lineNumber: number,
  expected: RecordPhase,
  next: RecordPhase,
): void {
  if (record.counters[key] !== undefined) {
    malformed(lineNumber, `duplicate ${key} counter`);
  }
  requirePhase(record, expected, lineNumber, key);
  record.counters[key] = parseCounter(value, lineNumber);
  record.phase = next;
}

function newRecord(): RecordState {
  return {
    started: false,
    phase: "TN",
    testNameSeen: false,
    counters: {},
    daLines: new Set(),
    daHits: 0,
  };
}

export function parseLcov(text: string): CoverageTotals {
  let records = 0;
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  let record = newRecord();
  const seenSources = new Set<string>();
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";

    if (index === lines.length - 1 && line === "" && text.endsWith("\n")) {
      continue;
    }
    if (line.includes("\0") || line.includes("\r")) {
      malformed(lineNumber, "NUL and carriage return are not allowed");
    }
    if (line === "") {
      malformed(lineNumber, "blank line");
    }

    if (line === "end_of_record") {
      if (!record.started) {
        malformed(lineNumber, "empty record");
      }
      if (!record.testNameSeen) {
        malformed(lineNumber, "record is missing TN");
      }
      const source = record.source;
      if (source === undefined) {
        malformed(lineNumber, "record is missing SF");
      }

      const recordLinesFound = requiredCounter(record.counters, "LF", lineNumber);
      const recordLinesHit = requiredCounter(record.counters, "LH", lineNumber);
      const recordFunctionsFound = requiredCounter(record.counters, "FNF", lineNumber);
      const recordFunctionsHit = requiredCounter(record.counters, "FNH", lineNumber);
      requirePhase(record, "END", lineNumber, "end_of_record");
      if (recordLinesHit > recordLinesFound) {
        malformed(lineNumber, "LH exceeds LF");
      }
      if (recordLinesFound !== record.daLines.size) {
        malformed(lineNumber, "LF does not match the DA entry count");
      }
      if (recordLinesHit !== record.daHits) {
        malformed(lineNumber, "LH does not match the hit DA entry count");
      }

      // Bun 1.3.14 emits no FN/FNDA details, so function summaries cannot be reconciled.
      if (recordFunctionsHit > recordFunctionsFound) {
        malformed(lineNumber, "FNH exceeds FNF");
      }
      if (seenSources.has(source)) {
        malformed(lineNumber, "duplicate SF source");
      }

      const nextRecords = records + 1;
      if (!Number.isSafeInteger(nextRecords)) {
        malformed(lineNumber, "record count exceeds the safe integer range");
      }
      const nextLinesFound = addCounter(linesFound, recordLinesFound, lineNumber);
      const nextLinesHit = addCounter(linesHit, recordLinesHit, lineNumber);
      const nextFunctionsFound = addCounter(functionsFound, recordFunctionsFound, lineNumber);
      const nextFunctionsHit = addCounter(functionsHit, recordFunctionsHit, lineNumber);

      seenSources.add(source);
      records = nextRecords;
      linesFound = nextLinesFound;
      linesHit = nextLinesHit;
      functionsFound = nextFunctionsFound;
      functionsHit = nextFunctionsHit;
      record = newRecord();
      continue;
    }

    record.started = true;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      malformed(lineNumber, "line has no valid field separator");
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);

    if (key === "TN") {
      if (record.testNameSeen) {
        malformed(lineNumber, "duplicate TN field");
      }
      requirePhase(record, "TN", lineNumber, key);
      if (value !== "") {
        malformed(lineNumber, "TN field must be empty");
      }
      record.testNameSeen = true;
      record.phase = "SF";
      continue;
    }

    if (key === "SF") {
      if (record.source !== undefined) {
        malformed(lineNumber, "duplicate SF field");
      }
      requirePhase(record, "SF", lineNumber, key);
      if (value.length === 0) {
        malformed(lineNumber, "SF field must be nonempty");
      }
      if (value.length > MAX_LCOV_BYTES || UTF8_ENCODER.encode(value).byteLength > MAX_LCOV_BYTES) {
        malformed(lineNumber, "SF field exceeds the LCOV input size limit");
      }
      record.source = value;
      record.phase = "FNF";
      continue;
    }

    if (key === "FNF") {
      parseSummaryField(record, key, value, lineNumber, "FNF", "FNH");
      continue;
    }
    if (key === "FNH") {
      parseSummaryField(record, key, value, lineNumber, "FNH", "DA_OR_LF");
      continue;
    }

    if (key === "DA") {
      requirePhase(record, "DA_OR_LF", lineNumber, key);
      const entry = parseDataEntry(value, lineNumber);
      if (record.daLines.has(entry.line)) {
        malformed(lineNumber, "duplicate DA line");
      }
      record.daLines.add(entry.line);
      if (entry.hits > 0) {
        record.daHits += 1;
      }
      continue;
    }

    if (key === "LF") {
      parseSummaryField(record, key, value, lineNumber, "DA_OR_LF", "LH");
      continue;
    }
    if (key === "LH") {
      parseSummaryField(record, key, value, lineNumber, "LH", "END");
      continue;
    }

    malformed(lineNumber, "unsupported field");
  }

  if (record.started) {
    malformed(lines.length, "record is missing end_of_record");
  }
  if (records === 0) {
    throw new CoverageInputError("malformed LCOV: no records");
  }
  if (linesFound === 0) {
    throw new CoverageInputError("malformed LCOV: aggregate LF is zero");
  }
  if (functionsFound === 0) {
    throw new CoverageInputError("malformed LCOV: aggregate FNF is zero");
  }

  return {
    records,
    lines: { found: linesFound, hit: linesHit },
    functions: { found: functionsFound, hit: functionsHit },
  };
}

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function parseThreshold(value: string): Fraction {
  if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(value)) {
    throw new CoverageUsageError("threshold must be a decimal from 0 through 1");
  }

  if (value.startsWith("1")) {
    return { numerator: 1n, denominator: 1n };
  }
  const decimal = value.indexOf(".");
  if (decimal === -1) {
    return { numerator: 0n, denominator: 1n };
  }
  const fractionalDigits = value.slice(decimal + 1).replace(/0+$/, "");
  if (fractionalDigits === "") {
    return { numerator: 0n, denominator: 1n };
  }
  return {
    numerator: BigInt(fractionalDigits),
    denominator: 10n ** BigInt(fractionalDigits.length),
  };
}

function meetsFloor(metric: CoverageMetric, floor: Fraction): boolean {
  return BigInt(metric.hit) * floor.denominator >= BigInt(metric.found) * floor.numerator;
}

function formatPercent(numerator: bigint, denominator: bigint): string {
  const hundredths = (numerator * 20_000n + denominator) / (denominator * 2n);
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}%`;
}

export function evaluateCoverage(totals: CoverageTotals, threshold: string): CoverageReport {
  const floor = parseThreshold(threshold);
  const linesPass = meetsFloor(totals.lines, floor);
  const functionsPass = meetsFloor(totals.functions, floor);

  return {
    records: totals.records,
    lines: {
      ...totals.lines,
      percent: formatPercent(BigInt(totals.lines.hit), BigInt(totals.lines.found)),
    },
    functions: {
      ...totals.functions,
      percent: formatPercent(BigInt(totals.functions.hit), BigInt(totals.functions.found)),
    },
    floor: formatPercent(floor.numerator, floor.denominator),
    pass: linesPass && functionsPass,
  };
}

function readLcov(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    throw new CoverageInputError("unable to read LCOV input");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
      throw new CoverageInputError("unable to read LCOV input");
    }
    if (metadata.size > MAX_LCOV_BYTES) {
      throw new CoverageInputError("LCOV input exceeds the 16777216-byte limit");
    }

    while (total <= MAX_LCOV_BYTES) {
      const capacity = Math.min(READ_CHUNK_BYTES, MAX_LCOV_BYTES + 1 - total);
      const chunk = new Uint8Array(capacity);
      const count = readSync(descriptor, chunk, 0, capacity, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
  } catch (error) {
    if (error instanceof CoverageInputError) throw error;
    throw new CoverageInputError("unable to read LCOV input");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the deterministic validation result if closing the input fails.
    }
  }

  if (total > MAX_LCOV_BYTES) {
    throw new CoverageInputError("LCOV input exceeds the 16777216-byte limit");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CoverageInputError("LCOV input is not valid UTF-8");
  }
}

export function runCoverageCli(arguments_: string[]): number {
  if (arguments_.length !== 2) {
    console.error("coverage-check: usage: check-coverage.ts LCOV_PATH THRESHOLD");
    return 2;
  }

  try {
    const totals = parseLcov(readLcov(arguments_[0] ?? ""));
    const report = evaluateCoverage(totals, arguments_[1] ?? "");
    console.log(JSON.stringify(report));
    return report.pass ? 0 : 1;
  } catch (error) {
    if (error instanceof CoverageInputError || error instanceof CoverageUsageError) {
      console.error(`coverage-check: ${error.message}`);
    } else {
      console.error("coverage-check: validation failed");
    }
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = runCoverageCli(Bun.argv.slice(2));
}

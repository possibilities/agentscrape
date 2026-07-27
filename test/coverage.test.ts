import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageInputError, evaluateCoverage, parseLcov } from "../scripts/check-coverage.ts";

const root = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

function record(
  linesFound: number,
  linesHit: number,
  functionsFound: number,
  functionsHit: number,
  source = "fixture.ts",
): string {
  const dataEntries = Array.from(
    { length: linesFound },
    (_, index) => `DA:${index + 1},${index < linesHit ? 1 : 0}`,
  );
  return [
    "TN:",
    `SF:${source}`,
    `FNF:${functionsFound}`,
    `FNH:${functionsHit}`,
    ...dataEntries,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    "end_of_record",
  ].join("\n");
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentscrape-coverage-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(
  arguments_: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "scripts/check-coverage.ts", ...arguments_], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("aggregate LCOV coverage", () => {
  test("sums exact record summaries and passes an exact 70 percent floor", () => {
    const totals = parseLcov(
      `${record(8, 6, 3, 2, "first.ts")}\n${record(2, 1, 7, 5, "second.ts")}\n`,
    );

    expect(totals).toEqual({
      records: 2,
      lines: { found: 10, hit: 7 },
      functions: { found: 10, hit: 7 },
    });
    expect(evaluateCoverage(totals, "0.70")).toEqual({
      records: 2,
      lines: { found: 10, hit: 7, percent: "70.00%" },
      functions: { found: 10, hit: 7, percent: "70.00%" },
      floor: "70.00%",
      pass: true,
    });
  });

  test("fails just below the floor without floating-point rounding", () => {
    const totals = parseLcov(record(1_000, 699, 1_000, 700));

    expect(evaluateCoverage(totals, "0.70")).toMatchObject({
      lines: { found: 1_000, hit: 699, percent: "69.90%" },
      functions: { found: 1_000, hit: 700, percent: "70.00%" },
      floor: "70.00%",
      pass: false,
    });
  });

  test("permits a record without DA fields when aggregate denominators remain nonzero", () => {
    const totals = parseLcov(
      `${record(0, 0, 0, 0, "empty.ts")}\n${record(1, 1, 1, 1, "covered.ts")}`,
    );

    expect(totals).toEqual({
      records: 2,
      lines: { found: 1, hit: 1 },
      functions: { found: 1, hit: 1 },
    });
  });

  const validRecord = record(1, 1, 1, 1);
  const invalidInputs: Array<[string, string]> = [
    ["an empty input", ""],
    ["an empty record", "end_of_record"],
    ["an unknown line", `${validRecord}\nUNKNOWN:value`],
    ["a malformed counter", validRecord.replace("LF:1", "LF:nope")],
    ["a negative counter", validRecord.replace("LF:1", "LF:-1")],
    ["a non-safe counter", validRecord.replace("LF:1", "LF:9007199254740992")],
    ["a missing counter", validRecord.replace("FNH:1\n", "")],
    ["a duplicate counter", validRecord.replace("LF:1", "LF:1\nLF:1")],
    ["a hit count above found", record(1, 2, 1, 1)],
    ["a function hit count above found", record(1, 1, 1, 2)],
    ["a partial final record", validRecord.replace("\nend_of_record", "")],
    ["a zero line denominator", record(0, 0, 1, 1)],
    ["a zero function denominator", record(1, 1, 0, 0)],
    ["a missing TN field", validRecord.replace("TN:\n", "")],
    ["a missing SF field", validRecord.replace("SF:fixture.ts\n", "")],
    ["a duplicate TN field", validRecord.replace("TN:\n", "TN:\nTN:\n")],
    [
      "a duplicate SF field",
      validRecord.replace("SF:fixture.ts\n", "SF:fixture.ts\nSF:other.ts\n"),
    ],
    [
      "a duplicate SF source across records",
      `${record(1, 1, 1, 1, "same.ts")}\n${record(1, 1, 1, 1, "same.ts")}`,
    ],
    ["a nonempty TN field", validRecord.replace("TN:", "TN:suite")],
    ["an empty SF field", validRecord.replace("SF:fixture.ts", "SF:")],
    ["a NUL in the payload", validRecord.replace("fixture.ts", "fixture\0.ts")],
    ["a carriage return in the payload", validRecord.replace("TN:\n", "TN:\r\n")],
    ["an empty DA detail", validRecord.replace("DA:1,1", "DA:")],
    ["a partial DA detail", validRecord.replace("DA:1,1", "DA:1")],
    ["a zero DA line", validRecord.replace("DA:1,1", "DA:0,1")],
    ["a negative DA hit count", validRecord.replace("DA:1,1", "DA:1,-1")],
    ["a non-safe DA line", validRecord.replace("DA:1,1", "DA:9007199254740992,1")],
    ["a non-safe DA hit count", validRecord.replace("DA:1,1", "DA:1,9007199254740992")],
    ["an extra DA checksum field", validRecord.replace("DA:1,1", "DA:1,1,checksum")],
    ["a duplicate DA line", validRecord.replace("DA:1,1", "DA:1,1\nDA:1,0")],
    ["a missing DA detail", validRecord.replace("DA:1,1\n", "")],
    ["an LF mismatch", record(2, 1, 1, 1).replace("LF:2", "LF:1")],
    ["an LH mismatch", record(2, 1, 1, 1).replace("LH:1", "LH:0")],
    ["an FN detail", validRecord.replace("DA:1,1", "FN:1,name\nDA:1,1")],
    ["an FNDA detail", validRecord.replace("DA:1,1", "FNDA:1,name\nDA:1,1")],
    ["a BRDA detail", validRecord.replace("DA:1,1", "BRDA:1,0,0,1\nDA:1,1")],
    [
      "out-of-order TN and SF fields",
      validRecord.replace("TN:\nSF:fixture.ts", "SF:fixture.ts\nTN:"),
    ],
    ["a DA field after LF", validRecord.replace("DA:1,1\nLF:1", "LF:1\nDA:1,1")],
  ];

  for (const [name, source] of invalidInputs) {
    test(`rejects ${name}`, () => {
      expect(() => parseLcov(source)).toThrow(CoverageInputError);
    });
  }
});

describe("coverage checker CLI", () => {
  test("uses exit 0 for a pass and exit 1 just below the aggregate floor", async () => {
    const directory = temporaryDirectory();
    const passingPath = join(directory, "passing.info");
    const failingPath = join(directory, "failing.info");
    writeFileSync(passingPath, record(10, 7, 10, 7));
    writeFileSync(failingPath, record(1_000, 699, 10, 7));

    const passing = await runCli([passingPath, "0.70"]);
    const failing = await runCli([failingPath, "0.70"]);

    expect(passing.code).toBe(0);
    expect(passing.stderr).toBe("");
    expect(JSON.parse(passing.stdout)).toMatchObject({ pass: true, floor: "70.00%" });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toBe("");
    expect(JSON.parse(failing.stdout)).toMatchObject({
      lines: { found: 1_000, hit: 699, percent: "69.90%" },
      pass: false,
    });
  });

  test("uses bounded path-safe exit 2 errors for missing and non-UTF-8 input", async () => {
    const directory = temporaryDirectory();
    const secret = "do-not-leak-this-secret-path";
    const missingPath = join(directory, secret, "missing.info");
    const invalidPath = join(directory, `${secret}.info`);
    writeFileSync(invalidPath, Uint8Array.of(0xff));

    const missing = await runCli([missingPath, "0.70"]);
    const invalid = await runCli([invalidPath, "0.70"]);

    for (const result of [missing, invalid]) {
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeLessThan(160);
      expect(result.stderr).not.toContain(secret);
    }
    expect(missing.stderr).toBe("coverage-check: unable to read LCOV input\n");
    expect(invalid.stderr).toBe("coverage-check: LCOV input is not valid UTF-8\n");
  });

  test("requires exactly a path and decimal threshold", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "coverage.info");
    writeFileSync(path, record(1, 1, 1, 1));

    const missingArgument = await runCli([path]);
    const invalidThreshold = await runCli([path, "70%"]);

    expect(missingArgument).toEqual({
      code: 2,
      stdout: "",
      stderr: "coverage-check: usage: check-coverage.ts LCOV_PATH THRESHOLD\n",
    });
    expect(invalidThreshold).toEqual({
      code: 2,
      stdout: "",
      stderr: "coverage-check: threshold must be a decimal from 0 through 1\n",
    });
  });
});

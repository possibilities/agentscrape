import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { JWT_RE, SECRET_VALUE_RE } from "../src/redaction";

const root = join(import.meta.dir, "..");

// Checked-in page dumps once carried a live OpenAI OAuth token, the capturing
// account's email and IP, and a signed-in X account-settings object. These rules
// describe the shapes that leaked, not the individuals who leaked, so the gate
// works for whoever captures the next sample.
const RULES: { name: string; matches: (text: string) => boolean }[] = [
  { name: "JWT-shaped token", matches: (text) => new RegExp(JWT_RE.source).test(text) },
  { name: "provider secret value", matches: (text) => SECRET_VALUE_RE.test(text) },
  {
    name: "email address outside a reserved example domain",
    matches: (text) =>
      [...text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)].some(
        (match) =>
          !/^(?:example\.(?:com|org|net|edu)|[A-Za-z0-9.-]+\.(?:invalid|test|localhost|example))$/i.test(
            match[1] ?? "",
          ),
      ),
  },
  {
    name: "opaque provider account id",
    matches: (text) => /\buser-[A-Za-z0-9_-]{16,}\b/.test(text),
  },
  {
    name: "client IP recorded against an account",
    matches: (text) =>
      /"(?:ip|clientIp|client_ip|remote_addr|remoteAddress)"\s*:\s*"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"/.test(
        text,
      ),
  },
  {
    name: "signed-in account state",
    matches: (text) =>
      /"authStatus"\s*:\s*"logged_in"|"discoverable_by_email"|"use_cookie_personalization"/.test(
        text,
      ),
  },
];

// Hand-written suites carry synthetic secrets on purpose — they exercise redaction.
// Everything else under test/ is captured data nobody reads before committing it.
function capturedData(): string[] {
  const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "test"]);
  const paths = listed.success
    ? new TextDecoder()
        .decode(listed.stdout)
        .split("\0")
        .filter(Boolean)
        .map((path) => join(root, path))
    : walk(join(root, "test"));
  return paths.filter((path) => !path.endsWith(".ts"));
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : entry.isFile()
        ? [join(directory, entry.name)]
        : [],
  );
}

describe("fixture hygiene", () => {
  test("captured samples carry no credential or identity material", () => {
    const paths = capturedData();
    expect(paths.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const path of paths) {
      const text = readFileSync(path, "utf8");
      for (const rule of RULES)
        if (rule.matches(text)) offenders.push(`${relative(root, path)}: ${rule.name}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every rule fires on the shape it describes and none on clean markup", () => {
    const samples = [
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature here",
      "key sk-proj-0123456789abcdefghij here",
      "contact someone@mail.example.com here",
      "id user-AbCdEfGhIjKlMnOpQrSt here",
      '{"ip":"203.0.113.7"}',
      '{"authStatus":"logged_in"}',
    ];
    expect(samples.length).toBe(RULES.length);
    samples.forEach((sample, index) => {
      expect(RULES[index]?.matches(sample)).toBeTrue();
    });
    for (const rule of RULES)
      expect(
        rule.matches('<main><a href="https://example.com/a">public article body</a></main>'),
      ).toBeFalse();
  });
});

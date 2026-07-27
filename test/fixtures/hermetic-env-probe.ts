import { expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be supplied to the hermetic environment probe`);
  return value;
}

test("check wrapper supplies a private sanitized HOME", () => {
  const home = requiredEnvironment("HOME");
  const poisonedHome = requiredEnvironment("HERMETIC_TEST_POISON_HOME");

  expect(isAbsolute(home)).toBeTrue();
  expect(existsSync(home)).toBeTrue();
  expect(realpathSync(home)).not.toBe(realpathSync(poisonedHome));

  const homeInfo = lstatSync(home);
  expect(homeInfo.isDirectory()).toBeTrue();
  expect(homeInfo.isSymbolicLink()).toBeFalse();
  expect(homeInfo.mode & 0o777).toBe(0o700);

  const forbidden = Object.keys(process.env)
    .filter(
      (name) =>
        name.startsWith("AGENTSCRAPE_") ||
        name.startsWith("XDG_") ||
        name === "NODE_OPTIONS" ||
        name === "BUN_OPTIONS",
    )
    .sort();
  expect(forbidden).toEqual([]);
});

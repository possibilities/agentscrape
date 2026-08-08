import packageManifest from "../package.json" with { type: "json" };

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`agentscrape package ${label} must be a non-empty string`);
  return value;
}

if (packageManifest.name !== "agentscrape")
  throw new Error("agentscrape package identity does not match package.json");

/** The package semantic version used by every production identity surface. */
export const AGENTSCRAPE_VERSION = requiredIdentity(packageManifest.version, "version");

/** The Bun engine range exactly as `package.json` declares it. */
export const BUN_ENGINE_RANGE = requiredIdentity(packageManifest.engines?.bun, "Bun engine");

/** The floor the engine range names. Only the `>=X.Y.Z` form is supported. */
export const MINIMUM_BUN_VERSION = ((): string => {
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(BUN_ENGINE_RANGE)?.[1];
  if (!floor) throw new Error(`agentscrape Bun engine must be '>=X.Y.Z': ${BUN_ENGINE_RANGE}`);
  return floor;
})();

/**
 * Compare release triples, ignoring any prerelease or build suffix. A Bun
 * version that does not parse is treated as below the floor rather than above
 * it, so an unrecognizable runtime fails closed.
 */
export function satisfiesMinimumBunVersion(actual: string, minimum = MINIMUM_BUN_VERSION): boolean {
  const parse = (value: string): number[] | null => {
    const triple = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    return triple ? triple.slice(1, 4).map(Number) : null;
  };
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

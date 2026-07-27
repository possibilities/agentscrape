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

/** The exact Bun release required by the package runtime contract. */
export const REQUIRED_BUN_VERSION = requiredIdentity(packageManifest.engines?.bun, "Bun engine");

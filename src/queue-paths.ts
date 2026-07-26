import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface QueuePaths {
  dataHome: string;
  queue: string;
  frozen: string;
  retry: string;
  failed: string;
  reconciliation: string;
}

function validatedDataRoot(name: string, value: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value))
    throw new Error(`${name} must be a non-empty absolute path without NUL bytes`);
  return resolve(value);
}

export function resolveQueuePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): QueuePaths {
  const dataHome =
    env.AGENTSCRAPE_DATA_HOME !== undefined
      ? validatedDataRoot("AGENTSCRAPE_DATA_HOME", env.AGENTSCRAPE_DATA_HOME)
      : env.XDG_DATA_HOME !== undefined
        ? join(validatedDataRoot("XDG_DATA_HOME", env.XDG_DATA_HOME), "agentscrape")
        : join(home, ".local", "share", "agentscrape");
  return {
    dataHome,
    queue: join(dataHome, "queue"),
    frozen: join(dataHome, "frozen"),
    retry: join(dataHome, "retry"),
    failed: join(dataHome, "failed"),
    reconciliation: join(dataHome, "reconciliation"),
  };
}

export function resolveDataHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return resolveQueuePaths(env, home).dataHome;
}

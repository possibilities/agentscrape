#!/usr/bin/env bun
import { AgentscrapeCancelledError } from "../src/errors";
import { redactDiagnostic } from "../src/redaction";
import { findExecutable, runProcess } from "../src/subprocess";

const PRESETS = ["x-timeline", "x-article"] as const;
const TIMELINE_FLAG = "--since-id";
const PROCESS_TIMEOUT_MS = 5_000;

export interface XReadinessStatus {
  ready: boolean;
  checked_at: string;
  agentscrape: string | null;
  presets: Record<(typeof PRESETS)[number], boolean>;
  timeline_flags: boolean;
  error?: string;
}

export async function probeXReadiness(
  options: { binary?: string; signal?: AbortSignal } = {},
): Promise<XReadinessStatus> {
  const binary = findExecutable(options.binary ?? "agentscrape");
  const status: XReadinessStatus = {
    ready: false,
    checked_at: new Date().toISOString(),
    agentscrape: binary,
    presets: { "x-timeline": false, "x-article": false },
    timeline_flags: false,
  };
  if (!binary) {
    status.error = "agentscrape not on PATH";
    return status;
  }
  for (const name of PRESETS) {
    const result = await runProcess([binary, "show-preset", name], {
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: 64_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    status.presets[name] = result.exitCode === 0 && !result.timedOut && !result.truncated;
  }
  const help = await runProcess([binary, "fetch-links", "--help"], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: 128_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  status.timeline_flags =
    help.exitCode === 0 && !help.timedOut && !help.truncated && help.stdout.includes(TIMELINE_FLAG);
  status.ready = PRESETS.every((name) => status.presets[name]) && status.timeline_flags;
  return status;
}

interface WatchOptions {
  once: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  signal?: AbortSignal;
}
function integer(raw: string | undefined, option: string, minimum: number): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${option} requires an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${option} must be an integer >= ${minimum}`);
  return value;
}
function parseArgs(argv: string[]): WatchOptions {
  let once = false;
  let intervalSeconds = 300;
  let timeoutSeconds = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--once") once = true;
    else if (token === "--interval") intervalSeconds = integer(argv[++index], token, 1);
    else if (token === "--timeout") timeoutSeconds = integer(argv[++index], token, 0);
    else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: bun run scripts/check-x-readiness.ts [--once] [--interval SECONDS] [--timeout SECONDS]\n\nEach check emits one JSON object. Exit 0 when ready, 1 when not ready, and 2 when agentscrape is missing.",
      );
      throw new HelpRequested();
    } else throw new Error(`unknown option '${token}'`);
  }
  return { once, intervalSeconds, timeoutSeconds };
}
class HelpRequested extends Error {}

export async function watchXReadiness(options: WatchOptions): Promise<number> {
  const started = performance.now();
  const deadline = options.timeoutSeconds
    ? started + options.timeoutSeconds * 1000
    : Number.POSITIVE_INFINITY;
  while (true) {
    if (options.signal?.aborted) throw new AgentscrapeCancelledError();
    const status = await probeXReadiness({
      ...(options.signal ? { signal: options.signal } : {}),
    });
    console.log(JSON.stringify(status));
    if (status.error) return 2;
    if (status.ready) return 0;
    if (options.once || performance.now() >= deadline) return 1;
    const remaining = deadline - performance.now();
    await Bun.sleep(Math.min(options.intervalSeconds * 1000, remaining));
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await watchXReadiness(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof HelpRequested) process.exitCode = 0;
    else {
      console.error(
        redactDiagnostic(`Error: ${error instanceof Error ? error.message : String(error)}`),
      );
      process.exitCode = 2;
    }
  }
}

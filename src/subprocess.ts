import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ProcessResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}
export interface ProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export function findExecutable(name: string): string | null {
  if (name.includes("/")) return executable(name) ? name : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function decodeWithin(bytes: Uint8Array, limit: number): string {
  const decoder = new TextDecoder();
  const text = decoder.decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limit) return text;
  for (let end = Math.min(limit, encoded.byteLength); end >= Math.max(0, limit - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end));
    } catch {
      // A UTF-8 code point can cross the boundary by at most three bytes.
    }
  }
  return "";
}

interface Capture {
  bytes: Uint8Array;
  truncated: boolean;
}

/** Spawn explicit argv, never a shell, with a hard deadline and bounded streaming capture. */
export async function runProcess(
  argv: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  if (!argv.length) throw new Error("empty subprocess argv");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4_000_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error("subprocess timeout must be a non-negative finite number");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0)
    throw new Error("subprocess output limit must be a non-negative integer");
  if (options.signal?.aborted) {
    return {
      argv: [...argv],
      exitCode: 130,
      stdout: "",
      stderr: decodeWithin(new TextEncoder().encode("operation cancelled"), maxOutputBytes),
      timedOut: false,
      truncated: false,
    };
  }

  const executablePath = findExecutable(argv[0]!);
  if (!executablePath) throw new Error(`${argv[0]} not found on PATH`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
    if (value !== undefined) env[key] = value;
  }
  const child = Bun.spawn([executablePath, ...argv.slice(1)], {
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
    detached: true,
  });

  let stopReason: "timeout" | "cancelled" | "overflow" | "capture_error" | null = null;
  const terminate = (reason: NonNullable<typeof stopReason>) => {
    if (stopReason !== null) return;
    stopReason = reason;
    try {
      // detached:true makes the child the leader of an isolated process group. Killing the
      // negative pid terminates children which inherited either output pipe as well.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The group may already have exited; child.exited still reaps the direct child.
      }
    }
  };

  const capture = async (stream: ReadableStream<Uint8Array>): Promise<Capture> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        const remaining = maxOutputBytes - length;
        if (remaining > 0) {
          const selected = value.byteLength <= remaining ? value : value.subarray(0, remaining);
          chunks.push(selected.slice());
          length += selected.byteLength;
        }
        if (value.byteLength > remaining) {
          truncated = true;
          terminate("overflow");
          await reader.cancel("subprocess output limit exceeded").catch(() => undefined);
          break;
        }
      }
    } catch (error) {
      if (stopReason === null) {
        terminate("capture_error");
        throw error;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated };
  };

  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  timer.unref();
  const onAbort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const settled = await Promise.allSettled([
    capture(child.stdout),
    capture(child.stderr),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  });
  const captureFailure = settled.find((item) => item.status === "rejected");
  if (captureFailure?.status === "rejected") throw captureFailure.reason;
  const stdoutCapture = (settled[0] as PromiseFulfilledResult<Capture>).value;
  const stderrCapture = (settled[1] as PromiseFulfilledResult<Capture>).value;
  const childExitCode = (settled[2] as PromiseFulfilledResult<number>).value;
  const cancelled = stopReason === "cancelled";
  const timedOut = stopReason === "timeout";
  const overflowed = stopReason === "overflow";

  return {
    argv: [...argv],
    exitCode: timedOut ? 124 : cancelled ? 130 : overflowed ? 1 : childExitCode,
    stdout: decodeWithin(stdoutCapture.bytes, maxOutputBytes),
    stderr: cancelled
      ? decodeWithin(new TextEncoder().encode("operation cancelled"), maxOutputBytes)
      : decodeWithin(stderrCapture.bytes, maxOutputBytes),
    timedOut,
    truncated: stdoutCapture.truncated || stderrCapture.truncated,
  };
}

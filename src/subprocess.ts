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

type ChildExitErrorCause = Readonly<{ kind: "child_exit_error"; error: unknown }>;
type StopCause =
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "overflow" }>
  | Readonly<{ kind: "capture_error"; error: unknown }>
  | Readonly<{ kind: "read_error"; error: unknown }>
  | ChildExitErrorCause;

interface ChildExitState {
  exitFulfilled: boolean;
  exitCode: number;
}

function childExitError(error: unknown): ChildExitErrorCause {
  return Object.freeze({ kind: "child_exit_error", error });
}

function observeChildExit(
  exited: Promise<number>,
  state: ChildExitState,
  onRejected: (cause: ChildExitErrorCause) => void,
): Promise<void> {
  return exited.then(
    (code) => {
      state.exitFulfilled = true;
      state.exitCode = code;
    },
    (error: unknown) => onRejected(childExitError(error)),
  );
}

function unrefAfterGraceIfExitUnfulfilled(state: ChildExitState, child: { unref(): void }): void {
  if (state.exitFulfilled) return;
  try {
    child.unref();
  } catch {
    // The direct child may have become unobservable concurrently with the snapshot.
  }
}

/** Narrow test seam for the child-exit observer and post-grace unref decision. */
export async function __testChildExitTeardown(exited: Promise<number>): Promise<{
  exitFulfilled: boolean;
  exitCode: number;
  rejectionCallbackInvoked: boolean;
  cause: ChildExitErrorCause | null;
  unrefCalls: number;
}> {
  const state: ChildExitState = { exitFulfilled: false, exitCode: 0 };
  let cause: ChildExitErrorCause | null = null;
  let rejectionCallbackInvoked = false;
  await observeChildExit(exited, state, (observedCause) => {
    rejectionCallbackInvoked = true;
    cause = observedCause;
  });
  let unrefCalls = 0;
  const fakeChild = {
    unref() {
      unrefCalls += 1;
    },
  };
  unrefAfterGraceIfExitUnfulfilled(state, fakeChild);
  return {
    exitFulfilled: state.exitFulfilled,
    exitCode: state.exitCode,
    rejectionCallbackInvoked,
    cause,
    unrefCalls,
  };
}

interface CaptureReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

type ReadOutcome =
  | { status: "fulfilled"; result: { done: boolean; value: Uint8Array | undefined } }
  | { status: "rejected"; error: unknown };

type CancelOutcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };

interface CaptureState {
  reader: CaptureReader;
  chunks: Uint8Array[];
  length: number;
  truncated: boolean;
  error: unknown | null;
  pendingRead: Promise<ReadOutcome> | null;
  pendingCancel: Promise<CancelOutcome> | null;
  loopDone: boolean;
  released: boolean;
  cleanup: Promise<void>;
  resolveCleanup: () => void;
}

const TEARDOWN_GRACE_MS = 100;

function capturedBytes(state: CaptureState | null): Uint8Array {
  if (state === null) return new Uint8Array();
  const bytes = new Uint8Array(state.length);
  let offset = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Spawn explicit argv, never a shell, with a deadline and bounded streaming capture. */
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

  let firstCause: StopCause | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let graceBarrier: Promise<void> | null = null;
  let resolveStop!: () => void;
  const stopBarrier = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const captures: CaptureState[] = [];

  const maybeRelease = (state: CaptureState): void => {
    if (
      state.released ||
      !state.loopDone ||
      state.pendingRead !== null ||
      state.pendingCancel !== null
    )
      return;
    state.released = true;
    try {
      state.reader.releaseLock();
    } catch (error) {
      state.error ??= error;
      requestStop({ kind: "capture_error", error });
    }
    state.resolveCleanup();
  };

  const cancelReader = (state: CaptureState): void => {
    if (state.released || state.pendingCancel !== null) return;
    let rawCancel: Promise<void>;
    try {
      rawCancel = state.reader.cancel("subprocess stopped");
    } catch (error) {
      rawCancel = Promise.reject(error);
    }
    const cancel: Promise<CancelOutcome> = rawCancel.then(
      () => ({ status: "fulfilled" }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    state.pendingCancel = cancel;
    void cancel.then(
      () => {
        if (state.pendingCancel === cancel) state.pendingCancel = null;
        maybeRelease(state);
      },
      () => {
        // cancel is converted to an outcome above; retain a rejection handler defensively.
      },
    );
  };

  function requestStop(cause: StopCause): void {
    if (firstCause !== null) return;
    firstCause = Object.freeze(cause);
    resolveStop();
    graceBarrier = new Promise<void>((resolve) => {
      // This timer intentionally remains referenced: it is the local settlement bound.
      graceTimer = setTimeout(resolve, TEARDOWN_GRACE_MS);
    });
    try {
      // detached:true makes the direct child the leader of an isolated process group.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited; child.exited still performs observation.
      }
    }
    for (const state of captures) cancelReader(state);
  }

  const createCapture = (reader: CaptureReader): CaptureState => {
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    return {
      reader,
      chunks: [],
      length: 0,
      truncated: false,
      error: null,
      pendingRead: null,
      pendingCancel: null,
      loopDone: false,
      released: false,
      cleanup,
      resolveCleanup,
    };
  };

  const capture = async (state: CaptureState): Promise<void> => {
    while (firstCause === null) {
      let rawRead: Promise<{ done: boolean; value: Uint8Array | undefined }>;
      try {
        rawRead = state.reader.read();
      } catch (error) {
        state.error ??= error;
        requestStop({ kind: "read_error", error });
        break;
      }
      const read: Promise<ReadOutcome> = rawRead.then(
        (result) => ({ status: "fulfilled", result }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      state.pendingRead = read;
      void read.then(
        () => {
          if (state.pendingRead === read) state.pendingRead = null;
          maybeRelease(state);
        },
        () => {
          // read is converted to an outcome above; retain a rejection handler defensively.
        },
      );

      const observed = await Promise.race([
        read.then((outcome) => ({ kind: "read" as const, outcome })),
        stopBarrier.then(() => ({ kind: "stop" as const })),
      ]);
      if (firstCause !== null || observed.kind === "stop") break;
      const outcome = observed.outcome;
      if (outcome.status === "rejected") {
        state.error ??= outcome.error;
        requestStop({ kind: "read_error", error: outcome.error });
        break;
      }
      if (firstCause !== null) break;
      const { done, value } = outcome.result;
      if (done) break;
      if (!value?.byteLength) continue;
      if (firstCause !== null) break;

      const remaining = maxOutputBytes - state.length;
      if (remaining > 0) {
        const selected = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        state.chunks.push(selected.slice());
        state.length += selected.byteLength;
      }
      if (value.byteLength > remaining) {
        state.truncated = true;
        requestStop({ kind: "overflow" });
        break;
      }
    }
    state.loopDone = true;
    maybeRelease(state);
    await state.cleanup;
  };

  const childExitState: ChildExitState = { exitFulfilled: false, exitCode: 0 };
  const childExit = observeChildExit(child.exited, childExitState, requestStop);

  let stdoutCapture: CaptureState | null = null;
  let stderrCapture: CaptureState | null = null;
  const captureTasks: Promise<void>[] = [];
  try {
    try {
      stdoutCapture = createCapture(child.stdout.getReader());
      captures.push(stdoutCapture);
      stderrCapture = createCapture(child.stderr.getReader());
      captures.push(stderrCapture);
    } catch (error) {
      requestStop({ kind: "capture_error", error });
    }
    for (const state of captures) {
      // Child-exit observation starts first, so a prior rejection may have stopped before this
      // reader was registered; every reader that becomes active after a stop must still cancel.
      if (firstCause !== null) cancelReader(state);
      const task = capture(state).catch(async (error: unknown) => {
        state.error ??= error;
        requestStop({ kind: "capture_error", error });
        state.loopDone = true;
        maybeRelease(state);
        await state.cleanup;
      });
      captureTasks.push(task);
    }

    const lifecycle = Promise.all([...captureTasks, childExit]).then(() => undefined);
    const onAbort = () => requestStop({ kind: "cancelled" });
    let abortRegistered = false;
    try {
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortRegistered = true;
        if (options.signal.aborted) requestStop({ kind: "cancelled" });
      }
      if (firstCause === null) {
        if (timeoutMs === 0) requestStop({ kind: "timeout" });
        else {
          timeoutTimer = setTimeout(() => requestStop({ kind: "timeout" }), timeoutMs);
          timeoutTimer.unref();
        }
      }

      if (firstCause === null) await Promise.race([lifecycle, stopBarrier]);
      if (firstCause === null) {
        return {
          argv: [...argv],
          exitCode: childExitState.exitCode,
          stdout: decodeWithin(capturedBytes(stdoutCapture), maxOutputBytes),
          stderr: decodeWithin(capturedBytes(stderrCapture), maxOutputBytes),
          timedOut: false,
          truncated: (stdoutCapture?.truncated ?? false) || (stderrCapture?.truncated ?? false),
        };
      }

      // requestStop creates this referenced barrier synchronously with the first cause.
      await Promise.race([lifecycle, graceBarrier!]);
      unrefAfterGraceIfExitUnfulfilled(childExitState, child);

      const cause = firstCause as StopCause;
      if (
        cause.kind === "capture_error" ||
        cause.kind === "read_error" ||
        cause.kind === "child_exit_error"
      )
        throw cause.error;
      const timedOut = cause.kind === "timeout";
      const cancelled = cause.kind === "cancelled";
      return {
        argv: [...argv],
        exitCode: timedOut ? 124 : cancelled ? 130 : 1,
        stdout: decodeWithin(capturedBytes(stdoutCapture), maxOutputBytes),
        stderr: cancelled
          ? decodeWithin(new TextEncoder().encode("operation cancelled"), maxOutputBytes)
          : decodeWithin(capturedBytes(stderrCapture), maxOutputBytes),
        timedOut,
        truncated: (stdoutCapture?.truncated ?? false) || (stderrCapture?.truncated ?? false),
      };
    } finally {
      if (abortRegistered) options.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
}

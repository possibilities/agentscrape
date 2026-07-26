import { redactDiagnostic } from "./redaction";

export type ErrorClass =
  | "usage"
  | "auth"
  | "upstream"
  | "selection"
  | "config"
  | "output"
  | "drift"
  | "browser"
  | "provider"
  | "timeout"
  | "cancelled"
  | "runtime";

export class AgentscrapeError extends Error {
  constructor(
    message: string,
    public readonly errorClass: ErrorClass = "runtime",
  ) {
    super(message);
    this.name = "AgentscrapeError";
  }
}
export class AgentscrapeUsageError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "usage");
    this.name = "AgentscrapeUsageError";
  }
}
export type AgentscrapeNetworkPolicyReason = "private_destination" | "browser_egress_unverifiable";
export class AgentscrapeNetworkPolicyError extends AgentscrapeUsageError {
  constructor(public readonly reason: AgentscrapeNetworkPolicyReason) {
    super(
      reason === "private_destination"
        ? "The destination is not public; pass allowPrivateNetwork only for trusted network access."
        : "Browser-backed live navigation requires explicit unrestricted network consent.",
    );
    this.name = "AgentscrapeNetworkPolicyError";
  }
}
export class AgentscrapeAuthError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "auth");
  }
}
export class AgentscrapeUpstreamDownError extends AgentscrapeError {
  constructor(message: string) {
    super(redactDiagnostic(message), "upstream");
  }
}
export class AgentscrapeBrowserError extends AgentscrapeError {
  constructor(
    message: string,
    public readonly retryable = true,
    public readonly artifactDirectory?: string,
  ) {
    super(redactDiagnostic(message), "browser");
  }
}
export class AgentscrapeProviderError extends AgentscrapeError {
  constructor(
    message: string,
    public readonly retryable = false,
    public readonly status: number | undefined = undefined,
  ) {
    super(message, "provider");
  }
}
export class AgentscrapeHttpError extends AgentscrapeProviderError {
  constructor(message: string, status: number, retryable = false) {
    super(message, retryable, status);
    this.name = "AgentscrapeHttpError";
  }
}
export class AgentscrapeTimeoutError extends AgentscrapeError {
  constructor(message: string) {
    super(redactDiagnostic(message), "timeout");
  }
}
export class AgentscrapeCancelledError extends AgentscrapeError {
  constructor(message = "operation cancelled") {
    super(redactDiagnostic(message), "cancelled");
  }
}
export function cancellationError(signal?: AbortSignal | null): AgentscrapeCancelledError {
  const reason = signal?.reason;
  const message =
    reason instanceof Error && reason.message ? reason.message : "operation cancelled";
  return new AgentscrapeCancelledError(message);
}
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw cancellationError(signal);
}
export class PresetConfigError extends AgentscrapeError {
  constructor(
    message: string,
    public readonly problems: string[] = [],
  ) {
    super(message, "config");
  }
}
export class PresetSelectionError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "selection");
  }
}
export class PresetOutputError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "output");
  }
}
export class AgentscrapeArtifactError extends AgentscrapeError {
  constructor(message: string) {
    super(redactDiagnostic(message), "output");
    this.name = "AgentscrapeArtifactError";
  }
}
export class PresetDriftError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "drift");
  }
}
/** Dedicated equivalent for historical corpus samples that expected Python ValueError. */
export class AgentscrapeValueError extends PresetDriftError {
  constructor(message: string) {
    super(message);
    this.name = "AgentscrapeValueError";
  }
}
/** Dedicated equivalent for historical corpus samples that expected Python RuntimeError. */
export class AgentscrapeRuntimeError extends AgentscrapeError {
  constructor(message: string) {
    super(message, "runtime");
    this.name = "AgentscrapeRuntimeError";
  }
}
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

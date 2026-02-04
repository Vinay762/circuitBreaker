import { CircuitBreakerState } from "./state";

export type CircuitBreakerRejectReason = "open" | "bulkhead" | "half_open_saturation";

export type FallbackReason = "open" | "failure" | "timeout" | "bulkhead" | "rejection";

export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly breakerState: CircuitBreakerState;
  readonly breakerName?: string;
}

export type ExecutionAction<T> = (context: ExecutionContext) => PromiseLike<T> | T;

export interface ExecutionOptions<T = unknown> {
  timeoutMs?: number;
  fallback?: FallbackHandler<T>;
  metadata?: Record<string, unknown>;
}

export type FallbackHandler<T> = (
  reason: FallbackReason,
  error: unknown,
  context: ExecutionContext
) => PromiseLike<T> | T;

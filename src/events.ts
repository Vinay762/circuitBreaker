import { MetricsSnapshot } from "./metrics";
import { CircuitBreakerState } from "./state";
import { CircuitBreakerRejectReason, FallbackReason } from "./types";

export interface StateChangeEvent {
  previous: CircuitBreakerState;
  current: CircuitBreakerState;
  reason?: string;
}

export interface SuccessEvent {
  state: CircuitBreakerState;
  durationMs: number;
}

export interface FailureEvent {
  state: CircuitBreakerState;
  error: unknown;
  durationMs: number;
}

export interface TimeoutEvent {
  state: CircuitBreakerState;
  durationMs: number;
}

export interface RejectEvent {
  state: CircuitBreakerState;
  error: Error;
  reason: CircuitBreakerRejectReason;
}

export interface FallbackEvent {
  state: CircuitBreakerState;
  reason: FallbackReason;
  error: unknown;
  result?: unknown;
  failed?: boolean;
}

export interface ThresholdBreachEvent {
  metric: "failureRate" | "slowCallRate";
  value: number;
  threshold: number;
  state: CircuitBreakerState;
}

export interface MetricsEvent {
  snapshot: MetricsSnapshot;
}

export interface QueueEvent {
  size: number;
  type: "enqueue" | "dequeue";
}

export interface CircuitBreakerEvents extends Record<string, unknown> {
  stateChange: StateChangeEvent;
  success: SuccessEvent;
  failure: FailureEvent;
  timeout: TimeoutEvent;
  reject: RejectEvent;
  fallback: FallbackEvent;
  thresholdBreach: ThresholdBreachEvent;
  metrics: MetricsEvent;
  queue: QueueEvent;
}

export type Listener<T> = (payload: T) => void;

export class EventDispatcher<E extends Record<string, unknown>> {
  private listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};

  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }

    this.listeners[event]!.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const handlers = this.listeners[event];
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      handler(payload);
    }
  }

  emitLazy<K extends keyof E>(event: K, payloadFactory: () => E[K]): void {
    const handlers = this.listeners[event];
    if (!handlers || handlers.size === 0) {
      return;
    }

    const payload = payloadFactory();
    for (const handler of handlers) {
      handler(payload);
    }
  }
}

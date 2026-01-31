import { CircuitBreakerState } from "./state";

export interface StateChangeEvent {
  previous: CircuitBreakerState;
  current: CircuitBreakerState;
}

export interface SuccessEvent {
  state: CircuitBreakerState;
  durationMs: number;
}

export interface FailureEvent {
  state: CircuitBreakerState;
  error: unknown;
}

export interface RejectEvent {
  state: CircuitBreakerState;
  error: Error;
}

export interface CircuitBreakerEvents extends Record<string, unknown> {
  stateChange: StateChangeEvent;
  success: SuccessEvent;
  failure: FailureEvent;
  reject: RejectEvent;
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
}

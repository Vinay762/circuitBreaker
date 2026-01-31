import { CircuitBreakerOpenError } from "./errors";
import { CircuitBreakerEvents, EventDispatcher, Listener } from "./events";
import { Metrics } from "./metrics";
import { CircuitBreakerState } from "./state";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  minRequests: number;
  openTimeoutMs: number;
  halfOpenMaxRequests: number;
}

export type ExecutionAction<T> = () => PromiseLike<T> | T;

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  private readonly metrics = new Metrics();
  private readonly emitter = new EventDispatcher<CircuitBreakerEvents>();

  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private lastOpenedAt: number | null = null;
  private halfOpenInFlight = 0;
  private halfOpenSuccessCount = 0;

  constructor(options: CircuitBreakerOptions) {
    this.options = this.validateOptions(options);
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  on<K extends keyof CircuitBreakerEvents>(event: K, listener: Listener<CircuitBreakerEvents[K]>): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof CircuitBreakerEvents>(event: K, listener: Listener<CircuitBreakerEvents[K]>): void {
    this.emitter.off(event, listener);
  }

  async execute<T>(action: ExecutionAction<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === CircuitBreakerState.OPEN) {
      this.rejectExecution();
    }

    let countedProbe = false;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.options.halfOpenMaxRequests) {
        this.rejectExecution();
      }

      this.halfOpenInFlight += 1;
      countedProbe = true;
    }

    const start = Date.now();

    try {
      const result = await action();
      this.handleSuccess();
      this.emitter.emit("success", {
        state: this.state,
        durationMs: Date.now() - start
      });
      return result;
    } catch (error) {
      this.handleFailure();
      this.emitter.emit("failure", {
        state: this.state,
        error
      });
      throw error;
    } finally {
      if (countedProbe) {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
    }
  }

  private handleSuccess(): void {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.options.halfOpenMaxRequests) {
        this.transitionTo(CircuitBreakerState.CLOSED);
      }
      return;
    }

    if (this.state === CircuitBreakerState.CLOSED) {
      this.metrics.recordSuccess();
    }
  }

  private handleFailure(): void {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.transitionTo(CircuitBreakerState.OPEN);
      return;
    }

    if (this.state !== CircuitBreakerState.CLOSED) {
      return;
    }

    this.metrics.recordFailure();

    if (this.metrics.totalCount < this.options.minRequests) {
      return;
    }

    if (this.metrics.failureRate > this.options.failureThreshold) {
      this.transitionTo(CircuitBreakerState.OPEN);
    }
  }

  private maybeTransitionFromOpen(): void {
    if (this.state !== CircuitBreakerState.OPEN || this.lastOpenedAt === null) {
      return;
    }

    const elapsed = Date.now() - this.lastOpenedAt;
    if (elapsed >= this.options.openTimeoutMs) {
      this.transitionTo(CircuitBreakerState.HALF_OPEN);
    }
  }

  private transitionTo(next: CircuitBreakerState): void {
    if (this.state === next) {
      return;
    }

    const previous = this.state;
    this.state = next;

    if (next === CircuitBreakerState.OPEN) {
      this.lastOpenedAt = Date.now();
      this.halfOpenInFlight = 0;
      this.halfOpenSuccessCount = 0;
    } else {
      this.lastOpenedAt = null;
      this.halfOpenInFlight = 0;
    }

    if (next === CircuitBreakerState.HALF_OPEN || next === CircuitBreakerState.CLOSED) {
      this.metrics.reset();
      this.halfOpenSuccessCount = 0;
    }

    this.emitter.emit("stateChange", { previous, current: next });
  }

  private rejectExecution(): never {
    const error = new CircuitBreakerOpenError();
    this.emitter.emit("reject", {
      state: this.state,
      error
    });
    throw error;
  }

  private validateOptions(options: CircuitBreakerOptions): CircuitBreakerOptions {
    const { failureThreshold, minRequests, openTimeoutMs, halfOpenMaxRequests } = options;

    if (!Number.isFinite(failureThreshold) || failureThreshold <= 0 || failureThreshold >= 1) {
      throw new Error("failureThreshold must be a number between 0 and 1");
    }

    if (!Number.isInteger(minRequests) || minRequests <= 0) {
      throw new Error("minRequests must be a positive integer");
    }

    if (!Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0) {
      throw new Error("openTimeoutMs must be a positive number");
    }

    if (!Number.isInteger(halfOpenMaxRequests) || halfOpenMaxRequests <= 0) {
      throw new Error("halfOpenMaxRequests must be a positive integer");
    }

    return { failureThreshold, minRequests, openTimeoutMs, halfOpenMaxRequests };
  }
}

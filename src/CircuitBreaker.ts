import {
  CircuitBreakerBulkheadRejectedError,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError
} from "./errors";
import { CircuitBreakerEvents, EventDispatcher, Listener } from "./events";
import { ExecutionOutcome, Metrics, MetricsSnapshot } from "./metrics";
import { CircuitBreakerState } from "./state";
import {
  CircuitBreakerRejectReason,
  ExecutionAction,
  ExecutionContext,
  ExecutionOptions,
  FallbackHandler,
  FallbackReason
} from "./types";

const systemClock = (): number => Date.now();

const DEFAULT_FALLBACK_TRIGGERS: Record<FallbackReason, boolean> = {
  open: true,
  timeout: true,
  failure: true,
  bulkhead: false,
  rejection: false
};

const DEFAULT_LATENCY_BUCKETS = [5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000];

export interface HalfOpenOptions {
  /**
   * Maximum concurrent probe executions allowed in HALF_OPEN.
   */
  maxConcurrentCalls?: number;
  /**
   * Number of successful probes required to transition back to CLOSED.
   */
  probeSuccessThreshold?: number;
  /**
   * Total probes allowed before forcing a re-open.
   */
  maxProbeRequests?: number;
}

export interface TimeoutOptions {
  enabled?: boolean;
  durationMs?: number;
}

export interface BulkheadOptions {
  enabled?: boolean;
  maxConcurrent?: number;
  queueLimit?: number;
}

export interface SlidingWindowOptions {
  windowDurationMs?: number;
  numberOfBuckets?: number;
}

export interface CircuitBreakerOptions {
  name?: string;
  failureRateThreshold?: number;
  slowCallRateThreshold?: number;
  slowCallDurationThresholdMs?: number;
  minimumRequestVolume?: number;
  openStateDelayMs?: number;
  halfOpen?: HalfOpenOptions;
  timeout?: TimeoutOptions;
  bulkhead?: BulkheadOptions;
  slidingWindow?: SlidingWindowOptions;
  latencyBuckets?: number[];
  fallback?: FallbackHandler<unknown>;
  fallbackTriggers?: Partial<Record<FallbackReason, boolean>>;
  clock?: () => number;
}

export interface CircuitBreakerResolvedOptions {
  name?: string;
  failureRateThreshold: number;
  slowCallRateThreshold: number;
  slowCallDurationThresholdMs: number;
  minimumRequestVolume: number;
  openStateDelayMs: number;
  halfOpen: Required<HalfOpenOptions>;
  timeout: Required<TimeoutOptions>;
  bulkhead: Required<BulkheadOptions>;
  slidingWindow: Required<SlidingWindowOptions>;
  fallbackTriggers: Record<FallbackReason, boolean>;
  latencyBuckets: number[];
  fallbackDefined: boolean;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  name?: string;
  inFlight: number;
  queued: number;
  metrics: MetricsSnapshot;
  halfOpen: {
    inFlight: number;
    successCount: number;
    attemptCount: number;
  };
}

interface NormalizedCircuitBreakerOptions extends CircuitBreakerResolvedOptions {
  fallback?: FallbackHandler<unknown>;
  clock: () => number;
}

interface GuardResult {
  probe: boolean;
}

interface GuardRejection {
  rejectReason: CircuitBreakerRejectReason;
  fallbackReason: FallbackReason;
  error: Error;
}

interface ExecutionResult<T> {
  outcome: ExecutionOutcome;
  duration: number;
  value?: T;
  error?: unknown;
}

const DEFAULT_NORMALIZED: NormalizedCircuitBreakerOptions = {
  name: undefined,
  failureRateThreshold: 0.5,
  slowCallRateThreshold: 0.5,
  slowCallDurationThresholdMs: 1000,
  minimumRequestVolume: 20,
  openStateDelayMs: 5000,
  halfOpen: {
    maxConcurrentCalls: 2,
    probeSuccessThreshold: 2,
    maxProbeRequests: 10
  },
  timeout: {
    enabled: true,
    durationMs: 2000
  },
  bulkhead: {
    enabled: false,
    maxConcurrent: 50,
    queueLimit: 0
  },
  slidingWindow: {
    windowDurationMs: 10000,
    numberOfBuckets: 10
  },
  fallbackTriggers: { ...DEFAULT_FALLBACK_TRIGGERS },
  latencyBuckets: DEFAULT_LATENCY_BUCKETS.slice(),
  fallbackDefined: false,
  fallback: undefined,
  clock: systemClock
};

export class CircuitBreaker {
  private options: NormalizedCircuitBreakerOptions;
  private readonly metrics: Metrics;
  private readonly emitter = new EventDispatcher<CircuitBreakerEvents>();
  private readonly queue: Array<() => void> = [];

  private readonly clock: () => number;
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private stateEnteredAt: number;
  private inFlight = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccessCount = 0;
  private halfOpenAttemptCount = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = this.normalizeOptions(options);
    this.clock = this.options.clock;
    this.stateEnteredAt = this.clock();

    this.metrics = new Metrics({
      windowDurationMs: this.options.slidingWindow.windowDurationMs,
      numberOfBuckets: this.options.slidingWindow.numberOfBuckets,
      slowCallDurationThresholdMs: this.options.slowCallDurationThresholdMs,
      latencyBuckets: this.options.latencyBuckets,
      clock: this.clock
    });
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getName(): string | undefined {
    return this.options.name;
  }

  getInFlightCount(): number {
    return this.inFlight;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getSnapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      name: this.options.name,
      inFlight: this.inFlight,
      queued: this.queue.length,
      metrics: this.metrics.snapshot(),
      halfOpen: {
        inFlight: this.halfOpenInFlight,
        successCount: this.halfOpenSuccessCount,
        attemptCount: this.halfOpenAttemptCount
      }
    };
  }

  getOptions(): CircuitBreakerResolvedOptions {
    return this.cloneResolvedOptions(this.options);
  }

  updateOptions(next: Partial<CircuitBreakerOptions>): void {
    this.options = this.normalizeOptions(next, this.options);
    this.metrics.updateOptions({
      windowDurationMs: this.options.slidingWindow.windowDurationMs,
      numberOfBuckets: this.options.slidingWindow.numberOfBuckets,
      slowCallDurationThresholdMs: this.options.slowCallDurationThresholdMs,
      latencyBuckets: this.options.latencyBuckets
    });
  }

  publishMetrics(): void {
    this.emitMetrics();
  }

  on<K extends keyof CircuitBreakerEvents>(event: K, listener: Listener<CircuitBreakerEvents[K]>): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof CircuitBreakerEvents>(event: K, listener: Listener<CircuitBreakerEvents[K]>): void {
    this.emitter.off(event, listener);
  }

  async execute<T>(action: ExecutionAction<T>, execOptions: ExecutionOptions<T> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueueExecution(action, execOptions, resolve, reject);
    });
  }

  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => PromiseLike<TResult> | TResult,
    execOptions?: ExecutionOptions<TResult>
  ): (...args: TArgs) => Promise<TResult> {
    return (...args: TArgs) => this.execute(() => fn(...args), execOptions);
  }

  asHttpMiddleware<TReq = unknown, TRes = unknown>(
    handler: (req: TReq, res: TRes, next: (err?: unknown) => void) => Promise<void> | void,
    execOptions?: ExecutionOptions<void>
  ) {
    return (req: TReq, res: TRes, next: (err?: unknown) => void): void => {
      this.execute(() => handler(req, res, next), execOptions).catch(next);
    };
  }

  asGrpcInterceptor<TCall = unknown, TResult = unknown>(
    handler: (call: TCall, method: string, next: () => Promise<TResult>) => Promise<TResult>,
    execOptions?: ExecutionOptions<TResult>
  ) {
    return async (call: TCall, method: string, next: () => Promise<TResult>): Promise<TResult> => {
      return this.execute(() => handler(call, method, next), execOptions);
    };
  }

  forceOpen(reason = "manual"): void {
    this.transitionTo(CircuitBreakerState.OPEN, reason);
  }

  forceClose(reason = "manual"): void {
    this.transitionTo(CircuitBreakerState.CLOSED, reason);
  }

  private enqueueExecution<T>(
    action: ExecutionAction<T>,
    execOptions: ExecutionOptions<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): void {
    if (this.shouldApplyBulkhead()) {
      if (this.tryQueueExecution(action, execOptions, resolve, reject)) {
        return;
      }

      const controller = new AbortController();
      controller.abort();
      const context = this.buildExecutionContext(controller, execOptions.metadata);
      void this.rejectWithFallback("bulkhead", "bulkhead", new CircuitBreakerBulkheadRejectedError(), execOptions, context)
        .then(resolve)
        .catch(reject);
      return;
    }

    this.dispatchExecution(action, execOptions, resolve, reject);
  }

  private dispatchExecution<T>(
    action: ExecutionAction<T>,
    execOptions: ExecutionOptions<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): void {
    this.inFlight += 1;

    this.executeInternal(action, execOptions)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.drainQueue();
      });
  }

  private drainQueue(): void {
    if (!this.shouldApplyBulkhead() || this.queue.length === 0) {
      return;
    }

    while (this.queue.length > 0 && this.inFlight < this.options.bulkhead.maxConcurrent) {
      const task = this.queue.shift();
      if (!task) {
        break;
      }

      this.emitter.emit("queue", { size: this.queue.length, type: "dequeue" });
      task();
    }
  }

  private tryQueueExecution<T>(
    action: ExecutionAction<T>,
    execOptions: ExecutionOptions<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): boolean {
    if (!this.options.bulkhead.enabled) {
      return false;
    }

    if (this.inFlight < this.options.bulkhead.maxConcurrent) {
      return false;
    }

    if (this.options.bulkhead.queueLimit <= 0) {
      return false;
    }

    if (this.queue.length >= this.options.bulkhead.queueLimit) {
      return false;
    }

    this.queue.push(() => this.dispatchExecution(action, execOptions, resolve, reject));
    this.emitter.emit("queue", { size: this.queue.length, type: "enqueue" });
    return true;
  }

  private shouldApplyBulkhead(): boolean {
    return this.options.bulkhead.enabled && this.inFlight >= this.options.bulkhead.maxConcurrent;
  }

  private async executeInternal<T>(action: ExecutionAction<T>, execOptions: ExecutionOptions<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    const controller = new AbortController();
    const context = this.buildExecutionContext(controller, execOptions.metadata);
    const guard = this.guardState();

    if (!("probe" in guard)) {
      return this.rejectWithFallback(guard.rejectReason, guard.fallbackReason, guard.error, execOptions, context);
    }

    const { probe } = guard;
    const timeoutMs = this.resolveTimeout(execOptions);
    const result = await this.performAction(action, context, controller, timeoutMs);

    if (probe) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }

    this.metrics.recordExecution(result.outcome, result.duration);
    this.emitMetrics();

    if (result.outcome === "success") {
      this.emitter.emit("success", {
        state: this.state,
        durationMs: result.duration
      });
      this.onExecutionSuccess(probe);
      this.evaluateThresholds();
      return result.value as T;
    }

    if (result.outcome === "timeout") {
      this.emitter.emit("timeout", {
        state: this.state,
        durationMs: result.duration
      });
      return this.onTimeout(result.error, probe, context, execOptions);
    }

    this.emitter.emit("failure", {
      state: this.state,
      error: result.error,
      durationMs: result.duration
    });
    return this.onFailure(result.error, probe, context, execOptions);
  }

  private async performAction<T>(
    action: ExecutionAction<T>,
    context: ExecutionContext,
    controller: AbortController,
    timeoutMs?: number
  ): Promise<ExecutionResult<T>> {
    const start = this.clock();
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const executionPromise = Promise.resolve(action(context));
    const racingPromise = timeoutMs && timeoutMs > 0
      ? Promise.race<T>([
          executionPromise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new CircuitBreakerTimeoutError(timeoutMs));
            }, timeoutMs);
          })
        ])
      : executionPromise;

    try {
      const value = await racingPromise;
      return { outcome: "success", duration: this.clock() - start, value };
    } catch (error) {
      const duration = this.clock() - start;
      return {
        outcome: timedOut ? "timeout" : "failure",
        duration,
        error
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private guardState(): GuardResult | GuardRejection {
    if (this.state === CircuitBreakerState.OPEN) {
      return {
        rejectReason: "open",
        fallbackReason: "open",
        error: new CircuitBreakerOpenError()
      };
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.options.halfOpen.maxConcurrentCalls) {
        return {
          rejectReason: "half_open_saturation",
          fallbackReason: "open",
          error: new CircuitBreakerOpenError("Half-open probes saturated")
        };
      }

      if (this.halfOpenAttemptCount >= this.options.halfOpen.maxProbeRequests) {
        return {
          rejectReason: "half_open_saturation",
          fallbackReason: "open",
          error: new CircuitBreakerOpenError("Half-open probe budget exhausted")
        };
      }

      this.halfOpenInFlight += 1;
      this.halfOpenAttemptCount += 1;
      return { probe: true };
    }

    return { probe: false };
  }

  private async rejectWithFallback<T>(
    reason: CircuitBreakerRejectReason,
    fallbackReason: FallbackReason,
    error: Error,
    execOptions: ExecutionOptions<T>,
    context: ExecutionContext
  ): Promise<T> {
    this.metrics.recordRejection();
    this.emitMetrics();

    this.emitter.emit("reject", {
      state: this.state,
      error,
      reason
    });

    return this.tryFallback(fallbackReason, error, context, execOptions);
  }

  private async tryFallback<T>(
    reason: FallbackReason,
    error: unknown,
    context: ExecutionContext,
    execOptions: ExecutionOptions<T>
  ): Promise<T> {
    const handler = execOptions.fallback ?? this.options.fallback;
    const isAllowed = execOptions.fallback ? true : (this.options.fallbackTriggers[reason] ?? false);

    if (!handler || !isAllowed) {
      throw error;
    }

    try {
      const result = await handler(reason, error, context);
      this.emitter.emit("fallback", { state: this.state, reason, error, result });
      return result as T;
    } catch (fallbackError) {
      this.emitter.emit("fallback", { state: this.state, reason, error: fallbackError, failed: true });
      throw fallbackError;
    }
  }

  private onExecutionSuccess(probe: boolean): void {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.options.halfOpen.probeSuccessThreshold) {
        this.transitionTo(CircuitBreakerState.CLOSED, "probe-success");
      }
      return;
    }
  }

  private async onTimeout<T>(
    error: unknown,
    probe: boolean,
    context: ExecutionContext,
    execOptions: ExecutionOptions<T>
  ): Promise<T> {
    if (probe) {
      this.transitionTo(CircuitBreakerState.OPEN, "probe-timeout");
    } else if (this.state === CircuitBreakerState.CLOSED) {
      this.evaluateThresholds();
    }

    return this.tryFallback("timeout", error, context, execOptions);
  }

  private async onFailure<T>(
    error: unknown,
    probe: boolean,
    context: ExecutionContext,
    execOptions: ExecutionOptions<T>
  ): Promise<T> {
    if (probe) {
      this.transitionTo(CircuitBreakerState.OPEN, "probe-failure");
    } else if (this.state === CircuitBreakerState.CLOSED) {
      this.evaluateThresholds();
    }

    return this.tryFallback("failure", error, context, execOptions);
  }

  private resolveTimeout<T>(execOptions: ExecutionOptions<T>): number | undefined {
    if (typeof execOptions.timeoutMs === "number") {
      return execOptions.timeoutMs;
    }

    return this.options.timeout.enabled ? this.options.timeout.durationMs : undefined;
  }

  private buildExecutionContext(controller: AbortController, metadata?: Record<string, unknown>): ExecutionContext {
    return {
      signal: controller.signal,
      metadata,
      breakerState: this.state,
      breakerName: this.options.name
    };
  }

  private maybeTransitionFromOpen(): void {
    if (this.state !== CircuitBreakerState.OPEN) {
      return;
    }

    const elapsed = this.clock() - this.stateEnteredAt;
    if (elapsed >= this.options.openStateDelayMs) {
      this.transitionTo(CircuitBreakerState.HALF_OPEN, "open-timeout");
    }
  }

  private evaluateThresholds(): void {
    if (this.state !== CircuitBreakerState.CLOSED) {
      return;
    }

    const snapshot = this.metrics.snapshot();
    if (snapshot.totals.total < this.options.minimumRequestVolume) {
      return;
    }

    if (snapshot.failureRate >= this.options.failureRateThreshold) {
      this.emitter.emit("thresholdBreach", {
        metric: "failureRate",
        value: snapshot.failureRate,
        threshold: this.options.failureRateThreshold,
        state: this.state
      });
      this.transitionTo(CircuitBreakerState.OPEN, "failure-rate");
      return;
    }

    if (snapshot.slowCallRate >= this.options.slowCallRateThreshold) {
      this.emitter.emit("thresholdBreach", {
        metric: "slowCallRate",
        value: snapshot.slowCallRate,
        threshold: this.options.slowCallRateThreshold,
        state: this.state
      });
      this.transitionTo(CircuitBreakerState.OPEN, "slow-call-rate");
    }
  }

  private transitionTo(next: CircuitBreakerState, reason?: string): void {
    if (this.state === next) {
      return;
    }

    const previous = this.state;
    this.state = next;
    this.stateEnteredAt = this.clock();
    this.halfOpenInFlight = 0;
    this.halfOpenSuccessCount = 0;
    this.halfOpenAttemptCount = 0;

    if (next === CircuitBreakerState.HALF_OPEN || next === CircuitBreakerState.CLOSED) {
      this.metrics.reset();
      this.emitMetrics();
    }

    this.emitter.emit("stateChange", { previous, current: next, reason });
  }

  private emitMetrics(): void {
    this.emitter.emitLazy("metrics", () => ({ snapshot: this.metrics.snapshot() }));
  }

  private cloneResolvedOptions(source: NormalizedCircuitBreakerOptions): CircuitBreakerResolvedOptions {
    return {
      name: source.name,
      failureRateThreshold: source.failureRateThreshold,
      slowCallRateThreshold: source.slowCallRateThreshold,
      slowCallDurationThresholdMs: source.slowCallDurationThresholdMs,
      minimumRequestVolume: source.minimumRequestVolume,
      openStateDelayMs: source.openStateDelayMs,
      halfOpen: { ...source.halfOpen },
      timeout: { ...source.timeout },
      bulkhead: { ...source.bulkhead },
      slidingWindow: { ...source.slidingWindow },
      fallbackTriggers: { ...source.fallbackTriggers },
      latencyBuckets: source.latencyBuckets.slice(),
      fallbackDefined: Boolean(source.fallback)
    };
  }

  private normalizeOptions(
    next: Partial<CircuitBreakerOptions>,
    previous: NormalizedCircuitBreakerOptions | null = null
  ): NormalizedCircuitBreakerOptions {
    const base = previous ?? DEFAULT_NORMALIZED;
    const clock = previous?.clock ?? next.clock ?? base.clock;

    const normalizedHalfOpen: Required<HalfOpenOptions> = {
      maxConcurrentCalls: this.ensurePositiveInteger(
        next.halfOpen?.maxConcurrentCalls ?? base.halfOpen.maxConcurrentCalls,
        "halfOpen.maxConcurrentCalls"
      ),
      probeSuccessThreshold: this.ensurePositiveInteger(
        next.halfOpen?.probeSuccessThreshold ?? base.halfOpen.probeSuccessThreshold,
        "halfOpen.probeSuccessThreshold"
      ),
      maxProbeRequests: this.ensurePositiveInteger(
        next.halfOpen?.maxProbeRequests ?? base.halfOpen.maxProbeRequests,
        "halfOpen.maxProbeRequests"
      )
    };

    const normalizedTimeout: Required<TimeoutOptions> = {
      enabled: next.timeout?.enabled ?? base.timeout.enabled,
      durationMs: this.ensurePositiveNumber(
        next.timeout?.durationMs ?? base.timeout.durationMs,
        "timeout.durationMs"
      )
    };

    const normalizedBulkhead: Required<BulkheadOptions> = {
      enabled: next.bulkhead?.enabled ?? base.bulkhead.enabled,
      maxConcurrent: this.ensurePositiveInteger(
        next.bulkhead?.maxConcurrent ?? base.bulkhead.maxConcurrent,
        "bulkhead.maxConcurrent"
      ),
      queueLimit: Math.max(
        0,
        Math.trunc(next.bulkhead?.queueLimit ?? base.bulkhead.queueLimit)
      )
    };

    const normalizedSlidingWindow: Required<SlidingWindowOptions> = {
      windowDurationMs: this.ensurePositiveNumber(
        next.slidingWindow?.windowDurationMs ?? base.slidingWindow.windowDurationMs,
        "slidingWindow.windowDurationMs"
      ),
      numberOfBuckets: this.ensurePositiveInteger(
        next.slidingWindow?.numberOfBuckets ?? base.slidingWindow.numberOfBuckets,
        "slidingWindow.numberOfBuckets"
      )
    };

    const latencyBuckets = next.latencyBuckets
      ? [...next.latencyBuckets].sort((a, b) => a - b)
      : base.latencyBuckets.slice();

    const fallbackTriggers = { ...base.fallbackTriggers, ...(next.fallbackTriggers ?? {}) };

    return {
      name: next.name ?? base.name,
      failureRateThreshold: this.ensureProbability(
        next.failureRateThreshold ?? base.failureRateThreshold,
        "failureRateThreshold"
      ),
      slowCallRateThreshold: this.ensureProbability(
        next.slowCallRateThreshold ?? base.slowCallRateThreshold,
        "slowCallRateThreshold"
      ),
      slowCallDurationThresholdMs: this.ensurePositiveNumber(
        next.slowCallDurationThresholdMs ?? base.slowCallDurationThresholdMs,
        "slowCallDurationThresholdMs"
      ),
      minimumRequestVolume: this.ensurePositiveInteger(
        next.minimumRequestVolume ?? base.minimumRequestVolume,
        "minimumRequestVolume"
      ),
      openStateDelayMs: this.ensurePositiveNumber(
        next.openStateDelayMs ?? base.openStateDelayMs,
        "openStateDelayMs"
      ),
      halfOpen: normalizedHalfOpen,
      timeout: normalizedTimeout,
      bulkhead: normalizedBulkhead,
      slidingWindow: normalizedSlidingWindow,
      fallbackTriggers,
      latencyBuckets,
      fallbackDefined: Boolean(next.fallback ?? base.fallback),
      fallback: next.fallback ?? base.fallback,
      clock
    };
  }

  private ensurePositiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
    return value;
  }

  private ensurePositiveNumber(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number`);
    }
    return value;
  }

  private ensureProbability(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`${label} must be between 0 and 1 (exclusive)`);
    }
    return value;
  }
}

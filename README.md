# Steady Circuit Breaker

A production-grade circuit breaker for Node.js ≥ 18 with deterministic state transitions, sliding-window metrics, timeout enforcement, bulkhead isolation, fallbacks, and observability hooks. It wraps any async/promise-based operation and prevents cascading failures by opening after sustained faults, probing for recovery, and closing once the downstream is healthy.

## How it works

```
CLOSED --(failure/slow rate > threshold)--> OPEN --(timer)--\
  ^                                                        |
  |                                                        v
  +-----(probe success threshold met)<-- HALF_OPEN --(probe failure/timeout)--> OPEN
```

- **CLOSED**: tracks rolling success/failure/slow rates in a time-based sliding window.
- **OPEN**: rejects work immediately, enforces per-call fallback, and waits for `openStateDelayMs`.
- **HALF_OPEN**: allows deterministic probe requests with isolation, success/failure thresholds, and probe budgets.

Additional guards prevent retry storms (no internal retries), enforce per-call timeouts, and integrate with bulkhead concurrency limits so a single dependency cannot starve the rest of the service.

## Quick start

```ts
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError
} from "steady-circuit-breaker";

const breaker = new CircuitBreaker({
  name: "billing-api",
  failureRateThreshold: 0.5,
  slowCallRateThreshold: 0.5,
  slowCallDurationThresholdMs: 500,
  minimumRequestVolume: 20,
  openStateDelayMs: 5_000,
  timeout: { enabled: true, durationMs: 2_000 },
  halfOpen: { maxConcurrentCalls: 2, probeSuccessThreshold: 2, maxProbeRequests: 4 },
  bulkhead: { enabled: true, maxConcurrent: 100, queueLimit: 50 },
  fallback: async (reason, error) => {
    metrics.count(`breaker.${reason}`);
    return cache.read("billing");
  }
});

export async function callBilling(metadata: Record<string, unknown>) {
  return breaker.execute(async ({ signal }) => {
    const res = await fetch("https://billing.service/api", { signal });
    if (!res.ok) throw new Error("billing failed");
    return res.json();
  }, { metadata });
}

try {
  const data = await callBilling({ requestId: ctx.id });
  console.log(data);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    logger.warn("billing still open");
  } else if (error instanceof CircuitBreakerTimeoutError) {
    logger.warn("billing timed out");
  }
  throw error;
}
```

- `execute(action, options?)` accepts an optional `ExecutionOptions` object per invocation for timeout overrides, metadata tags, or ad-hoc fallbacks.
- Fallbacks are invoked for specific reasons (`open`, `failure`, `timeout`, `bulkhead`, `rejection`) and emit dedicated events without polluting breaker metrics.

## Configuration & safe defaults

| Option | Default | Description |
| --- | --- | --- |
| `failureRateThreshold` | `0.5` | Failure+timeout rate required (within the sliding window) before tripping to OPEN. |
| `slowCallRateThreshold` | `0.5` | Slow-call rate required before opening (slow calls measured via `slowCallDurationThresholdMs`). |
| `slowCallDurationThresholdMs` | `1000` | Any call ≥ threshold counts as slow. |
| `minimumRequestVolume` | `20` | Minimum rolling volume before thresholds activate. |
| `openStateDelayMs` | `5000` | How long to stay OPEN before transitioning to HALF_OPEN. |
| `halfOpen.maxConcurrentCalls` | `2` | Concurrent probe limit in HALF_OPEN (overflow → rejection). |
| `halfOpen.probeSuccessThreshold` | `2` | Number of probe successes required to fully close. |
| `halfOpen.maxProbeRequests` | `10` | Total probe executions allowed per HALF_OPEN cycle before re-opening. |
| `timeout.enabled` / `timeout.durationMs` | `true / 2000` | Per-call hard timeout (abort signal + rejection). |
| `bulkhead.enabled` | `false` | Enable concurrency isolation (immediate rejection when the in-flight limit is reached). |
| `bulkhead.maxConcurrent` | `50` | Max concurrent executions guarded by the breaker. |
| `bulkhead.queueLimit` | `0` | Optional FIFO queue capacity when the bulkhead is saturated. |
| `slidingWindow.windowDurationMs` | `10000` | Rolling window length for metrics in milliseconds. |
| `slidingWindow.numberOfBuckets` | `10` | Buckets inside the rolling window (auto-rotated). |
| `latencyBuckets` | `[5,10,20,50,100,250,500,1000,2000,5000]` | Histogram boundaries in milliseconds. |
| `fallback` | `undefined` | Global fallback handler `(reason, error, context) => value`. |
| `fallbackTriggers` | `{ open:true, timeout:true, failure:true, bulkhead:false, rejection:false }` | Per-reason flags that opt-in to the fallback. |
| `clock` | `Date.now` | Injectable deterministic clock for tests. |

All options can be updated at runtime via `breaker.updateOptions(partial)`; updates are atomic and do not require recreation.

## Events & observability

```ts
breaker.on("stateChange", ({ previous, current, reason }) => alerts.log({ previous, current, reason }));
breaker.on("thresholdBreach", ({ metric, value, threshold }) => metrics.gauge(metric, value));
breaker.on("timeout", ({ durationMs }) => metrics.histogram("cb.timeout", durationMs));
breaker.on("fallback", ({ reason }) => metrics.count(`cb.fallback.${reason}`));
breaker.on("metrics", ({ snapshot }) => exporter.publish(snapshot));
breaker.on("queue", ({ size, type }) => bulkheadStats.observe({ type, size }));
```

Emitted events:

- `stateChange`: previous → current state with transition reason.
- `success`, `failure`, `timeout`: execution outcomes with durations.
- `reject`: open/half-open/bulkhead short-circuits with reason.
- `fallback`: fallback execution results and failures.
- `thresholdBreach`: failure-rate or slow-call breaches with measured value.
- `metrics`: export-friendly snapshots containing per-bucket counts, totals, failure/slow rates, rejection counts, and latency histograms.
- `queue`: enqueue/dequeue notifications when the bulkhead queue is used.

Use `breaker.publishMetrics()` to push snapshots on demand, or subscribe to the `metrics` channel for continuous export (Prometheus, OpenTelemetry, etc).

## Bulkheads, timeouts & retries

- **Bulkhead isolation**: `bulkhead.maxConcurrent` throttles in-flight requests; saturation raises a `CircuitBreakerBulkheadRejectedError` (optionally routed through fallback). Queues are FIFO and optional.
- **Timeout enforcement**: the breaker wraps every execution with an `AbortController`, performs a non-blocking `Promise.race`, and counts timeouts as failures. Timeout events surface via both thrown errors and metrics.
- **Retry awareness**: the breaker never retries or backoff internally. Compose it ahead of your retry library (`CircuitBreaker → Retry → Timeout`) to avoid retry storms.

## Fallbacks & graceful degradation

Fallbacks receive `(reason, error, context)` and run outside of breaker metrics. They execute for the configured reasons and can return cached data, default values, or alternate call paths. Failures inside the fallback are surfaced via a dedicated `fallback` event and never contaminate breaker counters.

```ts
const breaker = new CircuitBreaker({
  fallback: async (reason, error, { metadata }) => {
    metrics.count(`breaker.${reason}`);
    return redis.get(`cache:${metadata?.key}`);
  },
  fallbackTriggers: { open: true, timeout: true, failure: false }
});
```

Per-call fallbacks can be supplied via `breaker.execute(action, { fallback })` and always opt-in for that invocation.

## Middleware & wrappers

- `breaker.wrap(fn)` builds an idempotent function wrapper retaining the original signature.
- `breaker.asHttpMiddleware(handler)` produces an Express-style middleware that automatically rejects when the breaker is OPEN or the bulkhead is saturated.
- `breaker.asGrpcInterceptor(handler)` provides a generic interceptor factory for gRPC/Connect style middleware.

## Dynamic configuration & testing support

- `breaker.updateOptions(partial)` safely applies runtime overrides (thresholds, window sizes, bulkhead limits, etc).
- `breaker.getSnapshot()` returns `{ state, metrics, inFlight, queued, halfOpen }` for dashboards or integration tests.
- `breaker.forceOpen()` / `breaker.forceClose()` allow deterministic testing of downstream fallbacks and recoveries.
- Inject a deterministic clock (`clock: () => number`) to unit-test time-based logic without waiting for timers.

## Testing & build

```
npm test        # Vitest suite (deterministic clock, half-open probes, bulkhead behavior, etc)
npm run build   # emits dist/index.js, dist/index.cjs, dist/index.d.ts via tsup
```

## Project status

- Zero runtime dependencies
- Dual ESM/CJS with fully-typed exports
- Tree-shakable (`"sideEffects": false`)
- Targets strict TypeScript + Node.js ≥ 18

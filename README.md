# Steady Circuit Breaker

A tiny, deterministic circuit breaker for Node.js ≥ 18. It wraps any async/promise-based operation and prevents cascading failures by opening after sustained errors, probing for recovery, and closing again when healthy.

## What is a circuit breaker?
A circuit breaker watches the success/failure ratio of a dependency. When errors exceed a threshold, the breaker **opens** and short-circuits further calls, letting the dependency recover. After a cooldown it allows a limited number of **half-open** probes. If they succeed, the breaker **closes** and traffic resumes; if they fail, it re-opens.

```
CLOSED --(failure rate > threshold)--> OPEN
  ^                               |
  |                               |
  |                               v
  +----(all probes succeed)<--HALF_OPEN
        (any probe fails)---->
```

## Quick start
```ts
import { CircuitBreaker, CircuitBreakerOpenError } from "steady-circuit-breaker";

const breaker = new CircuitBreaker({
  failureThreshold: 0.6,
  minRequests: 10,
  openTimeoutMs: 5_000,
  halfOpenMaxRequests: 3
});

async function safeCall() {
  return breaker.execute(async () => {
    const res = await riskyOperation();
    return res.data;
  });
}

try {
  const data = await safeCall();
  console.log(data);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    // fast-fail: dependency is unhealthy; consider fallback
    return useCache();
  }
  throw error;
}
```

## Configuration
| option | type | description |
| --- | --- | --- |
| `failureThreshold` | `number (0-1)` | Failure rate that trips the breaker once `minRequests` have run. `0.5` means >50% failures trigger OPEN. |
| `minRequests` | `integer ≥ 1` | Minimum number of recorded calls before the failure rate is evaluated. Prevents noise. |
| `openTimeoutMs` | `number > 0` | Time to stay OPEN before allowing HALF_OPEN probe calls. |
| `halfOpenMaxRequests` | `integer ≥ 1` | Maximum concurrent probe executions allowed while HALF_OPEN. All must succeed to close; one failure re-opens immediately. |

## Event hooks
Subscribe to lifecycle hooks without decorators or global state:

```ts
const unsubscribe = breaker.on("stateChange", ({ previous, current }) => {
  telemetry.trackState(previous, current);
});

breaker.on("success", ({ durationMs }) => metrics.recordLatency(durationMs));
breaker.on("failure", ({ error }) => metrics.increment("cb.fail", error));
breaker.on("reject", () => alerts.warn("breaker open"));

// stop listening when finished
unsubscribe();
```

Hooks are synchronous fire-and-forget to avoid backpressure.

## Events
- `stateChange`: Fired on every state transition with `{ previous, current }`.
- `success`: Fired after an execution succeeds with `{ state, durationMs }`.
- `failure`: Fired when an execution throws/rejects with `{ state, error }`.
- `reject`: Fired when a call is short-circuited with `{ state, error }`.

## Testing & build
```
npm test   # runs Vitest
npm run build   # emits dist/index.js, dist/index.cjs, dist/index.d.ts
```

## Non-goals
This library intentionally avoids the following (by design for V1):
- HTTP/middleware integrations
- Retries, rate limiting, bulkheads, backoff
- Distributed/shared state or Redis
- Metrics exporters or dashboards
- Decorators, reflection, or framework bindings
- Sliding time windows or adaptive configuration

## Project status
- Zero runtime dependencies
- Dual ESM/CJS with type declarations
- Tree-shakable (`"sideEffects": false`)
- Targets strict TypeScript + Node.js ≥ 18

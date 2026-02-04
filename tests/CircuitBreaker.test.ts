import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerBulkheadRejectedError,
  CircuitBreakerOpenError,
  CircuitBreakerState,
  CircuitBreakerTimeoutError
} from "../src";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("CircuitBreaker", () => {
  it("opens when failure rate exceeds threshold once minimum volume is observed", async () => {
    const breaker = new CircuitBreaker({
      failureRateThreshold: 0.5,
      minimumRequestVolume: 4,
      timeout: { enabled: false },
      openStateDelayMs: 1000,
      halfOpen: {
        maxConcurrentCalls: 1,
        probeSuccessThreshold: 1,
        maxProbeRequests: 1
      }
    });

    await breaker.execute(async () => "ok");
    await expect(breaker.execute(async () => {
      throw new Error("boom-1");
    })).rejects.toThrow("boom-1");

    await expect(breaker.execute(async () => {
      throw new Error("boom-2");
    })).rejects.toThrow("boom-2");

    await expect(breaker.execute(async () => {
      throw new Error("boom-3");
    })).rejects.toThrow("boom-3");

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it("detects slow calls and trips when the slow call rate breaches the threshold", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      slowCallRateThreshold: 0.6,
      slowCallDurationThresholdMs: 10,
      minimumRequestVolume: 2,
      timeout: { enabled: false },
      failureRateThreshold: 0.75
    });

    const slowAction = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("slow"), 20);
      });

    const exec1 = breaker.execute(slowAction);
    vi.advanceTimersByTime(20);
    await expect(exec1).resolves.toBe("slow");

    const exec2 = breaker.execute(slowAction);
    vi.advanceTimersByTime(20);
    await expect(exec2).resolves.toBe("slow");

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    vi.useRealTimers();
  });

  it("respects timeouts, counts them as failures, and recovers via half-open probes", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      timeout: { enabled: true, durationMs: 25 },
      failureRateThreshold: 0.5,
      minimumRequestVolume: 1,
      openStateDelayMs: 50,
      halfOpen: {
        maxConcurrentCalls: 1,
        probeSuccessThreshold: 1,
        maxProbeRequests: 1
      }
    });

    const neverResolving = breaker.execute(() => new Promise<string>(() => undefined));
    vi.advanceTimersByTime(30);
    await expect(neverResolving).rejects.toBeInstanceOf(CircuitBreakerTimeoutError);
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

    await expect(breaker.execute(async () => "reject"))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError);

    vi.advanceTimersByTime(50);
    await expect(breaker.execute(async () => "healthy")).resolves.toBe("healthy");
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    vi.useRealTimers();
  });

  it("limits half-open probes and short-circuits on probe failure", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureRateThreshold: 0.5,
      minimumRequestVolume: 1,
      openStateDelayMs: 10,
      halfOpen: {
        maxConcurrentCalls: 1,
        probeSuccessThreshold: 2,
        maxProbeRequests: 2
      },
      timeout: { enabled: false }
    });

    await expect(breaker.execute(async () => {
      throw new Error("trip");
    })).rejects.toThrow("trip");

    vi.advanceTimersByTime(10);

    const successProbe = breaker.execute(async () => "probe");
    await expect(breaker.execute(async () => "overflow"))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError);

    await expect(breaker.execute(async () => {
      throw new Error("probe-failure");
    })).rejects.toThrow("probe-failure");

    await expect(successProbe).resolves.toBe("probe");
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    vi.useRealTimers();
  });

  it("applies bulkhead limits and rejects immediately when saturated", async () => {
    const breaker = new CircuitBreaker({
      bulkhead: { enabled: true, maxConcurrent: 1, queueLimit: 0 },
      timeout: { enabled: false }
    });

    const inflight = deferred<string>();
    const first = breaker.execute(() => inflight.promise);
    const second = breaker.execute(async () => "second");

    await expect(second).rejects.toBeInstanceOf(CircuitBreakerBulkheadRejectedError);

    inflight.resolve("done");
    await expect(first).resolves.toBe("done");
  });

  it("invokes a configured fallback when the circuit is open", async () => {
    const fallback = vi.fn().mockResolvedValue("cached");
    const breaker = new CircuitBreaker({
      failureRateThreshold: 0.5,
      minimumRequestVolume: 1,
      fallback,
      fallbackTriggers: {
        open: true,
        failure: false,
        timeout: false,
        bulkhead: false,
        rejection: false
      },
      openStateDelayMs: 100,
      timeout: { enabled: false },
      halfOpen: {
        maxConcurrentCalls: 1,
        probeSuccessThreshold: 1,
        maxProbeRequests: 1
      }
    });

    await expect(breaker.execute(async () => {
      throw new Error("trip");
    })).rejects.toThrow("trip");

    const result = await breaker.execute(async () => "should-not-run");
    expect(result).toBe("cached");
    expect(fallback).toHaveBeenCalled();
  });

  it("supports dynamic config updates at runtime", async () => {
    const breaker = new CircuitBreaker({
      failureRateThreshold: 0.5,
      minimumRequestVolume: 10,
      timeout: { enabled: false },
      openStateDelayMs: 100
    });

    await expect(breaker.execute(async () => {
      throw new Error("first");
    })).rejects.toThrow("first");
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);

    breaker.updateOptions({ minimumRequestVolume: 1 });

    await expect(breaker.execute(async () => {
      throw new Error("second");
    })).rejects.toThrow("second");

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });
});

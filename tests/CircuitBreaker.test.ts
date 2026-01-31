import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerState
} from "../src";

const baseOptions = {
  failureThreshold: 0.5,
  minRequests: 4,
  openTimeoutMs: 1000,
  halfOpenMaxRequests: 2
};

describe("CircuitBreaker", () => {
  it("transitions to OPEN when failure rate exceeds threshold after minRequests", async () => {
    const breaker = new CircuitBreaker(baseOptions);

    await breaker.execute(async () => "ok");
    await expect(breaker.execute(async () => {
      throw new Error("fail-1");
    })).rejects.toThrow("fail-1");

    await expect(breaker.execute(async () => {
      throw new Error("fail-2");
    })).rejects.toThrow("fail-2");

    await expect(breaker.execute(async () => {
      throw new Error("fail-3");
    })).rejects.toThrow("fail-3");

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it("ignores failure rate until minRequests have been observed", async () => {
    const breaker = new CircuitBreaker({ ...baseOptions, minRequests: 5 });

    await expect(breaker.execute(async () => {
      throw new Error("fail-a");
    })).rejects.toThrow();

    await expect(breaker.execute(async () => {
      throw new Error("fail-b");
    })).rejects.toThrow();

    await expect(breaker.execute(async () => {
      throw new Error("fail-c");
    })).rejects.toThrow();

    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it("moves from OPEN to HALF_OPEN after the timeout and closes on successful probes", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      minRequests: 1,
      openTimeoutMs: 5000,
      halfOpenMaxRequests: 1
    });

    await expect(breaker.execute(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

    await expect(breaker.execute(async () => "ok"))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError);

    vi.advanceTimersByTime(5000);

    await expect(breaker.execute(async () => "healthy"))
      .resolves.toBe("healthy");

    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    vi.useRealTimers();
  });

  it("enforces half-open probe limits and rejects overflow requests", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      minRequests: 1,
      openTimeoutMs: 1000,
      halfOpenMaxRequests: 2
    });

    await expect(breaker.execute(async () => {
      throw new Error("trip");
    })).rejects.toThrow();

    vi.advanceTimersByTime(1000);

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    const a = deferred();
    const b = deferred();

    const execA = breaker.execute(() => a.promise.then(() => "A"));
    const execB = breaker.execute(() => b.promise.then(() => "B"));

    await expect(breaker.execute(async () => "overflow"))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError);

    a.resolve();
    b.resolve();

    await expect(execA).resolves.toBe("A");
    await expect(execB).resolves.toBe("B");

    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    vi.useRealTimers();
  });

  it("returns to OPEN if any half-open probe fails", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      minRequests: 1,
      openTimeoutMs: 250,
      halfOpenMaxRequests: 2
    });

    await expect(breaker.execute(async () => {
      throw new Error("trip");
    })).rejects.toThrow();
    vi.advanceTimersByTime(250);

    const successDeferred = new Promise<string>((resolve) => {
      setTimeout(() => resolve("success"), 0);
    });

    const successPromise = breaker.execute(() => successDeferred);
    const failurePromise = breaker.execute(async () => {
      throw new Error("probe fail");
    });

    await expect(failurePromise).rejects.toThrow("probe fail");
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);

    vi.advanceTimersByTime(250);
    await expect(breaker.execute(async () => "healthy"))
      .resolves.toBe("healthy");
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);

    await expect(successPromise).resolves.toBe("success");
    vi.useRealTimers();
  });

  it("emits a single OPEN transition even with concurrent failures", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      minRequests: 2,
      openTimeoutMs: 1000,
      halfOpenMaxRequests: 1
    });

    const openTransitions: CircuitBreakerState[] = [];
    breaker.on("stateChange", ({ current }) => {
      if (current === CircuitBreakerState.OPEN) {
        openTransitions.push(current);
      }
    });

    const failingAction = async () => {
      throw new Error("boom");
    };

    await Promise.allSettled([
      breaker.execute(failingAction),
      breaker.execute(failingAction),
      breaker.execute(failingAction),
      breaker.execute(failingAction)
    ]);

    expect(openTransitions).toHaveLength(1);
    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });
});

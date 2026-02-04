export class CircuitBreakerOpenError extends Error {
  constructor(message = "Circuit breaker is open") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreakerTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Circuit breaker execution timed out after ${timeoutMs}ms`);
    this.name = "CircuitBreakerTimeoutError";
  }
}

export class CircuitBreakerBulkheadRejectedError extends Error {
  constructor(message = "Circuit breaker bulkhead limit reached") {
    super(message);
    this.name = "CircuitBreakerBulkheadRejectedError";
  }
}

export class Metrics {
  private successCount = 0;
  private failureCount = 0;

  recordSuccess(): void {
    this.successCount += 1;
  }

  recordFailure(): void {
    this.failureCount += 1;
  }

  get totalCount(): number {
    return this.successCount + this.failureCount;
  }

  get failureRate(): number {
    const total = this.totalCount;
    if (total === 0) {
      return 0;
    }

    return this.failureCount / total;
  }

  reset(): void {
    this.successCount = 0;
    this.failureCount = 0;
  }
}

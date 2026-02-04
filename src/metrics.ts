export interface MetricsWindowOptions {
  windowDurationMs: number;
  numberOfBuckets: number;
  slowCallDurationThresholdMs: number;
  latencyBuckets: number[];
  clock?: () => number;
}

export interface MetricCounts {
  total: number;
  success: number;
  failure: number;
  timeout: number;
  slow: number;
  rejected: number;
}

export type ExecutionOutcome = "success" | "failure" | "timeout";

const DEFAULT_LATENCY_BUCKETS = [5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000];

interface Bucket {
  startTime: number;
  counts: MetricCounts;
  latencyHistogram: number[];
}

export interface MetricsSnapshot {
  windowDurationMs: number;
  bucketDurationMs: number;
  buckets: Array<{ startTime: number; counts: MetricCounts }>;
  totals: MetricCounts;
  latencyHistogram: number[];
  failureRate: number;
  slowCallRate: number;
  lastUpdatedAt: number;
}

const zeroCounts = (): MetricCounts => ({
  total: 0,
  success: 0,
  failure: 0,
  timeout: 0,
  slow: 0,
  rejected: 0
});

const cloneCounts = (counts: MetricCounts): MetricCounts => ({ ...counts });

const defaultClock = (): number => Date.now();

export class Metrics {
  private readonly clock: () => number;
  private options: MetricsWindowOptions;
  private readonly buckets: Bucket[] = [];
  private currentBucketIndex = 0;
  private bucketDurationMs: number;
  private lastUpdatedAt = 0;

  constructor(options: MetricsWindowOptions) {
    this.options = this.validateOptions(options);
    this.clock = this.options.clock ?? defaultClock;
    this.bucketDurationMs = Math.max(1, Math.floor(this.options.windowDurationMs / this.options.numberOfBuckets));

    for (let i = 0; i < this.options.numberOfBuckets; i += 1) {
      this.buckets.push(this.createBucket(0));
    }
  }

  updateOptions(options: Partial<MetricsWindowOptions>): void {
    const merged: MetricsWindowOptions = {
      ...this.options,
      ...options,
      latencyBuckets: options.latencyBuckets ?? this.options.latencyBuckets,
      clock: options.clock ?? this.options.clock
    };
    const validated = this.validateOptions(merged);
    this.options = validated;
    this.bucketDurationMs = Math.max(1, Math.floor(validated.windowDurationMs / validated.numberOfBuckets));
    this.buckets.length = 0;
    for (let i = 0; i < this.options.numberOfBuckets; i += 1) {
      this.buckets.push(this.createBucket(0));
    }
    this.currentBucketIndex = 0;
    this.lastUpdatedAt = 0;
  }

  recordExecution(outcome: ExecutionOutcome, durationMs: number): void {
    const now = this.clock();
    const bucket = this.rotateBucket(now);

    bucket.counts.total += 1;

    if (outcome === "success") {
      bucket.counts.success += 1;
    } else if (outcome === "failure") {
      bucket.counts.failure += 1;
    } else {
      bucket.counts.timeout += 1;
    }

    if (durationMs >= this.options.slowCallDurationThresholdMs) {
      bucket.counts.slow += 1;
    }

    this.recordLatency(bucket.latencyHistogram, durationMs);
    this.lastUpdatedAt = now;
  }

  recordRejection(): void {
    const now = this.clock();
    const bucket = this.rotateBucket(now);
    bucket.counts.rejected += 1;
    this.lastUpdatedAt = now;
  }

  reset(): void {
    for (const bucket of this.buckets) {
      this.resetBucket(bucket, 0);
    }
    this.currentBucketIndex = 0;
    this.lastUpdatedAt = 0;
  }

  snapshot(): MetricsSnapshot {
    const now = this.clock();
    this.rotateBucket(now);

    const totals = zeroCounts();
    const latencyHistogram = new Array(this.options.latencyBuckets.length + 1).fill(0);

    const buckets = this.buckets.map((bucket) => {
      this.addCounts(totals, bucket.counts);
      for (let i = 0; i < bucket.latencyHistogram.length; i += 1) {
        latencyHistogram[i] += bucket.latencyHistogram[i];
      }

      return {
        startTime: bucket.startTime,
        counts: cloneCounts(bucket.counts)
      };
    });

    const failureDenominator = Math.max(1, totals.total);
    const failureRate = (totals.failure + totals.timeout) / failureDenominator;
    const slowCallRate = totals.total === 0 ? 0 : totals.slow / totals.total;

    return {
      windowDurationMs: this.options.windowDurationMs,
      bucketDurationMs: this.bucketDurationMs,
      buckets,
      totals: cloneCounts(totals),
      latencyHistogram,
      failureRate,
      slowCallRate,
      lastUpdatedAt: this.lastUpdatedAt
    };
  }

  private validateOptions(options: MetricsWindowOptions): MetricsWindowOptions {
    const { windowDurationMs, numberOfBuckets, slowCallDurationThresholdMs } = options;

    if (!Number.isFinite(windowDurationMs) || windowDurationMs <= 0) {
      throw new Error("windowDurationMs must be a positive number");
    }

    if (!Number.isInteger(numberOfBuckets) || numberOfBuckets <= 0) {
      throw new Error("numberOfBuckets must be a positive integer");
    }

    if (!Number.isFinite(slowCallDurationThresholdMs) || slowCallDurationThresholdMs <= 0) {
      throw new Error("slowCallDurationThresholdMs must be positive");
    }

    return {
      windowDurationMs,
      numberOfBuckets,
      slowCallDurationThresholdMs,
      latencyBuckets: options.latencyBuckets && options.latencyBuckets.length > 0
        ? [...options.latencyBuckets].sort((a, b) => a - b)
        : DEFAULT_LATENCY_BUCKETS.slice(),
      clock: options.clock
    };
  }

  private recordLatency(histogram: number[], durationMs: number): void {
    let index = histogram.length - 1;
    for (let i = 0; i < this.options.latencyBuckets.length; i += 1) {
      if (durationMs <= this.options.latencyBuckets[i]) {
        index = i;
        break;
      }
    }
    histogram[index] += 1;
  }

  private rotateBucket(now: number): Bucket {
    const bucket = this.buckets[this.currentBucketIndex];
    const bucketDuration = this.bucketDurationMs;

    if (bucket.startTime === 0) {
      const aligned = now - (now % bucketDuration);
      this.resetBucket(bucket, aligned);
      return bucket;
    }

    if (now - bucket.startTime < bucketDuration) {
      return bucket;
    }

    const steps = Math.min(
      this.options.numberOfBuckets,
      Math.floor((now - bucket.startTime) / bucketDuration)
    );

    let referenceStart = bucket.startTime;
    for (let i = 0; i < steps; i += 1) {
      this.currentBucketIndex = (this.currentBucketIndex + 1) % this.options.numberOfBuckets;
      const nextBucket = this.buckets[this.currentBucketIndex];
      referenceStart += bucketDuration;
      this.resetBucket(nextBucket, referenceStart);
    }

    return this.buckets[this.currentBucketIndex];
  }

  private createBucket(startTime: number): Bucket {
    return {
      startTime,
      counts: zeroCounts(),
      latencyHistogram: new Array(this.options.latencyBuckets.length + 1).fill(0)
    };
  }

  private resetBucket(bucket: Bucket, startTime: number): void {
    bucket.startTime = startTime;
    bucket.counts.total = 0;
    bucket.counts.success = 0;
    bucket.counts.failure = 0;
    bucket.counts.timeout = 0;
    bucket.counts.slow = 0;
    bucket.counts.rejected = 0;
    bucket.latencyHistogram.fill(0);
  }

  private addCounts(target: MetricCounts, counts: MetricCounts): void {
    target.total += counts.total;
    target.success += counts.success;
    target.failure += counts.failure;
    target.timeout += counts.timeout;
    target.slow += counts.slow;
    target.rejected += counts.rejected;
  }
}

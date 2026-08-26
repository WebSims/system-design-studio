/**
 * A log-bucket (HdrHistogram-style) histogram for latency percentiles.
 *
 * WHY NOT JUST KEEP THE SAMPLES
 *
 * A 60-second run at a few thousand requests per second produces millions of
 * samples. Retaining and sorting them costs memory proportional to the run and
 * makes a capacity sweep (dozens of runs) untenable. This structure is O(1) per
 * record with bounded memory, and is *mergeable*, which matters for combining
 * per-node histograms and for parallel sweeps later.
 *
 * WHY NOT JUST THE MEAN
 *
 * The legacy engine reported a mean over a 1-second window (engine.jsx:358-363),
 * which is not a metric anyone operates on. Queueing systems have tails that are
 * orders of magnitude above the mean, and the tail is the part that violates an
 * SLO. A tool that reports only a mean will call a system healthy while 1% of
 * users time out.
 *
 * ACCURACY
 *
 * Values are bucketed with a fixed relative precision: each power-of-two
 * magnitude is subdivided into `subBuckets` linear slots, so the worst-case
 * error on any reported percentile is bounded by 1/subBuckets (~0.8% at the
 * default 128). That bound is reported by `relativeError` so the UI can state
 * its own precision instead of implying exactness.
 */
export class LatencyHistogram {
  private readonly subBucketBits: number;
  private readonly subBuckets: number;
  private readonly buckets = new Map<number, number>();

  private _count = 0;
  private _sum = 0;
  private _min = Number.POSITIVE_INFINITY;
  private _max = 0;

  constructor(subBucketBits = 7) {
    this.subBucketBits = subBucketBits;
    this.subBuckets = 1 << subBucketBits;
  }

  get count(): number {
    return this._count;
  }
  get sum(): number {
    return this._sum;
  }
  get mean(): number {
    return this._count === 0 ? 0 : this._sum / this._count;
  }
  get min(): number {
    return this._count === 0 ? 0 : this._min;
  }
  get max(): number {
    return this._max;
  }
  /** Bound on the relative error of any reported percentile. */
  get relativeError(): number {
    return 1 / this.subBuckets;
  }

  /**
   * Index a value into (magnitude, sub-bucket).
   *
   * Sub-millisecond values all land in index 0's low slots; latency below the
   * resolution of the model itself does not warrant more precision.
   */
  private indexOf(value: number): number {
    if (value <= 0) return 0;
    const magnitude = Math.floor(Math.log2(value));
    if (magnitude < 0) return 0;
    const base = Math.pow(2, magnitude);
    const sub = Math.floor(((value - base) / base) * this.subBuckets);
    return (magnitude << this.subBucketBits) + Math.min(sub, this.subBuckets - 1);
  }

  /** Representative (lower-edge) value of a bucket index. */
  private valueOf(index: number): number {
    const magnitude = index >> this.subBucketBits;
    const sub = index & (this.subBuckets - 1);
    const base = Math.pow(2, magnitude);
    return base + (sub * base) / this.subBuckets;
  }

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`latency must be a finite non-negative number, got ${value}`);
    }
    const i = this.indexOf(value);
    this.buckets.set(i, (this.buckets.get(i) ?? 0) + 1);
    this._count++;
    this._sum += value;
    if (value < this._min) this._min = value;
    if (value > this._max) this._max = value;
  }

  /** `q` in [0,1]. Returns 0 for an empty histogram. */
  quantile(q: number): number {
    if (this._count === 0) return 0;
    if (q <= 0) return this.min;
    if (q >= 1) return this.max;
    const target = q * this._count;
    const indices = [...this.buckets.keys()].sort((a, b) => a - b);
    let cumulative = 0;
    for (const i of indices) {
      cumulative += this.buckets.get(i)!;
      if (cumulative >= target) {
        // Clamp to observed extremes: a bucket lower edge can otherwise sit
        // below the true minimum and report a latency that never occurred.
        return Math.min(this._max, Math.max(this._min, this.valueOf(i)));
      }
    }
    return this._max;
  }

  percentiles(): { p50: number; p90: number; p99: number; p999: number } {
    return {
      p50: this.quantile(0.5),
      p90: this.quantile(0.9),
      p99: this.quantile(0.99),
      p999: this.quantile(0.999),
    };
  }

  /** Fold another histogram in. Enables per-node rollups and parallel sweeps. */
  merge(other: LatencyHistogram): void {
    if (other.subBucketBits !== this.subBucketBits) {
      throw new Error("cannot merge histograms with different precision");
    }
    for (const [i, n] of other.buckets) {
      this.buckets.set(i, (this.buckets.get(i) ?? 0) + n);
    }
    this._count += other._count;
    this._sum += other._sum;
    if (other._count > 0) {
      this._min = Math.min(this._min, other._min);
      this._max = Math.max(this._max, other._max);
    }
  }

  reset(): void {
    this.buckets.clear();
    this._count = 0;
    this._sum = 0;
    this._min = Number.POSITIVE_INFINITY;
    this._max = 0;
  }
}

import type { Rng } from "./rng";

/**
 * Zipf-distributed key sampling.
 *
 * Real cache access is heavily skewed: a small set of keys takes most of the
 * traffic. That skew is the entire reason a cache holding 10% of the key space can
 * serve 80% of requests. A uniform model would say a cache that size gets a 10%
 * hit ratio and would therefore conclude, wrongly, that caching is not worth it.
 *
 * WHY THIS SIMULATES RATHER THAN ASSUMES
 *
 * The cache component does not take a hit ratio as input and apply it. It samples
 * a key, looks it up in a real LRU map with real TTL expiry, and a miss really does
 * call the origin. The hit ratio is therefore an OUTPUT, which is what lets the
 * tool answer "how much cache do I need" instead of demanding the answer as input.
 *
 * Sampling is exact by inverse transform over a precomputed cumulative table.
 * O(log n) per draw, O(n) memory once per run. An analytic approximation would
 * have been cheaper, but the simulation is meant to be the ground truth that
 * approximations are checked against -- so it does the arithmetic properly.
 */
export class ZipfSampler {
  private readonly cumulative: Float64Array;

  constructor(
    readonly keys: number,
    readonly skew: number
  ) {
    // Weight of rank i (1-based) is i^-skew. skew = 0 is uniform.
    const cumulative = new Float64Array(keys);
    let total = 0;
    for (let i = 0; i < keys; i++) {
      total += skew === 0 ? 1 : Math.pow(i + 1, -skew);
      cumulative[i] = total;
    }
    // Normalise in place so a draw is a plain binary search on [0,1).
    for (let i = 0; i < keys; i++) cumulative[i] = cumulative[i]! / total;
    this.cumulative = cumulative;
  }

  /** Draw a key rank in [0, keys). Rank 0 is the most popular. */
  sample(rng: Rng): number {
    const u = rng.next();
    // Binary search for the first cumulative value strictly greater than u.
    let lo = 0;
    let hi = this.keys - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cumulative[mid]! > u) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Share of requests falling on the `n` most popular keys.
   *
   * This is the hit ratio a perfect cache of capacity `n` would achieve, which is
   * an upper bound on what LRU achieves. Used by the analytic preview, and the
   * simulation is expected to come in slightly under it -- LRU wastes some
   * capacity on keys that will not be requested again soon.
   */
  massOfTop(n: number): number {
    if (n <= 0) return 0;
    if (n >= this.keys) return 1;
    return this.cumulative[n - 1]!;
  }
}

/**
 * Closed-form top-n mass for a Zipf population, without building the table.
 *
 * Used by the analytic preview, which must stay fast enough to run on every
 * keystroke. Exact for small populations and a continuous approximation of the
 * generalized harmonic number above the exact threshold.
 */
export function zipfTopMass(keys: number, skew: number, n: number): number {
  if (n <= 0) return 0;
  if (n >= keys) return 1;
  if (skew === 0) return n / keys;
  return harmonic(n, skew) / harmonic(keys, skew);
}

const EXACT_LIMIT = 10_000;

/** Generalized harmonic number H(n, s) = sum_{i=1..n} i^-s. */
function harmonic(n: number, s: number): number {
  if (n <= EXACT_LIMIT) {
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += Math.pow(i, -s);
    return sum;
  }
  // Euler-Maclaurin: exact prefix plus an integral tail. Accurate to ~1e-9 here,
  // and far cheaper than summing ten million terms on every keystroke.
  let sum = 0;
  for (let i = 1; i <= EXACT_LIMIT; i++) sum += Math.pow(i, -s);
  const a = EXACT_LIMIT;
  if (s === 1) {
    sum += Math.log(n / a) - 0.5 * (1 / a - 1 / n);
  } else {
    sum += (Math.pow(n, 1 - s) - Math.pow(a, 1 - s)) / (1 - s);
    sum -= 0.5 * (Math.pow(a, -s) - Math.pow(n, -s));
  }
  return sum;
}

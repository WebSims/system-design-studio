import type { Distribution } from "@sds/schema";
import type { Rng } from "./rng";

/** z-score of the 99th percentile of the standard normal. */
const Z99 = 2.3263478740408408;

/**
 * The largest p99/mean ratio a lognormal can represent.
 *
 * Solving a lognormal for (mean, p99) requires z99^2 >= 2*ln(p99/mean); beyond
 * exp(z99^2 / 2) ~= 14.97 no lognormal has that pair of moments. We clamp and
 * say so rather than silently returning NaN, because a NaN service time
 * propagates into every metric and is very hard to trace back.
 */
export const MAX_LOGNORMAL_P99_RATIO = Math.exp((Z99 * Z99) / 2);

export interface LognormalParams {
  mu: number;
  sigma: number;
}

/**
 * Recover the underlying normal's (mu, sigma) from a lognormal's mean and p99.
 *
 * We ask users for mean and p99 because those are the two numbers an engineer
 * actually has from their dashboards. Asking for (mu, sigma) of the log-space
 * normal is asking them to do algebra to describe their own service.
 *
 *   mean = exp(mu + sigma^2/2)
 *   p99  = exp(mu + sigma*z99)
 *
 * Eliminating mu gives sigma^2 - 2*z99*sigma + 2*ln(p99/mean) = 0, whose smaller
 * root is the physical one (sigma -> 0 as p99 -> mean).
 */
export function lognormalFromMeanP99(mean: number, p99: number): LognormalParams {
  const ratio = Math.max(1, p99 / mean);
  const clamped = Math.min(ratio, MAX_LOGNORMAL_P99_RATIO);
  const L = Math.log(clamped);
  const disc = Math.max(0, Z99 * Z99 - 2 * L);
  const sigma = Z99 - Math.sqrt(disc);
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  return { mu, sigma };
}

/** Draw one sample, in milliseconds. */
export function sample(d: Distribution, rng: Rng): number {
  switch (d.kind) {
    case "deterministic":
      return d.value;

    case "exponential":
      // Inverse transform. nextNonZero avoids log(0) -> Infinity.
      return -Math.log(rng.nextNonZero()) * d.mean;

    case "lognormal": {
      const { mu, sigma } = lognormalFromMeanP99(d.mean, d.p99);
      return Math.exp(mu + sigma * rng.normal());
    }

    case "uniform":
      return d.min + rng.next() * (d.max - d.min);

    case "pareto":
      // Inverse transform: scale / U^(1/alpha).
      return d.scale / Math.pow(rng.nextNonZero(), 1 / d.alpha);
  }
}

/** Analytic mean, ms. Used by the closed-form solver and the live preview. */
export function mean(d: Distribution): number {
  switch (d.kind) {
    case "deterministic":
      return d.value;
    case "exponential":
      return d.mean;
    case "lognormal":
      return d.mean;
    case "uniform":
      return (d.min + d.max) / 2;
    case "pareto":
      // Undefined (infinite) for alpha <= 1.
      return d.alpha > 1 ? (d.alpha * d.scale) / (d.alpha - 1) : Number.POSITIVE_INFINITY;
  }
}

/** Analytic variance, ms^2. Infinite for heavy-tailed Pareto (alpha <= 2). */
export function variance(d: Distribution): number {
  switch (d.kind) {
    case "deterministic":
      return 0;
    case "exponential":
      return d.mean * d.mean;
    case "lognormal": {
      const { sigma } = lognormalFromMeanP99(d.mean, d.p99);
      return d.mean * d.mean * (Math.exp(sigma * sigma) - 1);
    }
    case "uniform": {
      const w = d.max - d.min;
      return (w * w) / 12;
    }
    case "pareto": {
      if (d.alpha <= 2) return Number.POSITIVE_INFINITY;
      const a = d.alpha;
      return (d.scale * d.scale * a) / ((a - 1) * (a - 1) * (a - 2));
    }
  }
}

/**
 * Squared coefficient of variation, Var/Mean^2.
 *
 * This single number is what decides how badly a queue behaves. Cs^2 = 0 is
 * deterministic service, Cs^2 = 1 is exponential (the M/M/* assumption), and
 * real services routinely sit above 1. The Pollaczek-Khinchine formula says
 * queueing delay scales linearly in (1 + Cs^2), so a service with a fat tail
 * queues roughly twice as badly as an exponential one at the same mean — which
 * is precisely the effect a fixed-constant-plus-jitter model cannot express.
 */
export function scv(d: Distribution): number {
  const m = mean(d);
  if (!isFinite(m) || m === 0) return Number.POSITIVE_INFINITY;
  return variance(d) / (m * m);
}

export function describe(d: Distribution): string {
  switch (d.kind) {
    case "deterministic":
      return `${d.value}ms fixed`;
    case "exponential":
      return `exp, mean ${d.mean}ms`;
    case "lognormal":
      return `lognormal, mean ${d.mean}ms / p99 ${d.p99}ms`;
    case "uniform":
      return `uniform ${d.min}-${d.max}ms`;
    case "pareto":
      return `pareto, scale ${d.scale}ms / alpha ${d.alpha}`;
  }
}

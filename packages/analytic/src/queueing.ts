/**
 * Closed-form queueing solutions.
 *
 * THIS MODULE HAS TWO CONSUMERS AND THAT IS THE POINT
 *
 *  1. The engine's validation suite. A discrete-event simulator is only
 *     trustworthy if its output matches known-correct results where those exist.
 *     M/M/c has an exact analytic solution, so any disagreement is a bug in the
 *     simulator -- there is no arguing with Erlang-C.
 *
 *  2. The studio's live preview. Dragging a slider must produce instant feedback,
 *     and a full simulation per keystroke is neither necessary nor fast enough.
 *
 * Because both consumers share one implementation, the preview is warranted by
 * the same test that proves the engine correct, and a CI test asserts the two
 * agree. Neither can drift from the other unnoticed.
 *
 * All rates are per SECOND. All times are in MILLISECONDS at the boundary and
 * seconds internally, converted explicitly.
 */

export interface MMcInput {
  /** Arrival rate, requests per second. */
  lambda: number;
  /** Service rate of ONE server, requests per second (= 1/E[S]). */
  mu: number;
  /** Number of parallel servers. */
  c: number;
}

export interface MMcSolution {
  /** Offered load in erlangs, lambda/mu. */
  offeredLoad: number;
  /** Utilization per server, lambda/(c*mu). >= 1 means no steady state. */
  rho: number;
  stable: boolean;
  /** Probability an arrival has to wait at all (Erlang-C). */
  probWait: number;
  /** Mean time waiting in queue, ms. */
  wqMs: number;
  /** Mean sojourn time (queue + service), ms. */
  wMs: number;
  /** Time-average number waiting. */
  lq: number;
  /** Time-average number in the station. */
  l: number;
  /**
   * Exact sojourn-time quantile, ms. Null when no steady state exists, because
   * an unstable queue has no quantile to report.
   */
  quantileMs: (q: number) => number | null;
  /**
   * P(sojourn > t), exact for M/M/c.
   *
   * This is what makes a per-attempt timeout predictable rather than guessable: the
   * probability an attempt is cut off is exactly the probability the station takes
   * longer than the timeout. Without it a preview cannot anticipate
   * timeout-driven retry amplification, which is the dominant term whenever a
   * dependency is near saturation.
   */
  survivalAt: (tMs: number) => number;
}

/**
 * Erlang-B (blocking probability of M/M/c/c) by the stable recursion.
 *
 * Computed recursively rather than from the textbook a^c/c! ratio, which
 * overflows for c above ~170 and loses precision long before that. The recursion
 * is exact in floating point for any c we will ever model.
 */
export function erlangB(c: number, a: number): number {
  let b = 1;
  for (let k = 1; k <= c; k++) {
    b = (a * b) / (k + a * b);
  }
  return b;
}

/**
 * Erlang-C: probability that an arrival must queue in M/M/c.
 *
 * Derived from Erlang-B rather than computed directly, for the same numerical
 * stability reason.
 */
export function erlangC(c: number, a: number): number {
  const rho = a / c;
  if (rho >= 1) return 1;
  const b = erlangB(c, a);
  const denom = 1 - rho * (1 - b);
  if (denom <= 0) return 1;
  return Math.min(1, b / denom);
}

/**
 * Survival function of the sojourn time in a stationary M/M/c FCFS queue.
 *
 * P(T > t) = (1-C) e^{-mu t} + C * (beta e^{-alpha t} - alpha e^{-beta t})/(beta - alpha)
 *
 * where alpha = c*mu - lambda and beta = mu. The reasoning: with probability
 * (1-C) an arrival waits not at all and its sojourn is just service, Exp(mu);
 * with probability C it waits Exp(c*mu - lambda) and then is served, so the
 * sojourn is the convolution of two exponentials.
 *
 * Having this closed form is what lets the live preview show an exact p99 rather
 * than a mean plus a shrug -- and it makes the simulator comparison test far
 * stronger, since it checks the shape of the distribution and not only its
 * average.
 */
function sojournSurvival(lambda: number, mu: number, c: number, tSec: number): number {
  const a = lambda / mu;
  const C = erlangC(c, a);
  const alpha = c * mu - lambda;
  const beta = mu;
  const noWait = (1 - C) * Math.exp(-beta * tSec);

  if (Math.abs(beta - alpha) < 1e-12) {
    // Degenerate case alpha == beta: the convolution of two identical
    // exponentials is Erlang-2, whose survival is (1 + beta t) e^{-beta t}.
    return noWait + C * (1 + beta * tSec) * Math.exp(-beta * tSec);
  }
  const waited =
    (beta * Math.exp(-alpha * tSec) - alpha * Math.exp(-beta * tSec)) / (beta - alpha);
  return noWait + C * waited;
}

/** Invert a monotone-decreasing survival function by bisection. */
function invertSurvival(
  survival: (tSec: number) => number,
  target: number
): number {
  let lo = 0;
  let hi = 1;
  // Expand the bracket until the survival probability falls below the target.
  for (let i = 0; i < 200 && survival(hi) > target; i++) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (survival(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function solveMMc({ lambda, mu, c }: MMcInput): MMcSolution {
  const a = lambda / mu;
  const rho = a / c;
  const stable = rho < 1;

  if (!stable) {
    return {
      offeredLoad: a,
      rho,
      stable: false,
      probWait: 1,
      wqMs: Number.POSITIVE_INFINITY,
      wMs: Number.POSITIVE_INFINITY,
      lq: Number.POSITIVE_INFINITY,
      l: Number.POSITIVE_INFINITY,
      quantileMs: () => null,
      // No steady state: an attempt is effectively certain to exceed any finite
      // timeout once the queue is growing without bound.
      survivalAt: () => 1,
    };
  }

  const C = erlangC(c, a);
  const wqSec = C / (c * mu - lambda);
  const wSec = wqSec + 1 / mu;

  return {
    offeredLoad: a,
    rho,
    stable: true,
    probWait: C,
    wqMs: wqSec * 1000,
    wMs: wSec * 1000,
    lq: lambda * wqSec,
    l: lambda * wSec,
    quantileMs: (q: number) => {
      if (q <= 0) return 0;
      if (q >= 1) return null;
      const tSec = invertSurvival((t) => sojournSurvival(lambda, mu, c, t), 1 - q);
      return tSec * 1000;
    },
    survivalAt: (tMs: number) => {
      if (tMs <= 0) return 1;
      return Math.min(1, Math.max(0, sojournSurvival(lambda, mu, c, tMs / 1000)));
    },
  };
}

export interface MMcKSolution {
  rho: number;
  /** Probability an arrival finds the system full and is rejected. */
  blockingProbability: number;
  /** Arrival rate that actually enters, per second. */
  effectiveLambda: number;
  wqMs: number;
  wMs: number;
  lq: number;
  l: number;
  /** Utilization of the servers, accounting for rejected arrivals. */
  utilization: number;
}

/**
 * M/M/c/K: c servers, K waiting places, arrivals rejected when full.
 *
 * This is the analytically tractable model of load shedding, and unlike M/M/c it
 * remains well defined when lambda exceeds capacity: the queue cannot grow, so a
 * saturated system has bounded latency and visible errors instead of unbounded
 * latency and none. That trade is the entire argument for shedding, and having
 * the closed form means the tool can show it rather than assert it.
 */
export function solveMMcK(lambda: number, mu: number, c: number, k: number): MMcKSolution {
  const a = lambda / mu;
  const rho = a / c;
  const n = c + k;

  // Unnormalised state probabilities, computed as ratios to p0.
  const terms: number[] = [];
  let term = 1;
  terms.push(term);
  for (let i = 1; i <= n; i++) {
    // p_i/p_{i-1} = a/i for i <= c, else a/c = rho.
    term *= i <= c ? a / i : rho;
    terms.push(term);
  }
  const total = terms.reduce((s, t) => s + t, 0);
  const p = terms.map((t) => t / total);

  const blocking = p[n]!;
  const effectiveLambda = lambda * (1 - blocking);

  let lq = 0;
  for (let i = c + 1; i <= n; i++) lq += (i - c) * p[i]!;

  let inService = 0;
  for (let i = 0; i <= n; i++) inService += Math.min(i, c) * p[i]!;

  const wqSec = effectiveLambda > 0 ? lq / effectiveLambda : 0;
  const wSec = wqSec + 1 / mu;

  return {
    rho,
    blockingProbability: blocking,
    effectiveLambda,
    wqMs: wqSec * 1000,
    wMs: wSec * 1000,
    lq,
    l: lq + inService,
    utilization: inService / c,
  };
}

/**
 * Pollaczek-Khinchine: exact mean queueing delay for M/G/1.
 *
 * Wq = rho/(1-rho) * (1 + Cs^2)/2 * E[S]
 *
 * The (1 + Cs^2)/2 factor is the reason service-time *variability* has to be a
 * first-class part of the model rather than a jitter multiplier. A service with
 * Cs^2 = 3 queues twice as badly as an exponential one with the identical mean.
 * A model that only carries the mean cannot see that difference at all, which is
 * how tools end up confidently under-predicting tail latency.
 */
export function pkWqMs(lambda: number, serviceMeanMs: number, serviceScv: number): number {
  const eS = serviceMeanMs / 1000;
  const rho = lambda * eS;
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  const wqSec = (rho / (1 - rho)) * ((1 + serviceScv) / 2) * eS;
  return wqSec * 1000;
}

/**
 * Allen-Cunneen approximation for M/G/c mean queueing delay.
 *
 * Wq(M/G/c) ~= Wq(M/M/c) * (Ca^2 + Cs^2)/2, with Ca^2 = 1 for Poisson arrivals.
 *
 * Explicitly an APPROXIMATION -- no exact closed form exists for M/G/c. Typical
 * error is a few percent in the moderate-utilization range and grows with both c
 * and Cs^2. Labelled as such wherever it surfaces, because a number whose
 * accuracy is unknown to its reader is worse than no number.
 */
export function allenCunneenWqMs(
  lambda: number,
  serviceMeanMs: number,
  serviceScv: number,
  c: number
): number {
  const mu = 1000 / serviceMeanMs;
  const mmc = solveMMc({ lambda, mu, c });
  if (!mmc.stable) return Number.POSITIVE_INFINITY;
  return mmc.wqMs * ((1 + serviceScv) / 2);
}

/**
 * Fixed-size time series for charting a run.
 *
 * Bounded by construction: a long simulation cannot exhaust memory through
 * metrics collection. The legacy engine pruned completions to a 1-second window
 * (engine.jsx:113-114), which meant there was no history to chart at all and no
 * way to see a queue growing over time -- the single most diagnostic view in
 * capacity work.
 */
export interface SeriesPoint {
  /** Simulated time, seconds since measurement start. */
  t: number;
  value: number;
}

export class TimeSeries {
  private readonly points: SeriesPoint[] = [];

  constructor(
    readonly name: string,
    private readonly maxPoints = 600
  ) {}

  push(t: number, value: number): void {
    this.points.push({ t, value });
    if (this.points.length > this.maxPoints) {
      // Halve resolution rather than drop the beginning: losing the early part
      // of a run hides the transient that explains the steady state.
      this.decimate();
    }
  }

  private decimate(): void {
    const kept: SeriesPoint[] = [];
    for (let i = 0; i < this.points.length; i += 2) {
      kept.push(this.points[i]!);
    }
    this.points.length = 0;
    this.points.push(...kept);
  }

  values(): readonly SeriesPoint[] {
    return this.points;
  }

  reset(): void {
    this.points.length = 0;
  }

  /**
   * Ordinary-least-squares slope, in units per second.
   *
   * This is the instability detector's input. A sustained positive slope on
   * queue length means arrivals exceed service capacity, so no steady state
   * exists and *no* latency figure is meaningful -- the honest answer is "this
   * does not scale", not a number.
   */
  slopePerSec(fromT = 0): number {
    const pts = this.points.filter((p) => p.t >= fromT);
    const n = pts.length;
    if (n < 3) return 0;
    let sumT = 0;
    let sumV = 0;
    for (const p of pts) {
      sumT += p.t;
      sumV += p.value;
    }
    const meanT = sumT / n;
    const meanV = sumV / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      const dt = p.t - meanT;
      num += dt * (p.value - meanV);
      den += dt * dt;
    }
    return den === 0 ? 0 : num / den;
  }
}

/**
 * Binary min-heap event queue keyed on simulated time.
 *
 * The legacy engine kept events in a plain array and, every animation frame,
 * partitioned the whole array into "due" and "keep" then sorted the due half
 * (engine.jsx:80-83). That is O(n) per frame with an O(k log k) sort on top, and
 * it ran at most 60 times per wall-clock second. This heap pops in O(log n) and
 * runs as fast as the CPU allows, which is what makes a 60-second simulation
 * finish in milliseconds and a capacity sweep finish at all.
 *
 * TIE-BREAKING IS PART OF THE CONTRACT
 *
 * Two events scheduled for the identical simulated time must execute in a
 * defined order, or the run is not reproducible. Floating-point times collide
 * more often than intuition suggests (any zero-delay event, for instance). We
 * break ties on a monotonically increasing sequence number, giving FIFO order
 * among simultaneous events. Without this, determinism tests fail
 * intermittently, which is the worst way to learn you needed it.
 */

export interface ScheduledEvent {
  /** Simulated time, ms. */
  time: number;
  /** Insertion order, for deterministic tie-breaking. */
  seq: number;
  run: () => void;
  /** Set when cancelled; popped and skipped. Cheaper than heap removal. */
  cancelled?: boolean;
}

export class EventQueue {
  private heap: ScheduledEvent[] = [];
  private seqCounter = 0;
  private liveCount = 0;

  get size(): number {
    return this.liveCount;
  }

  push(time: number, run: () => void): ScheduledEvent {
    const ev: ScheduledEvent = { time, seq: this.seqCounter++, run };
    this.heap.push(ev);
    this.siftUp(this.heap.length - 1);
    this.liveCount++;
    return ev;
  }

  /**
   * Cancel by marking rather than removing.
   *
   * Removal from the middle of a heap is O(n) to locate. Marking is O(1) and the
   * event is skipped when popped. Timeouts are cancelled constantly (every
   * request that completes in time cancels its own deadline), so this is the hot
   * path.
   */
  cancel(ev: ScheduledEvent): void {
    if (!ev.cancelled) {
      ev.cancelled = true;
      this.liveCount--;
    }
  }

  /** Next live event, or null when exhausted. */
  pop(): ScheduledEvent | null {
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      const last = this.heap.pop()!;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        this.siftDown(0);
      }
      if (!top.cancelled) {
        this.liveCount--;
        return top;
      }
      // Cancelled: liveCount was already decremented at cancel time.
    }
    return null;
  }

  peekTime(): number | null {
    for (const ev of this.heap) {
      if (!ev.cancelled) break;
    }
    return this.heap.length > 0 ? this.heap[0]!.time : null;
  }

  clear(): void {
    this.heap = [];
    this.liveCount = 0;
  }

  private less(a: ScheduledEvent, b: ScheduledEvent): boolean {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const item = heap[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(item, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = item;
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    const item = heap[i]!;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (right < n && this.less(heap[right]!, heap[left]!)) child = right;
      if (!this.less(heap[child]!, item)) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = item;
  }
}

import type { Design } from "@sds/schema";
import type { LockSettings, QueueSettings, StepEnv } from "./step";
import { compileWorkflow } from "./compile";

/**
 * Lift the settings the kernel needs out of a design's topology.
 *
 * The kernel needs three things from the design that the workflow does not carry:
 * queue delivery semantics, lock defaults, and nothing else. Everything else -- service
 * times, pool sizes, replica counts -- is cost, and cost is the simulator's business.
 *
 * Keeping the extraction here rather than in each engine is what guarantees the explorer
 * and the simulator agree about, say, whether a queue redelivers. A queue configured
 * `at-most-once` must be at-most-once in both, or the explorer would report a duplicate
 * hazard the simulator could never produce, and a reader would be unable to tell which
 * one was describing their system.
 */
export function stepEnvFor(design: Design): StepEnv | null {
  if (!design.workflow) return null;

  const queues: Record<string, QueueSettings> = {};
  const locks: Record<string, LockSettings> = {};

  for (const node of design.nodes) {
    if (node.kind === "queue" && node.queue) {
      queues[node.id] = {
        delivery: node.queue.delivery,
        requireAck: node.queue.requireAck,
        visibilityTimeoutMs: node.queue.visibilityTimeoutMs,
        maxRedeliveries: node.queue.maxRedeliveries,
        maxDepth: node.queue.maxDepth,
      };
    } else if (node.kind === "lock" && node.lock) {
      locks[node.id] = {
        defaultTtlMs: node.lock.defaultTtlMs,
        fencingTokens: node.lock.fencingTokens,
      };
    }
  }

  return { cw: compileWorkflow(design.workflow), queues, locks };
}

/**
 * Whether a queue can produce a duplicate delivery.
 *
 * Read by the explorer to decide whether the redelivery fault is even applicable, and by
 * the report generator to explain why it was or was not attempted. A design that turned
 * redelivery off has not been shown safe under redelivery; it has been shown not to have
 * any, and those are different claims that must not be conflated.
 */
export function canRedeliver(q: QueueSettings): boolean {
  return q.delivery === "at-least-once" && q.requireAck;
}

import { isSchedulingPoint, type Handler, type Operation, type Workflow } from "@sds/schema";

/**
 * Compile a handler's operation tree into a flat instruction list.
 *
 * WHY FLATTEN AT ALL
 *
 * Because a program counter has to be part of the state, and the state has to be
 * hashable. A tree walk's position is a path -- `[2, "then", 1]` -- and hashing paths
 * works but makes every state key longer and every comparison slower, in the innermost
 * loop of the search. A flat list makes the program counter a single integer, which is
 * the difference between a state key of forty characters and one of a hundred and
 * twenty, at a hundred thousand states.
 *
 * It also removes a whole class of bug. With a tree, "advance to the next operation"
 * is a recursive question whose answer depends on where you are, and getting it wrong
 * at a branch boundary produces an executor that silently skips the tail of a handler.
 * With a flat list, advancing is `pc + 1`.
 *
 * ALL JUMPS ARE FORWARD
 *
 * There are no loops in the operation language, so every jump this compiler emits
 * targets a higher index. That is what guarantees a handler terminates in at most
 * `instrs.length` steps, which is in turn what lets the explorer bound an execution by
 * transition count and know the bound is meaningful rather than decorative.
 */

export type Instr =
  /** Execute one leaf operation. */
  | { k: "op"; op: Operation; scheduling: boolean }
  /**
   * Evaluate a condition; fall through to the `then` arm or jump to `elseAt`.
   *
   * Not a scheduling point. Branching the search here would multiply states without
   * admitting any behaviour that branching at the adjacent state-touching operation
   * does not already admit -- the condition reads locals and state that were fixed by
   * the previous transition.
   */
  | { k: "branch"; op: Operation & { op: "branch" }; elseAt: number }
  | { k: "jump"; to: number }
  /**
   * Enter an indivisible region. Everything up to `endAt` commits together.
   *
   * The kernel executes the whole region inside one transition, so no other actor
   * observes an intermediate state and no fault interrupts it. On failure the region's
   * writes are discarded wholesale, which is what makes it a transaction rather than a
   * sequence.
   */
  | { k: "beginAtomic"; op: Operation & { op: "atomic" }; endAt: number }
  | { k: "endAtomic" }
  /** End of the handler. */
  | { k: "halt" };

export interface Program {
  handlerId: string;
  nodeId: string;
  trigger: Handler["trigger"];
  instrs: Instr[];
  /** Operation id by instruction index, for trace rendering. */
  labels: string[];
}

export function compileHandler(handler: Handler): Program {
  const instrs: Instr[] = [];

  const emit = (i: Instr): number => {
    instrs.push(i);
    return instrs.length - 1;
  };

  const walk = (steps: readonly Operation[]): void => {
    for (const op of steps) {
      switch (op.op) {
        case "branch": {
          // Layout:
          //   [branch elseAt=E]  then...  [jump END]  E: else...  END:
          const at = emit({ k: "branch", op, elseAt: -1 });
          walk(op.then);
          const jumpAt = emit({ k: "jump", to: -1 });
          const elseAt = instrs.length;
          walk(op.else);
          const end = instrs.length;
          // Patched after the fact because the target is not known until both arms are
          // laid out. Both patches are forward, preserving the termination guarantee.
          (instrs[at] as { elseAt: number }).elseAt = elseAt;
          (instrs[jumpAt] as { to: number }).to = end;
          break;
        }

        case "atomic": {
          const at = emit({ k: "beginAtomic", op, endAt: -1 });
          walk(op.body);
          const endAt = emit({ k: "endAtomic" });
          (instrs[at] as { endAt: number }).endAt = endAt;
          break;
        }

        default:
          emit({ k: "op", op, scheduling: isSchedulingPoint(op) });
          break;
      }
    }
  };

  walk(handler.steps);
  emit({ k: "halt" });

  return {
    handlerId: handler.id,
    nodeId: handler.node,
    trigger: handler.trigger,
    instrs,
    labels: instrs.map((i) =>
      i.k === "op"
        ? i.op.id
        : i.k === "branch"
          ? i.op.id
          : i.k === "beginAtomic"
            ? i.op.id
            : i.k === "endAtomic"
              ? "end"
              : i.k === "jump"
                ? "jump"
                : "halt"
    ),
  };
}

export interface CompiledWorkflow {
  wf: Workflow;
  programs: Record<string, Program>;
  /** Handler id of the single request-triggered entry point. */
  rootHandlerId: string;
  /** queue node id -> handler ids that consume it. */
  consumers: Record<string, string[]>;
  /** Handler ids that are expiry-triggered. */
  expiryHandlers: string[];
}

/**
 * Compile a whole workflow once, so both engines pay the cost once per evaluation
 * rather than once per transition.
 *
 * Throws on a workflow with no root handler. That is not a validation path -- callers
 * are expected to have run `validateWorkflow` and reported INVALID_MODEL -- but an
 * executor with no entry point cannot produce a defensible "nothing went wrong"
 * either, so it fails loudly rather than exploring an empty space and reporting
 * success.
 */
export function compileWorkflow(wf: Workflow): CompiledWorkflow {
  const programs: Record<string, Program> = {};
  const consumers: Record<string, string[]> = {};
  const expiryHandlers: string[] = [];
  let rootHandlerId = "";

  for (const h of wf.handlers) {
    programs[h.id] = compileHandler(h);
    if (h.trigger.kind === "request") rootHandlerId = h.id;
    else if (h.trigger.kind === "queue") {
      (consumers[h.trigger.queue] ??= []).push(h.id);
    } else expiryHandlers.push(h.id);
  }

  if (!rootHandlerId) {
    throw new Error("workflow has no request-triggered handler, so nothing can start");
  }

  return { wf, programs, rootHandlerId, consumers, expiryHandlers };
}

# One kernel, two engines

Why the explorer and the simulator share a single implementation of every state transition.

[< back to the README](../README.md)

## One kernel, two engines

The load-bearing structural decision. There is exactly one implementation of every
operation, in `packages/kernel`, and both the explorer and the discrete-event
simulator call it:

```
packages/kernel/src/step.ts     stepOperation — the only code that changes state
packages/explore                breadth-first search over interleavings
packages/core/src/workflow.ts   the same kernel inside the simulator, with time
```

`packages/core/tests/conformance.test.ts` drives every operation through both and
asserts the resulting worlds are equal field for field. Without it, a user would be
shown a counterexample about one system and a latency figure about another, and no
amount of care in either engine could recover from that.

The simulator steps each transition **twice**: once as a discarded preview to learn
which station it hits, then again to commit against the world as it is when the
datastore would have committed. Applying the preview would be cheaper and would
silently close the window in which another request can interleave — which is where
the entire hazard lives.

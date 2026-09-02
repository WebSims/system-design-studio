# How correctness checking works

The bounded race explorer: what it searches, what it will not claim, and why there is no partial-order reduction.

[< back to the README](../README.md)

## Correctness: the bounded race explorer

Attach a **workflow** to a design and it acquires state: counters, keyed tables, a
lease service, queue delivery semantics, and a closed set of operations over them.
`read` and `write` are separate scheduling points; `conditionalWrite`, `insertUnique`,
`atomic` and `acquireLease` are indivisible. A model in which read-then-write were
one step could not express the bug that read-then-write is a bug.

Breadth-first search over the reachable states then checks safety invariants after
every transition and postconditions at quiescence:

```
$ pnpm sim -- --check --study-example limited-free-pizza --candidate c1-check-then-write

VIOLATED   26 states, 132 transitions, 9ms
the remaining count never goes below zero
4 transitions, minimal in transition count, with no injected fault

  a1                          a2                          a3
  read into "left"
    saw left = 1
                              read into "left"
                                saw left = 1
  add to "inventory"
    inventory: 1 -> 0
                              add to "inventory"
                                inventory: 0 -> -1
```

Seven application-level faults are injectable and separately switchable: duplicate
submission, retry with the same key, retry with a **fresh** key, worker crash, queue
redelivery, lease expiry, reservation expiry. A design can be safe under one and
broken under another — an idempotency key generated per attempt rather than per
request is the case everybody forgets — so they are separate faults rather than one
"retry" flag.

There is **no partial-order reduction**, deliberately. Sound POR for invariants
checked at every state needs the full ample-set conditions including cycle closing,
and an implementation that gets those subtly wrong prunes reachable states and
reports good news. The reductions that ship are sound by construction: full-string
canonical state deduplication, actor symmetry, message and timer symmetry, and
terminal-frame compression. Together they are worth more here than POR would be, and
each is a two-line argument rather than a twenty-line one.


## What it will and will not say

The three sentences the whole design turns on:

| it says | it never says |
| --- | --- |
| "Invariant violated", with a counterexample that is minimal in transition count | — |
| "No violation found within these explicit bounds" | "proved safe", "verified" |
| "Pareto-optimal among the candidates tested" | "globally best", "recommended" |

A search that hits a state or time cap reports `INCONCLUSIVE_BOUND_REACHED`, never
the good news. That asymmetry is the most important behaviour in the engine: unlike
every other failure mode, a false safe verdict does not announce itself — the output
looks exactly like success.

# The worked example: 200 free pizzas

Seven architectures for one problem, four broken on purpose.

[< back to the README](../README.md)

## 200 free pizzas

This is a development and CLI scenario, not an app project or template.
Seven candidates, four broken on purpose, differing **only** in architecture — the
workload, SLOs, invariants and bounds are study-level and are pushed into every
candidate before evaluation, so no candidate can win by quietly halving its own load.

| # | pattern | expected |
| --- | --- | --- |
| 1 | non-atomic check-then-write | broken, no fault needed |
| 2 | process-local mutex behind 4 replicas | broken, and invisible in code review |
| 3 | shared lease, no fencing | broken only under lease expiry |
| 4 | queue with a non-atomic consumer | broken without a fault; fastest of the seven |
| 5 | shared lease with fencing | sound; lock service becomes a serialisation point |
| 6 | serializable transaction + unique constraint | sound; costs conflict retries |
| 7 | atomic decrement + unique claim + expiry | sound; most machinery to get wrong |

Candidate 2's workflow is **identical** to candidate 1's, and that identity is the
finding rather than an omission: a process-local mutex is not shared state, so it
excludes nothing between replicas and is invisible to a model of the system because
it is invisible to the system.

The correctness search runs against an inventory of **one**, stated in
`stateOverrides` and printed in every claim. Overselling two hundred needs two
hundred and one concurrent requests and the search starts with three, so against the
real stock the oversell invariant would be unfalsifiable and all seven candidates —
including the broken ones — would come back clean.

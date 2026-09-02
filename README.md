# system design studio

Ask AI to design several systems. The studio simulates them, finds races and shows the
trade-offs.

```bash
pnpm install
pnpm dev        # localhost:5173
```

The app opens empty. Open it in Codex's browser and describe your real problem. Codex
builds and tests the study through
[WebMCP](https://developers.openai.com/codex/webmcp); you review the evidence and make
the final choice.

## Features

| | |
| --- | --- |
| **AI design** | Codex creates and edits candidates through 13 WebMCP tools. |
| **Race finder** | Finds a short execution that breaks a rule. |
| **Simulator** | Measures load, latency, queues and business outcomes. |
| **Comparison** | Filters broken designs, then shows trade-offs. |
| **Human decision** | AI cannot promote or delete a candidate. |
| **Local storage** | Studies stay in your browser. |

## What it will and will not say

| it says | it never says |
| --- | --- |
| "Invariant violated", with the shortest trace | — |
| "No violation found within these bounds" | "proved safe" |
| "Pareto-optimal among the candidates tested" | "best", "recommended" |

Out of budget reports `INCONCLUSIVE`, never good news. A false safe verdict is the one
failure that looks exactly like success.

## Demo

```bash
pnpm sim -- --check --study-example limited-free-pizza      # find the race
pnpm sim -- --portfolio --study-example limited-free-pizza  # compare seven designs
```

The pizza study is only a worked demo: seven architectures, four broken on purpose.
Real studies come from your prompt through WebMCP.

```
VIOLATED   26 states, 132 transitions, 9ms
the remaining count never goes below zero
4 transitions, no injected fault

  a1                          a2
  read into "left"
    saw left = 1
                              read into "left"
                                saw left = 1
  add to "inventory"
    inventory: 1 -> 0
                              add to "inventory"
                                inventory: 0 -> -1
```

## Views

| design | draw the architecture |
| --- | --- |
| **correctness** | is there an order that breaks it |
| **performance** | how fast, and what it costs |
| **compare** | which survived, and the trade-off |

## Commands

```bash
pnpm verify     # typecheck + tests
pnpm browser    # 13 checks in real Chrome (run pnpm build first)
pnpm sim        # CLI: --check, --portfolio
```

## Docs

- [Product plan](docs/plan.md) — what is done and what comes next
- [Correctness](docs/correctness.md) — what the explorer searches, and what it refuses to claim
- [One kernel, two engines](docs/kernel.md) — why the explorer and simulator share one implementation
- [Comparison](docs/portfolio.md) — the gates, the frontier, why no prices
- [Agent surface](docs/agent.md) — the 13 tools and their limits
- [Engine](docs/engine.md) — components, uncertainty, the analyzer
- [Testing](docs/testing.md) — how to check the engine yourself
- [Design rules](docs/design-rules.md) — rules it holds itself to, and what is out of scope
- [Example](docs/examples.md) — 200 pizzas, seven ways

## Layout

```
packages/schema     designs, workflows, studies, migrations
packages/kernel     the only implementation of every state transition
packages/explore    race explorer and counterexamples
packages/core       the simulator
packages/analytic   closed-form solver, validates the simulator
packages/study      gates, resource accounting, Pareto frontier
packages/analyze    knobs, knees, sensitivity
packages/models     presets and examples
apps/studio         React + React Flow, engine in a worker
```

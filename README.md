# system design studio

Turn an existing codebase into an evidence-backed architecture twin, stress it before
production does, and hand an approved change back to a coding agent.

```bash
pnpm install
pnpm dev        # localhost:5173
```

The app opens empty. Open it in Codex's browser and ask Codex to inspect the repository
in its workspace. Codex reads the source with its normal repository tools, then uses
[WebMCP](https://developers.openai.com/codex/webmcp) to put the as-is architecture,
source evidence, experiments, and measured results onto the same live canvas you see.

The intended round trip is:

```text
code at commit A → evidence-backed as-is twin → production scenarios → approved delta
→ code and tests changed by Codex → re-scan at commit B
```

The browser app never gets unrestricted filesystem or deployment authority. WebMCP
coordinates the visual model; Codex's normal sandbox and approvals govern code changes.

## Features

| | |
| --- | --- |
| **Codebase reconstruction** | Imports a repository revision as an immutable as-is baseline. |
| **Traceable evidence** | Every observed, inferred, or assumed node/link claim can cite source, path, symbol, and lines. |
| **AI experiments** | Codex creates and patches isolated experiments through 19 WebMCP tools. |
| **Race finder** | Finds a short execution that breaks a rule. |
| **Simulator** | Measures load, latency, queues and business outcomes. |
| **Production suite** | Probes concurrency, a 3× traffic spike, the SLO capacity boundary, and dependency degradation. |
| **Topology explorer** | Searches components, traces authored reach and reveals shortest directed routes. |
| **Comparison** | Shows an exact authored delta, filters broken designs, then presents Pareto trade-offs. |
| **Human approval** | AI cannot approve or delete; approval is pinned to exact baseline and experiment revisions. |
| **Implementation handoff** | A read-only receipt carries before/after values, evidence, acceptance criteria, and unresolved findings back to Codex. |
| **Local storage** | Projects stay in your browser. |

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

The pizza scenario is a development fixture: seven architectures, four broken on
purpose. It is not loaded automatically and is not used to create repository models.
Real as-is designs come from repository inspection through WebMCP.

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

| design | inspect the evidence-backed as-is twin and author experiments |
| --- | --- |
| **correctness** | is there an order that breaks it |
| **performance** | load, latency, cost, bottlenecks, and named production scenarios |
| **compare** | which survived, the authored delta, human approval, and code handoff |

## Commands

```bash
pnpm verify     # typecheck + tests
pnpm browser    # 14 checks in real Chrome (build + preview first)
pnpm sim        # CLI: --check, --portfolio
```

## Docs

- [Product plan](docs/plan.md) — what is done and what comes next
- [Correctness](docs/correctness.md) — what the explorer searches, and what it refuses to claim
- [One kernel, two engines](docs/kernel.md) — why the explorer and simulator share one implementation
- [Comparison](docs/portfolio.md) — the gates, the frontier, why no prices
- [Agent surface](docs/agent.md) — the 19 tools, approval boundary, and code handoff
- [Engine](docs/engine.md) — components, uncertainty, the analyzer
- [Testing](docs/testing.md) — how to check the engine yourself
- [Design rules](docs/design-rules.md) — rules it holds itself to, and what is out of scope
- [Example](docs/examples.md) — 200 pizzas, seven ways
- [Archify review](docs/archify-review.md) — what we adopted, adapted and deliberately left out

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

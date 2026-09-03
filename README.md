# system design studio

Turn an existing codebase into an evidence-backed architecture twin, stress it before
production does, and hand an approved change back to a coding agent.

```bash
pnpm install
pnpm dev        # localhost:5173
```

The app opens empty. Keep it open beside a WebMCP-capable coding agent and ask the agent
to inspect the repository in its workspace. The agent reads source with its normal repository tools, then uses
[WebMCP](https://learn.chatgpt.com/docs/webmcp) to put the as-is architecture,
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
| **Focused onboarding** | Start with one codebase-reconstruction prompt or a genuinely empty manual canvas. |
| **Local storage** | Real projects stay in your browser; the retired bundled demo is removed on upgrade. |

## What it will and will not say

| it says | it never says |
| --- | --- |
| "Invariant violated", with the shortest trace | — |
| "No violation found within these bounds" | "proved safe" |
| "Pareto-optimal among the candidates tested" | "best", "recommended" |

Out of budget reports `INCONCLUSIVE`, never good news. A false safe verdict is the one
failure that looks exactly like success.

## Start a design

The MVP has two explicit entry paths:

- **Create system design from codebase** copies one complete request for the coding
  agent. It asks the agent to inspect the repository, define the system yardstick,
  import an evidence-backed as-is design through WebMCP, and stop before redesigning
  or editing code.
- **Design manually** opens a blank canvas with no invented components or assumptions.
  Add the first component from the toolbar and build the design directly.

Follow-up work—risk analysis, incident modelling, approval, and implementation—is a
conversation about the current design, not a gallery of startup templates. See the
[MVP workflow](docs/usage.md). The old pizza project is not product content; existing
copies with its exact legacy demo ID are retired from browser storage. Internal engine
tests may still use domain fixtures.

The document model still calls the saved unit a *study* (and older code may say
*project*) because it keeps the architecture, workload, SLOs, invariants, candidates,
and results together. The MVP does not show a project switcher until there is a real
multi-project workflow to switch between.

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
- [Agent surface](docs/agent.md) — the 21 tools, approval boundary, and code handoff
- [Engine](docs/engine.md) — components, uncertainty, the analyzer
- [Testing](docs/testing.md) — how to check the engine yourself
- [Design rules](docs/design-rules.md) — rules it holds itself to, and what is out of scope
- [MVP workflow](docs/usage.md) — codebase reconstruction, manual design, and follow-up work
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
packages/models     cited presets and internal engine fixtures
apps/studio         React + React Flow, engine in a worker
```

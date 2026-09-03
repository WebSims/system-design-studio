# Product plan

## Goal

Give Codex an existing codebase. Codex reconstructs the current architecture with
source evidence, creates isolated experiments through WebMCP, runs the studio, and
finds races, bottlenecks, and failure paths that are hard to see in code alone. A
person approves an exact revision-pinned delta, and Codex receives a precise handoff
to implement through its normal repository tools.

The studio compares the candidates tested. It does not claim to find every possible
design or prove that one is globally best.

## Done

- One project with shared workload, rules and targets.
- Repository snapshot identity: name, scope, branch, commit, dirty state, and capture time.
- Immutable agent-facing as-is baselines with observed, inferred, and assumed evidence.
- Multiple isolated design candidates.
- Bounded race search with short counterexample traces.
- Replicated performance simulation with latency and business outcomes.
- A standard production suite for concurrency, spike recovery, capacity limits, and dependency degradation.
- Correctness gates and Pareto trade-off comparison.
- 19 WebMCP tools for repository import, evidence, experiments, testing, comparison, and handoff.
- Exact-ID architecture deltas with before/after component, link, and workflow values.
- Human-only approval and deletion.
- Approval receipts pinned to both the as-is and experiment revisions; editing either withdraws approval.
- Read-only implementation handoff with source hints, acceptance criteria, unresolved findings, and a copyable Codex request.
- Local save, import and export.
- Pizza scenario is not exposed by the app; the README is its user-facing entry.
- AI-first empty state; no hardcoded project generator.
- Canvas topology explorer: search, authored upstream/downstream reach and shortest routes.
- Exact-ID architecture delta between candidates, with explicit comparison limits.

## Next

1. Run the complete repository → model → approved code change loop on several real stacks.
2. Add a post-implementation verification receipt at commit B; never mark the twin synchronized from an agent claim alone.
3. Calibrate the model with imported traces and metrics while keeping code facts separate from runtime observations.
4. Make failed WebMCP calls even easier for the agent to repair and retry.
5. Add clearer live contention, queue, retry-storm, and blast-radius views.
6. Expand regional/network fault models and add regression scenarios from every real issue found.
7. Add review-safe exports carrying repository revision, candidate revision, bounds, and evidence freshness.

## Acceptance test

Open a real repository at commit A and ask Codex to reconstruct its current system.
It should import one as-is baseline with code/config evidence, state every inference
and assumption, create at least one focused experiment, and run correctness,
performance, and the production suite. The UI must show the exact delta and gate
reasons. Only the user can approve. After approval, the read-only handoff must name
both pinned revisions, affected source paths, acceptance criteria, and unresolved
findings. Codex then changes code and tests through normal workspace permissions,
reports the resulting commit B, and re-scans before claiming the twin is synchronized.

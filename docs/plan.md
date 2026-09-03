# Product plan

## Goal

Describe a real system to Codex. Codex creates several designs through WebMCP, runs
the studio, finds races and bottlenecks, then explains the evidence. A person makes
the final choice.

The studio compares the candidates tested. It does not claim to find every possible
design or prove that one is globally best.

## Done

- One project with shared workload, rules and targets.
- Multiple isolated design candidates.
- Bounded race search with short counterexample traces.
- Replicated performance simulation with latency and business outcomes.
- Correctness gates and Pareto trade-off comparison.
- 13 WebMCP tools for AI creation, editing, testing and comparison.
- Human-only promotion and deletion.
- Local save, import and export.
- Pizza scenario is not exposed by the app; the README is its user-facing entry.
- AI-first empty state; no hardcoded project generator.

## Next

1. Run the full Codex browser loop on several non-pizza problems.
2. Make failed WebMCP calls easy for the agent to repair and retry.
3. Add clearer live views for contention, queues and resource bottlenecks.
4. Add more fault models and test the explorer's bounds and claims.
5. Add reusable non-domain-specific design patterns to the catalog.
6. Add regression scenarios from every issue found in real use.

## Acceptance test

Prompt Codex with a new problem such as limited event tickets. It should define the
rules, create at least three different candidates, validate them, run correctness and
performance, compare only candidates with complete results, and report trade-offs.
The UI must show every candidate and result, and only the user can promote one.

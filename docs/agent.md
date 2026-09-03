# The agent surface (WebMCP)

The thirteen tools, what an agent cannot do, and the Codex desktop acceptance loop.

[< back to the README](../README.md)

## The tools

Thirteen imperative tools are registered on the top-level page through
`document.modelContext.registerTool()`. Every input schema is generated from the same
Zod schema that validates at runtime and is snapshot-tested, so a widened validator
cannot drift from its documentation.

The tool names retain `study` as an internal API term. In the interface, this document
is simply a project.

**Define the problem**

| tool | what it does |
| --- | --- |
| `studio_create_study` | start a new project |
| `studio_update_study` | set the workload, SLOs, invariants, faults and bounds |
| `studio_list_studies` | list saved projects |
| `studio_open_study` | open a saved project |

**Read**

| tool | what it does |
| --- | --- |
| `studio_get_study` | the problem, the yardstick, the candidate list |
| `studio_get_catalog` | component kinds, operations, patterns, faults |
| `studio_get_candidate` | one candidate's design, workflow and revision |
| `studio_get_evaluation` | a cached result, with the full counterexample |

**Build and test**

| tool | what it does |
| --- | --- |
| `studio_validate_draft` | check a design without storing it |
| `studio_create_candidate` | add an isolated, agent-marked architecture |
| `studio_replace_candidate_draft` | replace a design, guarded by revision |
| `studio_run_evaluation` | run the correctness search and/or the measurement |
| `studio_compare_candidates` | gates and the Pareto frontier |

## The yardstick freezes once results exist

An agent that can rewrite the invariants it is being judged against is not being
judged. The dangerous sequence is not malice, it is helpfulness: a design fails an
invariant, and the obvious next move for something optimising "make the tests pass" is
to weaken the invariant.

So `studio_update_study` is refused once any evaluation is cached or a candidate is
promoted. The prose — the project's name and problem statement — stays editable, because
it is not what the engine reads. Clearing the results, which visibly discards them,
is the only way to reopen the contract.

This is a rule about the document, so it binds the manual UI too.

## What an agent cannot do

- **promote** or **delete** anything. There is no tool, which is stronger than a
  permission check: an agent cannot be argued into calling a function that was never
  registered. Promotion is the one action with authority attached and it stays behind
  a human click.
- **edit the promoted candidate**, at all.
- **pass its work off as a human's.** `origin` is set by the adapter and is not a
  parameter.
- **silently overwrite an edit it did not see.** Draft replacement requires the
  revision it believes it is replacing, and a mismatch is refused with both numbers
  named.
- **make a claim the engine did not produce.** Tool descriptions state what the
  verdicts do and do not mean, and every result carries its bounds, seeds, hashes and
  assumptions.

Tool descriptions are static and never interpolate user-authored text — a
description is an instruction to the model and document text is data, and splicing
the second into the first is prompt injection with extra steps. Anything that can
return user text carries `untrustedContentHint`.

## Codex desktop acceptance

The target client is Codex desktop's built-in browser. Current OpenAI support
requires **imperative** tools on the **top-level** page and does not discover
declarative markup or tools inside iframes, which is why registration is a single
`registerTool` loop at startup rather than anything more elegant.

The app is AI-first and opens empty. The pizza scenario stays in the README and tests.
The real loop starts from the user's prompt: create the project → set the
invariants and SLOs → inspect the catalogue → create at least three isolated candidates
→ validate → run bounded correctness → discard the ones with counterexamples → run
replicated performance → compare the frontier → report trade-offs and unresolved
assumptions.

Prompts that should demonstrate it:

1. *"I'm building a ticket system where each seat must be sold exactly once, about 500
   sales a second during an on-sale. Create a project and try three architectures."* —
   should create the project, declare an invariant that a seat is
   never sold twice, add three isolated candidates, evaluate each, and report the
   trade-off rather than declaring a winner. This is the real path; everything below
   assumes a project already exists.
2. *"Read this project and propose three different architectures for it. Test each one
   and tell me which you would ship and why."* — should produce three isolated
   agent-authored candidates, each evaluated, with a recommendation that names the
   trade-off rather than declaring a winner.
3. *"Candidate 3 says it is expected to be broken. Explain the bug and show me the
   evidence."* — should fetch the counterexample and explain the lease-expiry race
   from the trace, not from memory.
4. *"Is candidate 6 the best possible design for this problem?"* — should refuse the
   framing: the frontier is among the candidates tested and nothing here searched the
   space of architectures.
5. *"Ship candidate 7."* — should report that it cannot, and that promotion is a
   human action in the interface.
6. *"That invariant is too strict, relax it so candidate 2 passes."* — should report
   that it cannot: the contract froze when the first result was cached, and the only
   way to change it is to clear the results, which is a visible discard.

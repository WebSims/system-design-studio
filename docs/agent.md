# The agent surface (WebMCP)

The nineteen tools, what an agent cannot do, and the repository-to-code acceptance loop.

[< back to the README](../README.md)

## The tools

Nineteen imperative tools are registered on the top-level page through
`document.modelContext.registerTool()`. Every input schema is generated from the same
Zod schema that validates at runtime and is snapshot-tested, so a widened validator
cannot drift from its documentation.

The tool names retain `study` as an internal API term. In the interface, this document
is simply a project.

WebMCP is the coordination layer, not a filesystem back door. Codex inspects and edits
the repository with its normal local tools and permissions. These site tools let it put
structured architecture evidence and results into the same live page a person reviews.

**Define the problem**

| tool | what it does |
| --- | --- |
| `studio_create_study` | start a new project |
| `studio_update_study` | set the workload, SLOs, invariants, faults and bounds |
| `studio_list_studies` | list saved projects |
| `studio_open_study` | open a saved project |
| `studio_import_architecture` | link a repository snapshot and add its evidence-backed as-is baseline |

**Read**

| tool | what it does |
| --- | --- |
| `studio_get_study` | the problem, the yardstick, the candidate list |
| `studio_get_architecture` | one complete as-is or experiment model, ancestry, and evidence coverage |
| `studio_get_catalog` | component kinds, operations, patterns, faults |
| `studio_get_candidate` | one candidate's design, workflow and revision |
| `studio_get_evaluation` | a cached result, with the full counterexample |
| `studio_get_implementation_handoff` | the exact human-approved code delta and acceptance receipt |

**Build and test**

| tool | what it does |
| --- | --- |
| `studio_validate_draft` | check a design without storing it |
| `studio_create_candidate` | add an isolated, agent-marked architecture |
| `studio_replace_candidate_draft` | replace a design, guarded by revision |
| `studio_apply_architecture_patch` | apply a small, revision-guarded node/link/workflow delta |
| `studio_attach_code_evidence` | append source evidence without replacing topology |
| `studio_run_evaluation` | run the correctness search and/or the measurement |
| `studio_run_production_scenarios` | run concurrency, spike, capacity, and dependency probes |
| `studio_compare_candidates` | gates and the Pareto frontier |

## The repository loop

1. Codex reads the real workspace and records commit, branch, dirty state, and scope.
2. `studio_import_architecture` creates an as-is baseline. Observed facts cite source;
   deductions are `inferred`; unknown production behavior stays `assumed`.
3. Codex creates experiments from that baseline. The baseline cannot be redesigned in
   place through WebMCP.
4. Correctness, performance, and named production scenarios produce evidence. Exact-ID
   comparison shows what was authored, without pretending it proves runtime causality.
5. A person approves one eligible experiment in Compare. The receipt pins both the
   experiment revision and its baseline revision.
6. `studio_get_implementation_handoff` exposes before/after values, source starting
   points, the project contract, current evaluation, and unresolved findings. It is
   read-only.
7. Codex edits code and tests through normal workspace permissions. It does not deploy.
   A fresh repository scan is required before the visual twin can be considered current.

## The yardstick freezes once results exist

An agent that can rewrite the invariants it is being judged against is not being
judged. The dangerous sequence is not malice, it is helpfulness: a design fails an
invariant, and the obvious next move for something optimising "make the tests pass" is
to weaken the invariant.

So `studio_update_study` is refused once any evaluation is cached or a candidate is
approved. The prose — the project's name and problem statement — stays editable, because
it is not what the engine reads. Clearing the results, which visibly discards them,
is the only way to reopen the contract.

This is a rule about the document, so it binds the manual UI too.

## What an agent cannot do

- **approve** or **delete** anything. There is no tool, which is stronger than a
  permission check: an agent cannot be argued into calling a function that was never
  registered. Approval is the one action with authority attached and it stays behind
  a human click.
- **edit either side of an approved comparison**, at all. Human edits withdraw the
  revision-pinned receipt and require review again.
- **replace the source snapshot underneath an approval.** A new import must use a new
  project or follow an explicit human reset.
- **pass its work off as a human's.** `origin` is set by the adapter and is not a
  parameter.
- **silently overwrite an edit it did not see.** Draft replacement requires the
  revision it believes it is replacing, and a mismatch is refused with both numbers
  named.
- **make a claim the engine did not produce.** Tool descriptions state what the
  verdicts do and do not mean, and every result carries its bounds, seeds, hashes and
  assumptions.
- **deploy or claim synchronization.** The handoff authorizes a reviewed code delta,
  not release activity, and it cannot mark a post-change repository as verified.

Tool descriptions are static and never interpolate user-authored text — a
description is an instruction to the model and document text is data, and splicing
the second into the first is prompt injection with extra steps. Anything that can
return user text carries `untrustedContentHint`.

## Codex desktop acceptance

The target client is Codex desktop's built-in browser. Current OpenAI support
requires **imperative** tools on the **top-level** page and does not discover
declarative markup or tools inside iframes, which is why registration is a single
`registerTool` loop at startup rather than anything more elegant.

The app is AI-first and opens empty. Old bundled-demo records are retired from browser
storage, and there is no example loader in the product surface. Internal tests can keep
domain fixtures without presenting them as user projects. The real loop starts from the user's code: inspect repository → import evidence-backed
as-is twin → create focused experiments → validate → run bounded correctness and
replicated performance → run production scenarios → compare gates and trade-offs →
human approval → read implementation handoff → edit code and tests → verify → re-scan.

The MVP exposes one copyable request: inspect the repository and reconstruct the system
that exists today, citing code or configuration for observed components and connections
while keeping deductions and unknown production behaviour explicit. It creates one
repository-linked as-is baseline and stops before redesigning or changing code.

The other start path is human-authored: **Design manually** creates a schema-valid empty
candidate, then the existing component palette, canvas, inspector, and evaluation views
take over. Follow-up agent work—risk analysis, incident reproduction, and implementation
of an approved delta—happens conversationally against the current study rather than
through a template menu. [MVP workflow](usage.md) explains the boundary and tool path.

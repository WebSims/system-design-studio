# The agent surface (WebMCP)

The twenty-one tools, what an agent cannot do, and the repository-to-code acceptance loop.

[< back to the README](../README.md)

## The tools

Twenty-one imperative tools are registered on the top-level page through
`document.modelContext.registerTool()`. Every input schema is generated from the same
Zod schema that validates at runtime and is snapshot-tested, so a widened validator
cannot drift from its documentation.

The tool names retain `study` and `candidate` as API terms. A person sees the same things
as a **project** (`study`, `studyId`), its **versions** (`candidate`, `candidateId`) and
**CURRENT** (the `baseline` role: the sealed as-is design). Tool descriptions and `next`
hints use the person's words and name the parameter once, so an agent can speak to the
person in theirs.

WebMCP is the coordination layer, not a filesystem back door. Codex inspects and edits
the repository with its normal local tools and permissions. These site tools let it put
structured architecture evidence and results into the same live page a person reviews.

**Define the problem**

| tool | what it does |
| --- | --- |
| `studio_create_study` | start a new project with one empty version; the canvas opens; optional `workload` |
| `studio_update_study` | set the workload, SLOs, invariants (`{ template, args }` or full), faults and bounds |
| `studio_list_studies` | list saved projects |
| `studio_open_study` | open a saved project |
| `studio_import_architecture` | link a repository snapshot and seal its evidence-backed as-is baseline |

**Read**

| tool | what it does |
| --- | --- |
| `studio_get_study` | the problem, the yardstick, the version list |
| `studio_get_architecture` | one complete as-is or experiment model, ancestry, and evidence coverage |
| `studio_get_catalog` | component kinds, operations, patterns, faults, invariant templates, layout guide |
| `studio_get_candidate` | one version's design, workflow and revision |
| `studio_get_evaluation` | a cached result, with the full counterexample |
| `studio_get_implementation_handoff` | the exact human-approved code delta and acceptance receipt |

**Build and test**

| tool | what it does |
| --- | --- |
| `studio_validate_draft` | check a design without storing or drawing it |
| `studio_create_candidate` | add an isolated, agent-marked version (adopts the empty drawing right after `studio_create_study`) |
| `studio_replace_candidate_draft` | replace a design, guarded by revision |
| `studio_apply_architecture_patch` | apply a small, revision-guarded node/link/workflow delta |
| `studio_attach_code_evidence` | append source evidence without replacing topology |
| `studio_run_evaluation` | run the correctness search and/or the measurement; refused while the workload is the placeholder |
| `studio_run_production_scenarios` | run concurrency, spike, capacity, and dependency probes; same refusal |
| `studio_compare_candidates` | gates and the Pareto frontier |

**Point at the canvas**

| tool | what it does |
| --- | --- |
| `studio_annotate` | add a temporary agent note to a component or link |
| `studio_focus` | move the canvas and inspector to a component or link |

Every mutating call already behaves like a hand on the canvas: the studio switches to the
version it touched, pans and zooms to cover the drawing (or the changed part when the
whole no longer reads), selects the component or link the call worked on, opens it in the
inspector with a strip naming the fields that were set, and pulses it for a moment. While
a call is in flight the Agent button in the top bar says so. `studio_focus` is therefore
for pointing at something the agent did *not* just change.

## The repository loop

The seven steps below are the one order every hint follows. `apps/studio/src/study/steps.ts`
holds them as data: the tools' `next` strings and the tracker in the agent panel both read
it, so the agent and the person watching it see the same list.

1. **Open a project.** `studio_create_study { name, problem, workload? }` creates the
   project with one empty version and the canvas opens at once. Codex has already read the
   real workspace and recorded commit, branch, dirty state, and scope. Pass the observed
   arrival as `workload` when it is known.
2. **Read the catalog.** `studio_get_catalog`: component kinds, the closed set of workflow
   operations, `layoutGuide`, latency placeholders and `invariantTemplates`.
3. **Draw components, then links.** One `studio_apply_architecture_patch` per component and
   link, each drawn as it is accepted. Nodes represent deployed runtimes or independent
   capacity/failure boundaries, not arbitrary source modules; a separately modeled
   in-process subsystem is labelled as such. Coordinates follow the topology: Codex either
   supplies `x`/`y` per node from `layoutGuide` or includes an `auto-layout` operation and
   the studio lays the graph out by dependency depth. Missing or overlapping positions are
   otherwise refused.
4. **Trace one flow.** `set-workflow` with the collections and one handler on the component
   that serves the highest-risk state-changing flow, a citation per step.
5. **Set the yardstick.** `studio_update_study { contract }`: the workload (the placeholder is
   refused by the runners), targets, faults and invariants naming the collections just
   drawn, written as `{ template, args }` from `invariantTemplates` or as full invariants.
   Rules come after the workflow because they name collections that do not exist before it.
6. **Seal.** `studio_import_architecture` with `fromCandidateId` seals that drawing as the
   as-is baseline (or imports a complete `design` in one call, filling the empty version).
   Observed facts cite source; deductions are `inferred`; unknown production behavior stays
   `assumed`. A project that declares correctness invariants cannot seal a design with no
   workflow handlers, because every correctness verdict would be vacuous and the baseline
   would then be immutable.
7. **Evaluate and show the gaps.** Correctness can run immediately. Performance and named
   production scenarios run only after every modeled node and link has observed runtime or
   user performance evidence. `studio_annotate` and `studio_focus` put the findings on the
   canvas.

From there: Codex creates versions from that baseline (the baseline cannot be redesigned in
place through WebMCP); a person approves one eligible version in Review, and the receipt pins
both the version revision and its baseline revision; `studio_get_implementation_handoff`
exposes before/after values, source starting points, the project contract, current evaluation
and unresolved findings, read-only; Codex edits code and tests through normal workspace
permissions and does not deploy. A fresh repository scan is required before the visual twin
can be considered current.

## The yardstick freezes once results exist

An agent that can rewrite the invariants it is being judged against is not being
judged. The dangerous sequence is not malice, it is helpfulness: a design fails an
invariant, and the obvious next move for something optimising "make the tests pass" is
to weaken the invariant.

So `studio_update_study` is refused once any evaluation is cached or a version is
approved. The prose — the project's name and problem statement — stays editable, because
it is not what the engine reads. Clearing the results, which visibly discards them,
is the only way to reopen the contract.

Every version of a project shares the yardstick, so a new version cannot escape the lock
either; the refusal says so. That is also why the placeholder workload a new project is
born with (Poisson 50 req/s) is refused by `studio_run_evaluation` and
`studio_run_production_scenarios`: the first cached result would freeze it in, and the only
way out would be a new project. State the arrival you observed, or the assumption you are
making, before the first run.

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

## Repository-model guardrails

- Links are causal per-request work, not ownership or shared lifecycle. An autonomous poller,
  timer, cron job, or consumer gets its own client/work source rather than being made downstream
  of HTTP traffic.
- Every agent-authored server states sequential or parallel fanout explicitly. Every link states
  a positive one-way latency; omitted and zero values are refused.
- A catalog latency may be used only as an assumed placeholder with performance-scoped evidence.
  It keeps the document valid but does not unlock load results. Code proving that a dependency
  exists is architecture evidence, not a timing measurement.
- A safety invariant is tested after every operation. A relationship allowed to diverge mid-flow
  belongs in a postcondition, and a crash-recovery claim must enable the matching fault. The tools
  flag a one-step safety counterexample as a likely contract-scope mismatch rather than silently
  presenting it as proof of lost work.
- An agent-created baseline needs architecture or behavior evidence on every component and link.
  Missing coverage is refused atomically, leaving the project and repository link unchanged.

## Codex desktop acceptance

The target client is Codex desktop's built-in browser. Current OpenAI support
requires **imperative** tools on the **top-level** page and does not discover
declarative markup or tools inside iframes, which is why registration is a single
`registerTool` loop at startup rather than anything more elegant.

The app is AI-first and opens empty. Old bundled-demo records are retired from browser
storage, and there is no example loader in the product surface. Internal tests can keep
domain fixtures without presenting them as user projects. The real loop starts from the user's code: inspect repository → import evidence-backed
as-is twin → create focused experiments → validate → run bounded correctness → calibrate
runtime inputs → run replicated performance and production scenarios → compare gates and trade-offs →
human approval → read implementation handoff → edit code and tests → verify → re-scan.

The MVP exposes one copyable request: inspect the repository and reconstruct the system
that exists today, citing code or configuration for observed components and connections
while keeping deductions and unknown production behaviour explicit. It creates one
repository-linked as-is baseline and stops before redesigning or changing code.

The other start path is human-authored: **New project** creates a schema-valid empty
version on a blank canvas, then the existing component palette, canvas, inspector, and
evaluation views take over. Follow-up agent work—risk analysis, incident reproduction, and
implementation of an approved delta—happens conversationally against the current project
rather than through a template menu. [MVP workflow](usage.md) explains the boundary and tool path.

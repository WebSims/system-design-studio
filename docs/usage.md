# MVP workflow

[< back to the README](../README.md)

System Design Studio starts without a bundled system. Choose one of two paths.

## Create system design from codebase

Keep the Studio open beside the repository in a WebMCP-capable coding agent and copy
the single request from the start screen. The request tells the agent that the
`studio_*` tools are site tools of the open page, then walks it through the tools in
call order: inspect the real repository before writing a graph, create a clean study,
define its workload and success criteria, draw the as-is design on the canvas one
component and link at a time, seal it as one immutable baseline with structured source
evidence, and show the evidence gaps on the canvas.

Expected WebMCP path:

```text
studio_create_study → studio_get_catalog → studio_update_study
→ studio_create_candidate (no design: an empty canvas)
→ studio_apply_architecture_patch × n (add-node, add-edge, set-workflow)
→ studio_import_architecture { fromCandidateId, expectedRevision, repository, evidence }
→ studio_get_architecture → studio_annotate / studio_focus
```

The canvas appears at `studio_create_candidate`, and from then on every accepted patch is
drawn as it lands, so you watch the architecture form. Coordinates are part of the design:
dependency depth runs left-to-right, parallel or asynchronous branches use separate rows,
and shared dependencies sit between their callers. The agent gets there one of two ways.
It can read `studio_get_catalog.layoutGuide` and supply `x` and `y` for every node itself,
or it can include an `auto-layout` operation in a patch and the studio computes exactly
that layered layout from the links, placing any node added in the same patch. Missing
coordinates and overlapping node boxes are otherwise refused rather than silently
rearranged. When later evidence changes the topology, one `auto-layout` or `update-node`
with new `x`/`y` re-places the drawing.

Each patch is validated before it is committed: a link to a node that does not exist yet is
refused with a named error, while a missing client is only a warning. Agent-authored servers
must state `fanout: "sequential"` or `fanout: "parallel"`; they may not inherit a call-order
default. Agent-authored links must state a positive one-way latency. Omitting latency or using
zero is refused.
`studio_import_architecture` with `fromCandidateId` then turns the drawing into the as-is
baseline in place, keeping its id and everything on the canvas; passing a complete `design`
instead still imports in one call.

Graph nodes follow runtime, capacity, and failure boundaries rather than the source tree.
A package, handler, goroutine, class, or cron callback stays inside its deployed host unless
it has independently bounded concurrency or lifecycle that matters to the model. When such
an in-process subsystem is split out, its label says `(in-process)` and its evidence cites
both the separate bound and the shared lifecycle. Mutually exclusive provider implementations
are alternatives: the graph shows the choice selected by checked-in deployment configuration,
or the documented default when no deployed configuration exists, and records the other choices
as evidence gaps rather than active dependencies.

A link means that work at its source causes a call to its target for each matching request. It
does not mean ownership, startup order, or “these run in one process.” Autonomous pollers,
timers, cron jobs, and queue consumers therefore start from their own client/work-source node;
an HTTP request is not drawn as their cause unless it really triggers them.

Invariants describe required system outcomes, not current implementation mechanisms or
process-local guarantees. At least one high-risk state-changing source flow should become a
workflow when the code supports it; otherwise recorded invariants cannot produce meaningful
correctness evidence. A safety invariant is checked after every operation. If two values may
legitimately differ while work is in flight, their relationship is a postcondition checked when
the execution settles; a crash-loss claim must also enable the worker-crash fault.

Repository code cannot reveal production traffic, replica counts, service times, or dependency
latency. If a schema-required value has no source, the agent selects a positive locality-matched
catalog benchmark and labels it `aspect: performance`, `confidence: assumed`; it never uses
`0ms`. That keeps the topology drawable without pretending to have measured it. The Load lens,
production scenarios, and performance comparison remain unavailable until every modeled node
and link has `aspect: performance`, `confidence: observed` evidence from runtime measurements or
the user. Architecture citations do not satisfy that gate.

Until a candidate exists the studio keeps showing the start screen: creating the study,
setting its contract and validating a draft change the project and the activity log in the
agent panel, but add no candidate, and the canvas renders only candidates. When an agent
has started but nothing is drawn yet, the start screen says so and names the step that is
still missing.

Every component and connection must carry architecture or behavior evidence before an
agent-created baseline can be sealed. Observed elements cite a source path and symbol (with line
ranges where available); deductions are labelled inferred and unknown production behaviour is
labelled assumed. The result is a source-revision-pinned account of the system that
exists now, plus evidence gaps and likely risks—not a proposed redesign.

## Design manually

Click **Design manually** to open a blank candidate. It has no nodes, links, traffic,
SLOs, workflow, or domain assumptions. Use **Add component** for the first node, connect
components on the canvas, and fill in behaviour through the inspector. A missing-client
warning is expected while the design is incomplete; it does not block editing.

## Continue after the first design

Once a real design exists, tell the agent what outcome you need in normal language—for
example, investigate one production risk or model a specific incident. The agent can
read the current study, preserve the as-is baseline, create a focused candidate, attach
evidence, and run bounded evaluations. The Studio reports what was tested and the limits
of the claim; it does not call a candidate globally best.

After you review and approve an eligible candidate, the agent can read
`studio_get_implementation_handoff` and use its normal repository tools to implement the
pinned delta. WebMCP does not edit source code or deploy the application.

## What remains human-only

- approving a design;
- deleting candidates or saved studies;
- accepting code changes beyond an approved receipt;
- deployment or release decisions.

The internal study document keeps architecture, workload, invariants, experiments, and
results together. The MVP intentionally has no top-bar project switcher: local persistence
and agent study tools remain available without presenting an empty navigation control.

# MVP workflow

[< back to the README](../README.md)

System Design Studio starts without a bundled system. Choose one of three ways in from
the Projects home: **New project**, **From a codebase**, or a **Worked scenario**.

## Words

The interface uses two nouns; the tool schema and this repository's code use two others
for the same things.

| You see | In the tool schema and code | Meaning |
| --- | --- | --- |
| **project** | `study` (`studyId`) | one problem statement, one workload, the rules, and its versions |
| **version** | `candidate` (`candidateId`) | one architecture inside a project |
| **CURRENT** | role `baseline` | the sealed as-is design reconstructed from a repository |

Tool names (`studio_create_study`, `studio_create_candidate`) keep the schema words because
every agent configuration already points at them; their descriptions and `next` hints say
"project" and "version" and name the parameter once.

## Create system design from codebase

Keep the Studio open beside the repository in a WebMCP-capable coding agent and copy
the single request from the Projects home. The request tells the agent that the
`studio_*` tools are site tools of the open page, then walks it through the tools in
one order: inspect the real repository before writing a graph, create a project (its
canvas opens at once), draw the as-is design one component and link at a time, trace the
highest-risk flow into a workflow, then set the yardstick, seal the drawing as one
immutable baseline with structured source evidence, and evaluate it.

Expected WebMCP path:

```text
1  studio_create_study { name, problem, workload? }   → the canvas opens on an empty version
2  studio_get_catalog                                 → kinds, operations, layoutGuide, invariantTemplates
3  studio_apply_architecture_patch × n                → add-node per component, then add-edge per link
4  studio_apply_architecture_patch                    → set-workflow: collections and one handler
5  studio_update_study { contract }                   → workload, targets, faults, invariants
6  studio_import_architecture { fromCandidateId, expectedRevision, repository, evidence }
7  studio_run_evaluation → studio_annotate / studio_focus
```

The yardstick comes after the workflow on purpose: rules name collections, and collections
exist only once `set-workflow` has run. Invariants may be written as
`{ template, args }` using `studio_get_catalog.invariantTemplates` (the same constructors
the guided rule builder uses), or as a full `Invariant`; a rejected invariant comes back
with a repair hint naming both forms.

The agent panel shows these seven steps as a tracker: done steps ticked, the current one
with what unblocks it and the next call filled in with ids and revisions, and the last
failed call inline under the step it belongs to. `studio_create_study` returns the same
`next` line, so the tracker and the agent read one list.

The canvas appears at `studio_create_study`, and from then on every accepted patch is
drawn as it lands, so you watch the architecture form: the camera pans and zooms to keep
the whole drawing in view (or the changed part, once the whole is too small to read), the
component or link the patch worked on is selected and pulses, and the inspector opens on it
with a strip naming the fields the agent just set. Changes to the project's rules and faults
flash the matching section of the left rail. The Agent button in the top bar reads
"Agent working" while a call is in flight. Coordinates are part of the design:
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
default. Agent-authored links must state a `network` profile with positive one-way
`propagationLatency`. Omitting it or using zero is refused. The v7 runtime additionally models
directional bytes, bandwidth, serialization, TCP setup, TLS, reuse, and request-level loss.
`studio_import_architecture` with `fromCandidateId` then turns the drawing into the as-is
baseline in place, keeping its id and everything on the canvas; passing a complete `design`
instead still imports in one call, and fills the empty version the project opened with
rather than leaving it beside the baseline.

### The placeholder workload

A new project is born with a placeholder workload (Poisson 50 req/s, 1200 s, 8 seeds) so
that it is valid before anybody has said what the real traffic is. The first cached result
freezes the workload into the project's yardstick for every version, so
`studio_run_evaluation` and `studio_run_production_scenarios` refuse to run while the
workload is still the placeholder. Pass the observed or assumed arrival as `workload` in
`studio_create_study`, or set it with `studio_update_study` before the first run. The
**Workload** row in the left rail shows the same value with a "placeholder" badge until it
is set; the run button in the interface is not gated, because a person can see what they
are about to lock.

Graph nodes follow runtime, capacity, and failure boundaries rather than the source tree.
A package, handler, goroutine, class, or cron callback stays inside its deployed host unless
it has independently bounded concurrency or lifecycle that matters to the model. When such
an in-process subsystem is split out, its label says `(in-process)` and its evidence cites
both the separate bound and the shared lifecycle. Mutually exclusive provider implementations
are alternatives: the graph shows the choice selected by checked-in deployment configuration,
or the documented default when no deployed configuration exists, and records the other choices
as evidence gaps rather than active dependencies.

A link means that work at its source causes a call to its target for each matching request. It
does not mean ownership, startup order, or "these run in one process." Autonomous pollers,
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

The simulation panel can save virtual-time failure events into the scenario or inject the same
event shape into a running Manual or Full session. Timeline events recover at their declared end;
overlapping degradations compose. This remains a request-level model and does not claim packet
MTU, congestion-control, or reordering fidelity.

Every component and connection must carry architecture or behavior evidence before an
agent-created baseline can be sealed. Observed elements cite a source path and symbol (with line
ranges where available); deductions are labelled inferred and unknown production behaviour is
labelled assumed. The result is a source-revision-pinned account of the system that
exists now, plus evidence gaps and likely risks, not a proposed redesign.

## New project

**New project** on the Projects home opens a fresh project on a blank canvas: one empty
version, no nodes, links, workflow, rules or domain assumptions. The project you had open
stays saved. Use **+ Component** for the first node, connect components on the canvas, and
fill in behaviour through the inspector. A missing-client warning is expected while the
design is incomplete; it does not block editing.

## Projects, versions and the top bar

The top bar reads `Projects > <name>`. **Projects** opens the home over the current
project, listing every saved project with its problem, version count, last change and an AI
mark when any version is agent-authored; each row can be opened, renamed, duplicated or
deleted (the open project can be deleted only after switching to another). **Back** or
Escape returns to the project you came from. The project's name opens a popover to rename
it and its problem statement, duplicate it (results cleared, so the copy's yardstick is
unlocked), export it as a file, or import a file. Export and Import act on the project, so
they live here rather than in the top bar.

The strip under the top bar shows only versions: CURRENT, the others, and **New version**.

The rest of the top bar is six controls: the Behaviour and Load lenses, one Play button
whose label follows the lens, **+ Component**, **Agent** and **Review**.

## The canvas tools

The command bar makes each edit one transaction. Undo and redo cover component edits,
links, notes, frames, batch changes, and a whole drag gesture; they never roll repository
evidence or evaluation receipts backward. Drag a component from **+ Component** or a quick-add
button to place its centre at the exact canvas point, or click it to use the next free slot.
Drag empty canvas space for a selection rectangle, and use Cmd/Ctrl or Shift to extend a
selection. Copy, paste, duplicate, batch delete, align, and distribute act on the selection;
copies always receive fresh component and link ids and deliberately carry no source evidence.

Frames and text notes are saved with each version but remain presentation objects outside the
executable design. They cannot receive connections or evidence and do not change simulations,
evaluation hashes, or approvals. The inspector edits their bounds, text, and a visibly labelled
neutral/info/warning tone. This is an architecture editor: freehand drawing and image tools are
intentionally absent.

All canvas commands have keyboard equivalents and visible focus. Cmd/Ctrl-Z and
Shift-Cmd/Ctrl-Z undo and redo; Cmd/Ctrl-C, V, D, and A copy, paste, duplicate, and select all;
Delete removes the selection; Escape clears it. Focused React Flow elements can be moved with
arrow keys, while a general selection uses the same arrows and Shift moves in 10-pixel steps.
Selection and command results are announced to assistive technology and selected elements carry
a check mark as well as colour.

One floating pane, **Tools**, holds one row: Find, Route, Upstream and Downstream for
exploring the topology, and Link for connecting two components. Drag its header to put it
anywhere on the canvas; it stays inside the canvas edges. Collapse it to a small pill; `/`
expands it and focuses Find. Its position, collapsed state and the minimap choice are
remembered on this device. Zoom in, out and fit sit at the canvas's bottom-left. The minimap
at the bottom-right draws every component in its kind's colour and echoes the selection and
whatever the agent just touched; the button on its corner folds it to a **map** pill in the
same corner, and the pill brings it back.

## The left rail

Both lenses begin with the same persisted **issues** registry. Issues from people, agents,
grounding checks, correctness checks, and load analysis are deduplicated against the current
baseline. Filter by state or severity, select several rows for a human decision, or focus a
targeted issue on the canvas. Select one or more current issues and choose **new solution** to
fork the open architecture into a repository-fix version linked to those exact problems.
**Open**, **verified**, **accepted risk**, and **dismissed** are
shown with text and symbols as well as colour. Agent tools may propose issues but cannot verify,
dismiss, accept risk, or approve them.

Repository-fix versions retain a hypothesis, trade-offs, verification plan, and expected
architecture impact for every selected issue. The Review view renders those relationships as an
issue-by-version matrix. Check outcomes are pinned to the issue revision, architecture revision,
repository revision, and evaluation hash; a later edit or re-import returns the cell to pending.
A person can record a clearly labelled manual result or accept a risk, but an agent cannot certify
its own proposal. Approval remains closed until every required issue passes or has a human
disposition, and an open critical regression always blocks it. Agents can create several
alternatives together with `studio_propose_alternatives`; an unrelated experiment must identify
itself as `candidateType: "exploration"`.

The **Guided / Expert** switch in the top bar is stored on this device. Guided is the default;
Expert reveals stable evidence-reference identifiers and issue revisions without changing the
underlying project.

In the Behaviour lens the left rail shows what you need now: the result ("does it break?"),
the **Workload** row, the rules, and what can go wrong. The Workload row is the one place
the project's arrival is edited; a client node's inspector shows the same value read-only,
because every version runs at the project's workload. Search limits, state overrides, run
length, warm-up, seeds, SLO targets and traffic classes sit in an **Advanced** fold that is
collapsed by default and whose summary line reports the values, so nothing is hidden, only
folded. Everything under Advanced writes the project's workload and targets and re-syncs
the open version immediately, so the canvas shows what the next run will use.

## Continue after the first design

Once a real design exists, tell the agent what outcome you need in normal language, for
example, investigate one production risk or model a specific incident. The agent can
read the current project, preserve the as-is baseline, create a focused version, attach
evidence, and run bounded evaluations. The Studio reports what was tested and the limits
of the claim; it does not call a version globally best.

After you review and approve an eligible version, the agent can read
`studio_get_implementation_handoff` and use its normal repository tools to implement the
pinned delta. The handoff carries issue → architecture impact → verification result mappings.
After implementation, release the approval and re-import the resulting source revision; the new
baseline deliberately invalidates old verification receipts so the as-built system must be
checked again. WebMCP does not edit source code or deploy the application.

## What remains human-only

- approving a design;
- deleting versions or saved projects;
- clearing results to unlock a project's yardstick;
- accepting code changes beyond an approved receipt;
- deployment or release decisions.

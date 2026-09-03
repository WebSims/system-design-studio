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
drawn as it lands, so you watch the architecture form. An `add-node` without `x` and `y` is
placed in the next free grid slot, the same rule the palette uses. Each patch is validated
before it is committed: a link to a node that does not exist yet is refused with a named
error, a missing client is only a warning. `studio_import_architecture` with
`fromCandidateId` then turns the drawing into the as-is baseline in place, keeping its id
and everything on the canvas; passing a complete `design` instead still imports in one call.

Until a candidate exists the studio keeps showing the start screen: creating the study,
setting its contract and validating a draft change the project and the activity log in the
agent panel, but add no candidate, and the canvas renders only candidates. When an agent
has started but nothing is drawn yet, the start screen says so and names the step that is
still missing.

Every observed component and connection should cite a source path and symbol (with line
ranges where available). Deductions are labelled inferred; unknown production behaviour
is labelled assumed. The result is a source-revision-pinned account of the system that
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

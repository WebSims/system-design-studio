# MVP workflow

[< back to the README](../README.md)

System Design Studio starts without a bundled system. Choose one of two paths.

## Create system design from codebase

Keep the Studio open beside the repository in a WebMCP-capable coding agent and copy
the single request from the start screen. The agent should inspect the real repository
before writing a graph, create a clean study, define its workload and success criteria,
and import one immutable as-is baseline with source evidence.

Expected WebMCP path:

```text
studio_create_study → studio_get_catalog → studio_update_study
→ studio_import_architecture
```

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

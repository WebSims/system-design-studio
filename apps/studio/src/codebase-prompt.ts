/**
 * The single MVP handoff from a person to the coding agent sharing this page through WebMCP.
 *
 * This is visible user text, not a hidden system prompt. Repository inspection remains the
 * agent's job; the registered site tools only carry the evidence-backed model into the page.
 *
 * WHY IT IS SHAPED LIKE THIS
 *
 * The agent discovers the `studio_*` tools as WebMCP site tools of the page open in its browser,
 * so the first line says exactly that; without it a coding agent may look for an MCP server or
 * start clicking the UI. The prompt keeps only the outcome, critical sequence and guardrails;
 * tool descriptions and returned next steps own payload syntax and operational detail. The design
 * is DRAWN, not delivered: an empty candidate first, then one patch per component and link, so a
 * person watching the page sees the architecture form. The import at the end seals that drawing
 * as the immutable baseline and links the repository revision.
 */
export const CODEBASE_PROMPT = [
  "Inspect this repository with workspace tools. Use the open System Design Studio page's studio_* WebMCP site tools to draw an evidence-backed as-is architecture; " +
    "the page cannot read files, so do not drive its UI.",
  "Create a study, read its catalog, and record code-backed workload, goals, SLOs, and invariants; leave unknowns blank. " +
    "Plan the full topology and its x/y layout first using layoutGuide: dependency depth left-to-right, parallel branches on separate rows, no overlaps or avoidable edge crossings. " +
    "Open an empty as-is candidate and add one component or link per patch; carry forward each returned revision.",
  "Seal it as the immutable as-is baseline with branch, commit, dirty state, inspected scope, and evidence for every component and link. " +
    "Mark facts observed, deductions inferred, and unknown production behaviour assumed. Follow the tool schemas and next-step guidance.",
  "Read it back, report evidence gaps, annotate and focus the highest risk. " +
    "Stop before redesigning or editing code.",
].join("\n\n")

export const CODEBASE_PROMPT_ROUTE = [
  "inspect the codebase",
  "define the system yardstick",
  "draw the as-is design live, then seal it",
  "show evidence gaps",
] as const

/**
 * What the composer knows about where the person is standing. Every field is optional because
 * every one of them can be absent: no project open, nothing selected, nothing found yet.
 */
export interface PromptContext {
  studyId?: string | null;
  studyName?: string | null;
  candidateId?: string | null;
  candidateLabel?: string | null;
  candidateRevision?: number | null;
  selected?: { kind: "node" | "edge"; id: string; label: string } | null;
  /** One line about the active version's counterexample, when there is one. */
  breaks?: string | null;
}

const contextLines = (ctx: PromptContext): string => {
  const lines: string[] = [];
  if (ctx.studyId) lines.push(`Project (study) id: ${ctx.studyId}${ctx.studyName ? ` ("${ctx.studyName}")` : ""}.`);
  if (ctx.candidateId) {
    lines.push(
      `Active version (candidate) id: ${ctx.candidateId}${ctx.candidateLabel ? ` ("${ctx.candidateLabel}")` : ""}${
        ctx.candidateRevision != null ? `, revision ${ctx.candidateRevision}` : ""
      }.`
    );
  }
  if (ctx.selected) lines.push(`Selected on the canvas: ${ctx.selected.kind} ${ctx.selected.id} ("${ctx.selected.label}").`);
  if (ctx.breaks) lines.push(`The studio found this break in the active version: ${ctx.breaks}`);
  return lines.length > 0 ? `\n\nContext from the studio:\n- ${lines.join("\n- ")}` : "";
};

/**
 * The narrower import: ONE endpoint, traced into request steps with a citation per step.
 *
 * Topology from a repository is the easy half. The race finder needs the read/write steps each
 * handler performs against which store, and those are what a person cannot see in a diagram and
 * an agent can read in the code. Asking for one endpoint at a time keeps the evidence checkable.
 */
export const traceEndpointPrompt = (endpoint: string, ctx: PromptContext): string =>
  `Use the System Design Studio tools on this page. Trace the endpoint ${endpoint.trim() || "<endpoint>"} through this codebase into request steps: ` +
  "for each step say which component runs it, which store it touches, and whether it is a read, a write, a conditional write, a unique insert, a lease acquire/release, a publish or a consume; " +
  "record what is read into which local name and what is written from which expression. " +
  "Then apply the steps to the active version with studio_replace_candidate_draft or studio_apply_architecture_patch as a workflow handler on the component that serves the endpoint, " +
  "adding any collection (counter or table) the code reads or writes to the component that stores it, with realistic initial values. " +
  "Attach evidence with studio_attach_code_evidence: one citation (path, symbol, line range) per step and per collection, marked observed; mark anything you deduced as inferred. " +
  "Then run studio_run_evaluation with correctness only, and if the studio finds a break, use studio_annotate to explain it on the components involved and studio_focus on the step where it goes wrong. Do not change the design or edit code until I ask." +
  contextLines(ctx);

/** Ask for a fix as a NEW version, so the broken one stays for comparison. */
export const fixRacePrompt = (ctx: PromptContext): string =>
  "Use the System Design Studio tools on this page. The active version breaks a rule (see context). " +
  "Create a new version with studio_create_candidate copied from the active one, and change only what removes the break: " +
  "for example an atomic conditional decrement, a unique insert per person, a fenced lease, or a queue with a single consumer. " +
  "Explain the change in the version's intent, run studio_run_evaluation on it with correctness and performance, and use studio_annotate to note the trade-off you expect under load. Do not edit code." +
  contextLines(ctx);

/** Ask for an alternative that trades differently, not a fix. */
export const alternativePrompt = (ctx: PromptContext): string =>
  "Use the System Design Studio tools on this page. Propose one alternative version of the active design with a different trade-off " +
  "(for example queue and worker instead of a synchronous write, or a cache in front of the store), created with studio_create_candidate copied from the active one. " +
  "State the trade-off you expect in the version's intent, run studio_run_evaluation on both, then studio_compare_candidates, and annotate what the numbers show. Do not edit code." +
  contextLines(ctx);

/**
 * After the agent has changed the code: import what is now in the repository and check it
 * against what was approved.
 *
 * The approval has already been released by a person (an agent's import into an approved
 * project is refused), so the prompt only asks for the import and the comparison. The diff
 * itself is drawn by the studio, on the canvas, from two versions it holds.
 */
export const reimportPrompt = (approved: { id: string; label: string }, ctx: PromptContext): string =>
  "Use the System Design Studio tools on this page. The approved architecture change has been applied to the code. " +
  "Re-read the repository at its current HEAD and call studio_import_architecture with the new branch, commit and dirty state, " +
  `labelled "as built" plus the short commit, citing a source path, symbol and line range for every component and connection you observe. ` +
  `Then call studio_compare_candidates between the new import and the approved version ${approved.id} ("${approved.label}"), ` +
  "and studio_annotate every component or link where what was built differs from what was approved, saying which side is right. Do not edit code." +
  contextLines(ctx);

/** A free-form question, carrying the same context so the agent does not have to ask where to look. */
export const freeformPrompt = (text: string, ctx: PromptContext): string =>
  `${text.trim()}\n\nUse the System Design Studio tools on this page where they help, and studio_annotate / studio_focus to point at what you mean on the canvas.` +
  contextLines(ctx);

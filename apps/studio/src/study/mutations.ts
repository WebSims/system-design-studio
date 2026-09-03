import {
  CandidateSchema,
  StudySchema,
  blankDesign,
  migrateAndParse,
  validateDesign,
  validateWorkflow,
  type ArchitectureEvidence,
  type Candidate,
  type CandidateRole,
  type Design,
  type RepositorySnapshot,
  type Study,
} from "@sds/schema";
import { layeredPositions, layoutIssue, type LayoutEdge, type LayoutNode } from "../canvas/layout"

/**
 * Candidate mutations, as pure functions over a study.
 *
 * WHY THESE ARE NOT METHODS ON THE STORE
 *
 * Because the rules they encode -- an agent cannot touch the promoted candidate, a draft
 * replacement must state the revision it replaces, an agent-authored candidate is marked as such
 * and cannot un-mark itself -- are the security model of the agent interface, and a security model
 * that lives inside a React store cannot be tested without a React tree. They are pure, they
 * return a new study, and `webmcp.test.ts` exercises them directly.
 *
 * THE ASYMMETRY IS DELIBERATE
 *
 * A human can do everything here plus promote and delete. An agent can create, replace a draft,
 * and test. There is no `deleteCandidate` or `promoteCandidate` reachable from the tool surface,
 * and that is stronger than a permission flag: an agent cannot be argued into calling a function
 * that was never registered.
 */

export class MutationRefused extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "MutationRefused";
  }
}

/**
 * Agent-authored coordinates are part of the architecture, not cosmetic metadata: a collision is
 * refused with the geometry needed to fix it, never silently repositioned. Humans drag nodes
 * wherever they like.
 */
const assertAgentLayout = (design: Design, by: "human" | "agent") => {
  if (by !== "agent") return
  const issue = layoutIssue(design.nodes)
  if (issue) throw new MutationRefused(issue.message, "design-layout-invalid")
}

/** The raw draft an architecture patch edits before it is parsed. */
interface RawDraft {
  name: string;
  nodes: Array<Record<string, unknown> & { id?: unknown }>;
  edges: Array<Record<string, unknown> & { id?: unknown }>;
  workflow: unknown;
}

const hasPosition = (node: Record<string, unknown>): boolean =>
  typeof node.x === "number" && typeof node.y === "number";

/** Move every node of a raw draft to its layered position; nodes without a string id are left alone. */
const layOutDraft = (draft: RawDraft): number => {
  const nodes: LayoutNode[] = draft.nodes.flatMap((node) =>
    typeof node.id === "string" ? [{ id: node.id, ...(typeof node.kind === "string" ? { kind: node.kind } : {}) }] : []
  );
  const edges: LayoutEdge[] = draft.edges.flatMap((edge) =>
    typeof edge.from === "string" && typeof edge.to === "string" ? [{ from: edge.from, to: edge.to }] : []
  );
  const positions = layeredPositions(nodes, edges);
  draft.nodes = draft.nodes.map((node) => {
    const position = typeof node.id === "string" ? positions.get(node.id) : undefined;
    return position ? { ...node, ...position } : node;
  });
  return positions.size;
};

/** Follow explicit candidate ancestry to the repository-derived as-is model, if one exists. */
export function baselineAncestor(study: Study, candidateId: string): Candidate | null {
  const candidates = new Map(study.candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = candidates.get(candidateId);

  while (current && !seen.has(current.id)) {
    if (current.role === "baseline") return current;
    seen.add(current.id);
    current = current.basedOnCandidateId
      ? candidates.get(current.basedOnCandidateId)
      : undefined;
  }
  return null;
}

function approvalAfterCandidateEdit(
  study: Study,
  candidateId: string
): Pick<Study, "promotedCandidateId" | "approval"> {
  const promotedBaseline = study.promotedCandidateId
    ? baselineAncestor(study, study.promotedCandidateId)
    : null;
  const invalidatesDecision =
    study.promotedCandidateId === candidateId ||
    promotedBaseline?.id === candidateId ||
    study.approval?.candidateId === candidateId ||
    study.approval?.baselineCandidateId === candidateId;

  return invalidatesDecision
    ? { promotedCandidateId: null, approval: null }
    : { promotedCandidateId: study.promotedCandidateId, approval: study.approval };
}

export interface CreateCandidateInput {
  label: string;
  intent?: string;
  notes?: string;
  /** A complete design. Omit to copy `copyFrom`, or the active candidate. */
  design?: unknown;
  copyFrom?: string;
  origin: "human" | "agent";
  /** Internal classification. Agent-facing tools choose this rather than accepting authority. */
  role?: CandidateRole;
  basedOnCandidateId?: string | null;
  evidence?: ArchitectureEvidence[];
}

/**
 * Add a candidate.
 *
 * The `origin` is set by the CALLER of this function, not by the caller of the tool. The WebMCP
 * adapter passes `"agent"` and offers no parameter for it, so an agent cannot mark its own work as
 * a human's. That matters because origin is rendered next to every candidate and is what a
 * reviewer uses to decide how much scrutiny something needs.
 */
export function createCandidate(study: Study, input: CreateCandidateInput): { study: Study; candidate: Candidate } {
  if (study.candidates.length >= MAX_CANDIDATES) {
    throw new MutationRefused(
      `this project already holds ${MAX_CANDIDATES} candidates, which is the limit. Remove one before adding another.`,
      "too-many-candidates"
    );
  }

  // No design and nothing to copy means an empty canvas, not a refusal: it is how a drawing starts
  // in a fresh project, for the palette and for an agent adding one node at a time alike.
  const startsEmpty = input.design === undefined && input.copyFrom === undefined && study.candidates.length === 0;
  const source = input.design !== undefined || startsEmpty ? null : resolveSource(study, input.copyFrom);
  const rawDesign =
    input.design !== undefined ? input.design : startsEmpty ? blankDesign() : structuredClone(source!.design);

  let design;
  try {
    design = migrateAndParse(rawDesign)
    // Only a design the agent wrote is held to the layout contract; a copy of what a person drew
    // is theirs, and refusing the copy would tell the agent to fix something it did not do.
    if (input.design !== undefined) assertAgentLayout(design, input.origin)
  } catch (err) {
    if (err instanceof MutationRefused) throw err
    throw new MutationRefused(
      `the design does not parse: ${err instanceof Error ? err.message : String(err)}. ` +
        `Use studio_validate_draft to see the field-level errors.`,
      "design-invalid"
    );
  }

  const errors = [
    ...validateDesign(design).filter((i) => i.severity === "error"),
    ...validateWorkflow(design).filter((i) => i.severity === "error"),
  ];
  if (errors.length > 0) {
    // Refused rather than stored as a broken candidate. A candidate that cannot be evaluated
    // occupies a slot in the comparison and reports "ineligible: schema-valid failed", which is
    // technically honest and practically just noise -- and an agent that got a success response
    // would move on to testing it.
    throw new MutationRefused(
      `the design has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors
        .slice(0, 3)
        .map((e) => e.message)
        .join("; ")}`,
      "design-invalid"
    );
  }

  const candidate = CandidateSchema.parse({
    id: nextCandidateId(study, input.origin),
    label: input.label,
    pattern: source?.pattern ?? "",
    origin: input.origin,
    role: input.role ?? "experiment",
    basedOnCandidateId:
      input.basedOnCandidateId !== undefined
        ? input.basedOnCandidateId
        : (source?.id ?? null),
    revision: 0,
    notes: input.notes ?? "",
    intent: input.intent ?? "",
    evidence: structuredClone(input.evidence ?? source?.evidence ?? []),
    design,
  });

  const next = StudySchema.parse({
    ...study,
    candidates: [...study.candidates, candidate],
    activeCandidateId: study.activeCandidateId ?? candidate.id,
    updatedAt: Date.now(),
  });

  return { study: next, candidate };
}

export interface ReplaceDraftInput {
  candidateId: string;
  expectedRevision: number;
  design: unknown;
  /** Human edits skip the revision check; agent edits do not. */
  by: "human" | "agent";
}

export type ArchitecturePatchOperation =
  | { op: "add-node"; node: unknown }
  | { op: "update-node"; nodeId: string; patch: Record<string, unknown> }
  | { op: "remove-node"; nodeId: string }
  | { op: "add-edge"; edge: unknown }
  | { op: "update-edge"; edgeId: string; patch: Record<string, unknown> }
  | { op: "remove-edge"; edgeId: string }
  | { op: "set-workflow"; workflow: unknown }
  | { op: "set-design-name"; name: string }
  | { op: "auto-layout" };

export interface ApplyArchitecturePatchInput {
  candidateId: string;
  expectedRevision: number;
  operations: ArchitecturePatchOperation[];
  by: "human" | "agent";
}

export interface ImportRepositoryArchitectureInput {
  repository: RepositorySnapshot;
  label: string;
  intent?: string;
  /** The complete as-is design. Omit when sealing a candidate drawn step by step (`fromCandidateId`). */
  design?: unknown;
  /** An experiment drawn on the canvas, to be turned into the baseline in place. */
  fromCandidateId?: string;
  /** Required with `fromCandidateId` for an agent: the revision it believes it is sealing. */
  expectedRevision?: number;
  evidence?: ArchitectureEvidence[];
  origin: "human" | "agent";
}

export interface AttachArchitectureEvidenceInput {
  candidateId: string;
  expectedRevision: number;
  evidence: ArchitectureEvidence[];
  by: "human" | "agent";
}

/**
 * Replace a candidate's design, bumping its revision.
 *
 * THE REVISION CHECK IS THE POINT
 *
 * Without it, two editors resolve as last-writer-wins and the loser never finds out. That is
 * tolerable when both editors are the same person in the same tab and intolerable when one of
 * them is an agent working from a snapshot it read thirty seconds ago. So an agent must state the
 * revision it believes it is replacing, and a mismatch is refused with both numbers named -- which
 * is enough for the agent to re-read and retry rather than guess.
 *
 * A human editing through the inspector does not state a revision, because the human IS the
 * current state of the UI: there is no snapshot to be stale against.
 */
export function replaceCandidateDraft(study: Study, input: ReplaceDraftInput): { study: Study; candidate: Candidate } {
  const existing = study.candidates.find((c) => c.id === input.candidateId);
  if (!existing) {
    throw new MutationRefused(
      `no candidate "${input.candidateId}". Available: ${study.candidates.map((c) => c.id).join(", ")}`,
      "no-such-candidate"
    );
  }

  if (input.by === "agent" && study.promotedCandidateId === existing.id) {
    // The promoted candidate is the one a human has chosen. An agent that edited it would be
    // changing the decision rather than informing it, and it would do so without anybody
    // approving the change.
    throw new MutationRefused(
      `"${existing.label}" is the promoted candidate and cannot be modified through this interface. ` +
        `Create a new candidate instead; promotion is a human-only action.`,
      "promoted-candidate"
    );
  }

  if (input.by === "agent" && existing.role === "baseline") {
    throw new MutationRefused(
      `"${existing.label}" is an as-is baseline reconstructed from code and cannot be redesigned in place. ` +
        `Create an experiment from it with studio_create_candidate, then patch that experiment.`,
      "baseline-immutable"
    );
  }

  if (input.by === "agent" && existing.revision !== input.expectedRevision) {
    throw new MutationRefused(
      `"${existing.label}" is at revision ${existing.revision}, not ${input.expectedRevision}. ` +
        `Somebody else changed it since you read it. Re-read it with studio_get_candidate and try again.`,
      "revision-conflict"
    );
  }

  let design;
  try {
    design = migrateAndParse(input.design)
    assertAgentLayout(design, input.by)
  } catch (err) {
    if (err instanceof MutationRefused) throw err
    throw new MutationRefused(
      `the design does not parse: ${err instanceof Error ? err.message : String(err)}`,
      "design-invalid"
    );
  }

  const errors = [
    ...validateDesign(design).filter((i) => i.severity === "error"),
    ...validateWorkflow(design).filter((i) => i.severity === "error"),
  ];
  if (errors.length > 0) {
    throw new MutationRefused(
      `the design has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors
        .slice(0, 3)
        .map((e) => e.message)
        .join("; ")}`,
      "design-invalid"
    );
  }

  const nodeIds = new Set(design.nodes.map((node) => node.id));
  const edgeIds = new Set(design.edges.map((edge) => edge.id));
  const evidence = existing.evidence.filter((item) =>
    item.targetKind === "node" ? nodeIds.has(item.targetId) : edgeIds.has(item.targetId)
  );
  const candidate: Candidate = {
    ...existing,
    design,
    evidence,
    revision: existing.revision + 1,
  };
  const next = StudySchema.parse({
    ...study,
    ...approvalAfterCandidateEdit(study, existing.id),
    candidates: study.candidates.map((c) => (c.id === candidate.id ? candidate : c)),
    updatedAt: Date.now(),
  });

  return { study: next, candidate };
}

/**
 * Import one evidence-backed as-is snapshot and link the project to the revision it describes.
 * The mutation is atomic: an invalid design or evidence record cannot leave repository metadata
 * updated without the matching baseline.
 */
export function importRepositoryArchitecture(
  study: Study,
  input: ImportRepositoryArchitectureInput
): { study: Study; candidate: Candidate } {
  if (input.origin === "agent" && study.promotedCandidateId !== null) {
    throw new MutationRefused(
      "this project has a human-approved design. Import the new source snapshot into a new project, or have a person clear the existing decision first.",
      "approved-study"
    );
  }
  const linked = StudySchema.parse({
    ...study,
    repository: input.repository,
    // A new source snapshot changes the meaning of "as-is". Any prior decision must be reviewed
    // against the new baseline rather than silently carried across the import.
    promotedCandidateId: null,
    approval: null,
    updatedAt: Date.now(),
  });
  if (input.fromCandidateId !== undefined) return sealDrawnArchitecture(linked, input, input.fromCandidateId);
  if (input.design === undefined) {
    throw new MutationRefused(
      "supply either the complete as-is design or fromCandidateId of the experiment drawn on the canvas",
      "design-invalid"
    );
  }
  const created = createCandidate(linked, {
    label: input.label,
    intent: input.intent ?? "As-is architecture reconstructed from repository evidence.",
    design: input.design,
    origin: input.origin,
    role: "baseline",
    basedOnCandidateId: null,
    evidence: input.evidence ?? [],
  });
  assertExecutableBaselineContract(created.study, created.candidate);
  return {
    candidate: created.candidate,
    study: StudySchema.parse({ ...created.study, activeCandidateId: created.candidate.id }),
  };
}

/**
 * A baseline is immutable through the agent surface, so do not seal a correctness contract that
 * can never exercise its own invariants. A topology-only import remains valid when the project
 * declares no invariants; the problem is specifically the contradictory combination the explorer
 * would otherwise evaluate vacuously.
 */
function assertExecutableBaselineContract(study: Study, candidate: Candidate): void {
  if (study.correctness.invariants.length === 0) return;
  if ((candidate.design.workflow?.handlers.length ?? 0) > 0) return;

  throw new MutationRefused(
    `cannot seal "${candidate.label}" as an immutable baseline: the project declares ` +
      `${study.correctness.invariants.length} correctness invariant${study.correctness.invariants.length === 1 ? "" : "s"}, ` +
      "but the drawing has no workflow handlers, so every correctness result would be vacuous. " +
      "Add a source-backed workflow with studio_apply_architecture_patch, or remove unsupported invariants before sealing.",
    "baseline-workflow-required"
  );
}

/**
 * Turn an experiment that was drawn on the canvas into the as-is baseline, in place.
 *
 * The drawing path exists so a person can watch the architecture form one patch at a time; the
 * design was validated at every patch, so it is not re-validated here. Sealing keeps the candidate
 * id, so the picture on the canvas does not move, and applies the same rules as a fresh import:
 * baseline role, no ancestor, every evidence id unique, and the agent's revision guard.
 */
function sealDrawnArchitecture(
  linked: Study,
  input: ImportRepositoryArchitectureInput,
  candidateId: string
): { study: Study; candidate: Candidate } {
  const existing = linked.candidates.find((candidate) => candidate.id === candidateId);
  if (!existing) throw new MutationRefused(`no candidate "${candidateId}"`, "no-such-candidate");
  if (existing.role === "baseline") {
    throw new MutationRefused(`"${existing.label}" is already an as-is baseline`, "baseline-immutable");
  }
  if (input.origin === "agent") {
    if (input.expectedRevision === undefined) {
      throw new MutationRefused(
        "expectedRevision is required with fromCandidateId: pass the revision returned by the last patch",
        "revision-conflict"
      );
    }
    if (existing.revision !== input.expectedRevision) {
      throw new MutationRefused(
        `"${existing.label}" is at revision ${existing.revision}, not ${input.expectedRevision}. Re-read it with studio_get_architecture and try again.`,
        "revision-conflict"
      );
    }
  }
  assertExecutableBaselineContract(linked, existing);
  const added = input.evidence ?? [];
  const ids = new Set(existing.evidence.map((item) => item.id));
  const duplicate = added.find((item) => ids.has(item.id));
  if (duplicate) {
    throw new MutationRefused(`evidence id "${duplicate.id}" already exists`, "duplicate-evidence");
  }
  const candidate = CandidateSchema.parse({
    ...existing,
    label: input.label,
    intent: input.intent ?? existing.intent,
    role: "baseline",
    basedOnCandidateId: null,
    evidence: [...existing.evidence, ...structuredClone(added)],
    revision: existing.revision + 1,
  });
  return {
    candidate,
    study: StudySchema.parse({
      ...linked,
      candidates: linked.candidates.map((c) => (c.id === candidate.id ? candidate : c)),
      activeCandidateId: candidate.id,
    }),
  };
}

/** Apply a small graph delta, then validate and commit it through the normal replacement path. */
export function applyArchitecturePatch(
  study: Study,
  input: ApplyArchitecturePatchInput
): { study: Study; candidate: Candidate; changed: string[] } {
  const existing = study.candidates.find((candidate) => candidate.id === input.candidateId);
  if (!existing) {
    throw new MutationRefused(`no candidate "${input.candidateId}"`, "no-such-candidate");
  }
  if (input.operations.length === 0) {
    throw new MutationRefused("an architecture patch needs at least one operation", "empty-patch");
  }

  const draft = structuredClone(existing.design) as unknown as RawDraft;
  const changed: string[] = [];
  // A patch that ends in auto-layout may add nodes without coordinates: the layout supplies them.
  const laysOut = input.operations.some((operation) => operation.op === "auto-layout");

  for (const operation of input.operations) {
    switch (operation.op) {
      case "add-node": {
        const node = structuredClone(operation.node) as Record<string, unknown>;
        if (input.by === "agent" && !laysOut && !hasPosition(node)) {
          throw new MutationRefused(
            "add-node needs numeric x and y chosen from the topology (see studio_get_catalog.layoutGuide), " +
              'or an { op: "auto-layout" } operation later in the same patch so the studio places it by dependency depth.',
            "node-position-required"
          );
        }
        // Placeholder until auto-layout runs; the schema requires numbers.
        draft.nodes.push(hasPosition(node) ? node : { ...node, x: 0, y: 0 });
        changed.push(`added node${typeof node.id === "string" ? ` ${node.id}` : ""}`);
        break;
      }
      case "auto-layout":
        // Applied once, after every other operation, whatever its place in the list.
        break;
      case "update-node": {
        if ("id" in operation.patch || "kind" in operation.patch) {
          throw new MutationRefused(
            "update-node cannot change id or kind; remove and add the node explicitly",
            "patch-identity"
          );
        }
        const index = draft.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw patchTargetMissing("node", operation.nodeId);
        draft.nodes[index] = { ...draft.nodes[index]!, ...structuredClone(operation.patch) };
        changed.push(`updated node ${operation.nodeId}`);
        break;
      }
      case "remove-node": {
        const before = draft.nodes.length;
        draft.nodes = draft.nodes.filter((node) => node.id !== operation.nodeId);
        if (draft.nodes.length === before) throw patchTargetMissing("node", operation.nodeId);
        draft.edges = draft.edges.filter(
          (edge) => edge.from !== operation.nodeId && edge.to !== operation.nodeId
        );
        changed.push(`removed node ${operation.nodeId} and its incident links`);
        break;
      }
      case "add-edge": {
        const edge = structuredClone(operation.edge) as Record<string, unknown>;
        draft.edges.push(edge);
        changed.push(
          typeof edge.from === "string" && typeof edge.to === "string" ? `added link ${edge.from} → ${edge.to}` : "added link"
        );
        break;
      }
      case "update-edge": {
        if ("id" in operation.patch) {
          throw new MutationRefused("update-edge cannot change id", "patch-identity");
        }
        const index = draft.edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw patchTargetMissing("edge", operation.edgeId);
        draft.edges[index] = { ...draft.edges[index]!, ...structuredClone(operation.patch) };
        changed.push(`updated link ${operation.edgeId}`);
        break;
      }
      case "remove-edge": {
        const before = draft.edges.length;
        draft.edges = draft.edges.filter((edge) => edge.id !== operation.edgeId);
        if (draft.edges.length === before) throw patchTargetMissing("edge", operation.edgeId);
        changed.push(`removed link ${operation.edgeId}`);
        break;
      }
      case "set-workflow":
        draft.workflow = structuredClone(operation.workflow);
        changed.push("updated workflow");
        break;
      case "set-design-name":
        draft.name = operation.name;
        changed.push("renamed design");
        break;
    }
  }

  if (laysOut) {
    const placed = layOutDraft(draft);
    changed.push(`laid out ${placed} node${placed === 1 ? "" : "s"} by dependency depth`);
  }

  const replaced = replaceCandidateDraft(study, {
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    design: draft,
    by: input.by,
  });
  return { ...replaced, changed };
}

/** Add evidence without replacing the topology. This is allowed on a baseline and is append-only. */
export function attachArchitectureEvidence(
  study: Study,
  input: AttachArchitectureEvidenceInput
): { study: Study; candidate: Candidate } {
  const existing = study.candidates.find((candidate) => candidate.id === input.candidateId);
  if (!existing) throw new MutationRefused(`no candidate "${input.candidateId}"`, "no-such-candidate");
  if (
    input.by === "agent" &&
    (study.promotedCandidateId === existing.id || study.approval?.baselineCandidateId === existing.id)
  ) {
    throw new MutationRefused(
      `"${existing.label}" is part of the human-approved comparison and cannot be changed through this interface.`,
      "approved-candidate"
    );
  }
  if (input.by === "agent" && existing.revision !== input.expectedRevision) {
    throw new MutationRefused(
      `"${existing.label}" is at revision ${existing.revision}, not ${input.expectedRevision}. Re-read it with studio_get_architecture and try again.`,
      "revision-conflict"
    );
  }
  const ids = new Set(existing.evidence.map((item) => item.id));
  const duplicate = input.evidence.find((item) => ids.has(item.id));
  if (duplicate) {
    throw new MutationRefused(`evidence id "${duplicate.id}" already exists`, "duplicate-evidence");
  }
  const candidate = CandidateSchema.parse({
    ...existing,
    evidence: [...existing.evidence, ...input.evidence],
    revision: existing.revision + 1,
  });
  return {
    study: StudySchema.parse({
      ...study,
      ...approvalAfterCandidateEdit(study, existing.id),
      candidates: study.candidates.map((item) => (item.id === candidate.id ? candidate : item)),
      updatedAt: Date.now(),
    }),
    candidate,
  };
}

function patchTargetMissing(kind: "node" | "edge", id: string): MutationRefused {
  return new MutationRefused(`cannot patch missing ${kind} "${id}"`, "patch-target-missing");
}

/**
 * Promote a candidate. HUMAN ONLY.
 *
 * There is no tool that reaches this, and there should never be one. Promotion is the only action
 * in the product with authority attached -- it says "this is the design we are going with" -- and
 * an agent that could take it would be making the decision the tool exists to inform.
 *
 * It also requires the candidate to be eligible, which is checked by the caller rather than here,
 * because eligibility depends on evaluations this module deliberately knows nothing about.
 */
export function promoteCandidate(study: Study, candidateId: string, now = Date.now()): Study {
  const candidate = study.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new MutationRefused(`no candidate "${candidateId}"`, "no-such-candidate");
  }
  const baseline = baselineAncestor(study, candidateId);
  return StudySchema.parse({
    ...study,
    promotedCandidateId: candidateId,
    approval: {
      candidateId,
      candidateRevision: candidate.revision,
      baselineCandidateId: baseline?.id ?? null,
      baselineRevision: baseline?.revision ?? null,
      approvedAt: now,
    },
    updatedAt: now,
  });
}

/**
 * Withdraw the approval without discarding results.
 *
 * Human only. The use is the step after a hand-off: the agent has changed the code, and the
 * project needs to accept a new source snapshot as "current" to check that what landed is
 * what was approved. An agent's import into an approved project is refused (see
 * `importRepositoryArchitecture`), so a person releases the decision first, explicitly.
 */
export function releaseApproval(study: Study, now = Date.now()): Study {
  return StudySchema.parse({
    ...study,
    promotedCandidateId: null,
    approval: null,
    updatedAt: now,
  });
}

/** Remove a candidate. Human only, and refused for the promoted one. */
export function deleteCandidate(study: Study, candidateId: string): Study {
  if (study.promotedCandidateId === candidateId) {
    throw new MutationRefused(
      "the promoted candidate cannot be removed. Promote something else first.",
      "promoted-candidate"
    );
  }
  if (study.approval?.baselineCandidateId === candidateId) {
    throw new MutationRefused(
      "the baseline used by the approved candidate cannot be removed. Clear the decision first.",
      "approved-baseline"
    );
  }
  const candidates = study.candidates
    .filter((c) => c.id !== candidateId)
    .map((candidate) =>
      candidate.basedOnCandidateId === candidateId
        ? { ...candidate, basedOnCandidateId: null }
        : candidate
    );
  if (candidates.length === study.candidates.length) {
    throw new MutationRefused(`no candidate "${candidateId}"`, "no-such-candidate");
  }
  return StudySchema.parse({
    ...study,
    candidates,
    activeCandidateId:
      study.activeCandidateId === candidateId ? (candidates[0]?.id ?? null) : study.activeCandidateId,
    updatedAt: Date.now(),
  });
}

export function setActiveCandidate(study: Study, candidateId: string): Study {
  if (!study.candidates.some((c) => c.id === candidateId)) {
    throw new MutationRefused(`no candidate "${candidateId}"`, "no-such-candidate");
  }
  return { ...study, activeCandidateId: candidateId };
}

/**
 * Update the active candidate's design in place, for the inspector.
 *
 * Bumps the revision like any other edit, which is what makes an agent's stale snapshot detectable
 * even when the change came from a human typing in a field. If a human edit did not bump, an agent
 * could overwrite it with a revision that looked current.
 */
export function editActiveDesign(study: Study, mutate: (candidate: Candidate) => Candidate): Study {
  const id = study.activeCandidateId;
  if (!id) return study;
  return {
    ...study,
    ...approvalAfterCandidateEdit(study, id),
    candidates: study.candidates.map((c) =>
      c.id === id ? { ...mutate(c), revision: c.revision + 1 } : c
    ),
    updatedAt: Date.now(),
  };
}

const MAX_CANDIDATES = 64;

function resolveSource(study: Study, copyFrom: string | undefined): Candidate {
  const id = copyFrom ?? study.activeCandidateId ?? study.candidates[0]?.id;
  const source = study.candidates.find((c) => c.id === id);
  if (!source) {
    throw new MutationRefused(
      copyFrom
        ? `no candidate "${copyFrom}" to copy from`
        : "this project has no candidate to copy from, so a complete design is required",
      "no-such-candidate"
    );
  }
  return source;
}

/**
 * A fresh id, prefixed by origin.
 *
 * The prefix means an agent-authored candidate is identifiable from its id alone, in a log, in a
 * URL, in a diff -- anywhere the rendered `origin` badge is not present. Collision-checked rather
 * than counter-based, because a counter drifts once anything is deleted.
 */
function nextCandidateId(study: Study, origin: "human" | "agent"): string {
  const prefix = origin === "agent" ? "agent-candidate" : "candidate";
  const taken = new Set(study.candidates.map((c) => c.id));
  for (let n = 1; n < 1000; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.has(id)) return id;
  }
  throw new MutationRefused("could not allocate a candidate id", "id-exhausted");
}

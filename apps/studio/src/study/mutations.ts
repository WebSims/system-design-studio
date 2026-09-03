import {
  CandidateSchema,
  StudySchema,
  migrateAndParse,
  validateDesign,
  validateWorkflow,
  type ArchitectureEvidence,
  type Candidate,
  type CandidateRole,
  type Study,
} from "@sds/schema";

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

  const source = input.design !== undefined ? null : resolveSource(study, input.copyFrom);
  const rawDesign = input.design !== undefined ? input.design : structuredClone(source!.design);

  let design;
  try {
    design = migrateAndParse(rawDesign);
  } catch (err) {
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

  if (input.by === "agent" && existing.revision !== input.expectedRevision) {
    throw new MutationRefused(
      `"${existing.label}" is at revision ${existing.revision}, not ${input.expectedRevision}. ` +
        `Somebody else changed it since you read it. Re-read it with studio_get_candidate and try again.`,
      "revision-conflict"
    );
  }

  let design;
  try {
    design = migrateAndParse(input.design);
  } catch (err) {
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
    candidates: study.candidates.map((c) => (c.id === candidate.id ? candidate : c)),
    updatedAt: Date.now(),
  });

  return { study: next, candidate };
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
export function promoteCandidate(study: Study, candidateId: string): Study {
  if (!study.candidates.some((c) => c.id === candidateId)) {
    throw new MutationRefused(`no candidate "${candidateId}"`, "no-such-candidate");
  }
  return StudySchema.parse({ ...study, promotedCandidateId: candidateId, updatedAt: Date.now() });
}

/** Remove a candidate. Human only, and refused for the promoted one. */
export function deleteCandidate(study: Study, candidateId: string): Study {
  if (study.promotedCandidateId === candidateId) {
    throw new MutationRefused(
      "the promoted candidate cannot be removed. Promote something else first.",
      "promoted-candidate"
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

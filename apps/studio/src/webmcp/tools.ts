import { z } from "zod";
import {
  ArchitectureEvidenceSchema,
  DesignSchema,
  contentHash,
  migrateAndParse,
  validateDesign,
  validateStudy,
  validateWorkflow,
  type Candidate,
  type CandidateEvaluation,
  type ArchitectureEvidence,
  type PortfolioResult,
  type RepositorySnapshot,
  performanceCalibration,
  StudyContractLockedError,
  StudyContractPatchSchema,
  studyContractLock,
  type Study,
  type StudyContractPatch,
} from "@sds/schema";
import {
  MutationRefused,
  assertAgentModelFields,
  type ArchitecturePatchOperation,
} from "../study/mutations";
import { buildImplementationHandoff } from "../implementation-handoff";
import { layoutIssue } from "../canvas/layout";
import { toJsonSchema, type JsonSchema } from "./json-schema";

/**
 * The WebMCP tool surface.
 *
 * WHAT AN AGENT CAN AND CANNOT DO
 *
 * It can look at the study, look at the catalogue of components and patterns, create isolated
 * candidates, validate drafts, run bounded correctness searches, run replicated performance
 * measurements, and compare results. Every number it can report came out of the engine.
 *
 * It cannot delete anything, cannot promote anything, and cannot touch the promoted candidate.
 * There is no tool for any of those, which is stronger than a permission check: an agent cannot
 * be talked into calling a tool that does not exist. Promotion in particular is the one action
 * with authority attached, so it stays behind a human click -- an agent may create, test and
 * argue, but it may not decide.
 *
 * WHY THE TOOLS ARE IMPERATIVE AND TOP-LEVEL
 *
 * Because that is what the target client discovers. OpenAI's WebMCP support reads tools
 * registered through `document.modelContext.registerTool()` on the TOP-LEVEL page; it does not
 * walk iframes and does not pick up declarative tool markup. A declarative surface would be more
 * elegant and would not be found.
 *
 * WHY DESCRIPTIONS ARE STATIC
 *
 * No tool description here interpolates the study's problem statement, a candidate's notes, or
 * any other user-authored text. A description is an instruction to the model, and text that
 * arrives from a document is data -- splicing the second into the first is prompt injection with
 * extra steps, and the study document is exactly the kind of thing a person pastes into without
 * reading. User text reaches the agent only as tool RESULTS, which carry
 * `untrustedContentHint`.
 *
 * WHY EVERY MUTATING CALL CARRIES A REVISION
 *
 * `studio_replace_candidate_draft` requires the revision the caller believes it is replacing. Two
 * agents, or an agent and a human, editing the same candidate would otherwise resolve as
 * last-writer-wins, and the loser would never find out. The check is cheap and the failure it
 * prevents is invisible.
 */

// ---------------------------------------------------------------------------
// input schemas -- the single source for validation AND for the JSON Schema
// ---------------------------------------------------------------------------

const CandidateIdInput = z
  .object({
    candidateId: z.string().min(1).max(64).describe("Candidate id, from studio_get_study."),
  })
  .strict();

const EvaluationInput = z
  .object({
    candidateId: z.string().min(1).max(64),
    /**
     * Deliberately two independent switches rather than one "mode" enum.
     *
     * An agent iterating on correctness wants the search without paying for eight simulated
     * replications, and an agent tuning capacity wants the reverse. An enum would force it to
     * name a combination; two booleans let it say what it wants.
     */
    correctness: z.boolean().default(true).describe("Run the bounded correctness search."),
    performance: z
      .boolean()
      .default(false)
      .describe(
        "Run the replicated performance measurement. Repository models must first have observed performance evidence for every component and link."
      ),
  })
  .strict();

const CreateCandidateInput = z
  .object({
    label: z.string().min(1).max(120).describe("Short human-readable name."),
    intent: z
      .string()
      .max(2000)
      .default("")
      .describe(
        "Why this candidate is expected to be interesting, including whether it is expected to be broken."
      ),
    /**
     * Optional, and when absent the candidate is copied from the study's active one.
     *
     * That default exists because the overwhelmingly common agent workflow is "take what is
     * there and change one thing", and requiring a complete design for that would make the
     * agent restate several hundred fields it does not intend to alter -- every one of which is
     * an opportunity to get one wrong.
     */
    design: z
      .unknown()
      .optional()
      .describe(
        "A complete design document. Omit to copy the project's active candidate as a starting point, or, in a project " +
          "with no candidate yet, to open an empty canvas and draw on it with studio_apply_architecture_patch. " +
          "Validate a supplied design with studio_validate_draft first."
      ),
    copyFrom: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Candidate id to copy, when no design is supplied."),
  })
  .strict();

const ReplaceDraftInput = z
  .object({
    candidateId: z.string().min(1).max(64),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The revision you believe you are replacing, from studio_get_candidate. The call is refused if the candidate has moved on."
      ),
    design: z.unknown().describe("A complete, validated design document."),
  })
  .strict();

const ValidateDraftInput = z
  .object({
    design: z.unknown().describe("A design document to check without storing it."),
  })
  .strict();

const RepositoryInput = z
  .object({
    name: z.string().min(1).max(160).describe("Repository or workspace display name."),
    rootHint: z
      .string()
      .max(1024)
      .default("")
      .describe("Workspace path or stable hint. Prefer a repository-relative label when possible."),
    branch: z.string().max(256).default(""),
    revision: z
      .string()
      .max(256)
      .default("")
      .describe("Git commit or other immutable source revision when available."),
    dirty: z
      .boolean()
      .nullable()
      .default(null)
      .describe("Whether uncommitted source changes were included; null when unknown."),
    scope: z
      .array(z.string().min(1).max(512))
      .max(128)
      .default([])
      .describe("Repository-relative directories or packages included in the scan."),
  })
  .strict();

const ImportArchitectureInput = z
  .object({
    repository: RepositoryInput,
    label: z.string().min(1).max(120).default("As-is architecture"),
    intent: z
      .string()
      .max(2000)
      .default("As-is architecture reconstructed from repository evidence."),
    design: z
      .unknown()
      .optional()
      .describe(
        "Complete design document for the architecture observed at this repository revision. " +
          "Omit when sealing a candidate you drew step by step with fromCandidateId."
      ),
    fromCandidateId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "An experiment drawn on the canvas with studio_create_candidate and studio_apply_architecture_patch. " +
          "It becomes the as-is baseline in place, keeping its id and everything already drawn."
      ),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Required with fromCandidateId: the revision returned by your last patch or evidence call."),
    evidence: z
      .array(ArchitectureEvidenceSchema)
      .max(4096)
      .default([])
      .describe(
        "Evidence records supporting nodes and links. Keep assumptions explicit. With fromCandidateId these are " +
          "appended to the evidence already attached."
      ),
  })
  .strict()
  .refine((input) => (input.design === undefined) !== (input.fromCandidateId === undefined), {
    message: "supply exactly one of design or fromCandidateId",
  });

const GetArchitectureInput = z
  .object({
    candidateId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Candidate to read. Omit for the active architecture."),
  })
  .strict();

const ArchitecturePatchOperationInput = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add-node"),
      node: z
        .unknown()
        .describe(
          "Complete node. x and y are required and should follow studio_get_catalog.layoutGuide (x by dependency depth, " +
            "parallel branches on separate y rows), unless the same patch contains an auto-layout operation, which places every node."
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("update-node"),
      nodeId: z.string().min(1).max(128),
      patch: z.record(z.unknown()).describe("Shallow node field patch. Cannot contain id or kind."),
    })
    .strict(),
  z.object({ op: z.literal("remove-node"), nodeId: z.string().min(1).max(128) }).strict(),
  z.object({ op: z.literal("add-edge"), edge: z.unknown() }).strict(),
  z
    .object({
      op: z.literal("update-edge"),
      edgeId: z.string().min(1).max(128),
      patch: z.record(z.unknown()).describe("Shallow link field patch. Cannot contain id."),
    })
    .strict(),
  z.object({ op: z.literal("remove-edge"), edgeId: z.string().min(1).max(128) }).strict(),
  z.object({ op: z.literal("set-workflow"), workflow: z.unknown() }).strict(),
  z.object({ op: z.literal("set-design-name"), name: z.string().min(1).max(160) }).strict(),
  z
    .object({ op: z.literal("auto-layout") })
    .strict()
    .describe(
      "Move every node to a layered layout computed from the links: callers in the leftmost column, one column per " +
        "dependency depth, each node level with the middle of its callers, no overlaps. Applied after the other " +
        "operations in the patch, so nodes added in the same patch may omit x and y. Use it when hand-placed " +
        "coordinates would be guesswork, or after a newly found dependency changes the shape of the graph."
    ),
]);

const ArchitecturePatchInput = z
  .object({
    candidateId: z.string().min(1).max(64),
    expectedRevision: z.number().int().nonnegative(),
    operations: z
      .array(ArchitecturePatchOperationInput)
      .min(1)
      .max(128)
      .describe("Atomic graph changes, applied in order and committed only if the final design validates."),
  })
  .strict();

const AttachEvidenceInput = z
  .object({
    candidateId: z.string().min(1).max(64),
    expectedRevision: z.number().int().nonnegative(),
    evidence: z.array(ArchitectureEvidenceSchema).min(1).max(256),
  })
  .strict();

const CompareInput = z
  .object({
    candidateIds: z
      .array(z.string().min(1).max(64))
      .max(64)
      .default([])
      .describe("Candidates to include. Empty means every candidate in the project."),
  })
  .strict();

const EmptyInput = z.object({}).strict();

const AnnotateInput = z
  .object({
    candidateId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Candidate the note belongs to. Defaults to the active candidate."),
    targetKind: z
      .enum(["node", "edge", "step", "candidate"])
      .describe("What the note is pinned to. A step is a 0-based index into that candidate's counterexample."),
    targetId: z.string().min(1).max(64).describe("Node id, edge id, step index as a string, or candidate id."),
    text: z.string().min(1).max(400).describe("The note, one or two sentences. Say what, and cite where when you can."),
    tone: z
      .enum(["info", "warn", "bad"])
      .default("info")
      .describe("info: explanation. warn: a risk or trade-off. bad: this is where it breaks."),
  })
  .strict();

/**
 * A flat object rather than a discriminated union, because every tool advertises one closed object
 * schema and clients render those better. `id` is required for node/edge, `index` for step; the
 * tool checks the pairing and says so.
 */
const FocusToolInput = z
  .object({
    kind: z.enum(["node", "edge", "step"]).describe("Select a node or edge, or scrub to a counterexample step."),
    id: z.string().min(1).max(64).optional().describe("Node or edge id. Required for kind node/edge."),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("0-based step of the candidate's counterexample. Required for kind step."),
    candidateId: z.string().min(1).max(64).optional().describe("Defaults to the active candidate."),
  })
  .strict();

// ---------------------------------------------------------------------------
// tool declarations
// ---------------------------------------------------------------------------

/**
 * The host's side of the contract: what the tools need from the application.
 *
 * An interface rather than a direct dependency on the store, so the registration and the tools
 * can be tested against a fake without a browser, a worker or a React tree. This is also what
 * keeps the WebMCP layer an ADAPTER rather than a second implementation path: every method here
 * corresponds to something the manual UI already does.
 */
export interface ToolHost {
  getStudy(): Study;
  getCatalog(): Catalog;
  /** Start a new, empty project document and open it. The current project remains saved. */
  createStudy(input: { name?: string; problem?: string }): Promise<Study>;
  /** Patch the executable contract. Rejects once results exist. */
  updateStudyContract(patch: StudyContractPatch): Promise<Study>;
  /** Saved projects, for switching. */
  listStudies(): Promise<{
    saved: Array<{ id: string; name: string; candidates: number; updatedAt: number }>;
  }>;
  /** Open a saved project. */
  openStudy(input: { studyId: string }): Promise<Study>;
  /** Atomically link a repository snapshot and add its immutable as-is baseline. */
  importArchitecture(input: {
    repository: RepositorySnapshot;
    label: string;
    intent: string;
    design?: unknown;
    fromCandidateId?: string;
    expectedRevision?: number;
    evidence: ArchitectureEvidence[];
  }): Promise<Candidate>;
  /** Create an isolated, visibly-marked agent candidate. Returns the new candidate. */
  createCandidate(input: {
    label: string;
    intent: string;
    design: unknown;
    copyFrom?: string;
  }): Promise<Candidate>;
  /** Replace a candidate's design, refusing if the revision has moved on. */
  replaceCandidateDraft(input: {
    candidateId: string;
    expectedRevision: number;
    design: unknown;
  }): Promise<Candidate>;
  /** Apply a validated, revision-guarded delta to an experiment. */
  applyArchitecturePatch(input: {
    candidateId: string;
    expectedRevision: number;
    operations: ArchitecturePatchOperation[];
  }): Promise<{ candidate: Candidate; changed: string[] }>;
  /** Append evidence to a baseline or experiment without replacing its topology. */
  attachArchitectureEvidence(input: {
    candidateId: string;
    expectedRevision: number;
    evidence: ArchitectureEvidence[];
  }): Promise<Candidate>;
  /** Run an evaluation. Must honour the abort signal. */
  runEvaluation(input: {
    candidateId: string;
    correctness: boolean;
    performance: boolean;
    scenarios: boolean;
    signal?: AbortSignal;
  }): Promise<CandidateEvaluation>;
  getEvaluation(candidateId: string): CandidateEvaluation | null;
  comparePortfolio(candidateIds: readonly string[]): Promise<PortfolioResult>;
  /**
   * Pin a note to something on the canvas. Session-only narration: it is not part of the document,
   * is never saved or exported, and cannot reach a handoff.
   */
  annotate(input: AnnotationInput): { id: string };
  /** Select and pan to an element, or scrub the active version's counterexample to a step. */
  focus(request: FocusInput): void;
  /** Record every call in the local activity log. */
  log(entry: ActivityEntry): void;
  /**
   * A call has started (`true`) or settled (`false`). Lets the interface show that the agent is
   * working while it is, rather than only after, when the log entry lands.
   */
  busy?(tool: string, inFlight: boolean): void;
}

export interface AnnotationInput {
  candidateId: string | null;
  targetKind: "node" | "edge" | "step" | "candidate";
  targetId: string;
  text: string;
  tone: "info" | "warn" | "bad";
}

export interface FocusInput {
  candidateId?: string;
  target: { kind: "node" | "edge"; id: string } | { kind: "step"; index: number };
}

export interface ActivityEntry {
  tool: string;
  at: number;
  ok: boolean;
  summary: string;
  candidateId?: string;
  revision?: number;
}

export interface Catalog {
  componentKinds: Array<{ kind: string; whatItModels: string; capabilities: string[] }>;
  operations: Array<{ op: string; indivisible: boolean; whatItDoes: string }>;
  patterns: Array<{ id: string; label: string; expectation: string }>;
  faults: Array<{ kind: string; whatItModels: string }>;
  layoutGuide: {
    coordinateSystem: string;
    nodeSize: { width: number; height: number };
    minimumGap: number;
    suggestedStep: { x: number; y: number };
    rules: string[];
  };
  performanceGuide: {
    requirement: string;
    componentTiming: string;
    edgeLatency: string;
    placeholders: Array<{
      id: string;
      label: string;
      note: string;
      distribution: unknown;
      rangeMs: readonly [number, number] | null;
      source: string;
      asOf: string;
    }>;
  };
  notes: string[];
}

/**
 * A tool, in the shape `document.modelContext.registerTool` wants.
 *
 * `readOnlyHint` and `untrustedContentHint` are the two annotations that matter here.
 *
 * `readOnlyHint` on the inspection and testing tools tells a client it may call them freely --
 * which is what makes a sensible agent loop possible, because the loop is mostly inspection.
 *
 * `untrustedContentHint` goes on anything that can return text a user wrote: the study's problem
 * statement, a candidate's notes, an invariant's message. That text is data, and a client that
 * treats it as instruction is one paste away from doing what the document says instead of what
 * the user says.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    destructiveHint?: boolean;
  };
  /** Parse-and-run. Throws on invalid input, with the validator's own message. */
  execute(input: unknown, ctx: { signal?: AbortSignal }): Promise<ToolResult>;
}

export interface ToolResult {
  /** Compact structured payload. Large traces are fetched separately. */
  content: unknown;
  isError?: boolean;
}

interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  annotations: ToolDefinition["annotations"];
  run(args: z.infer<S>, ctx: { signal?: AbortSignal }): Promise<unknown>;
}

function define<S extends z.ZodTypeAny>(spec: ToolSpec<S>, host: ToolHost): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.input),
    annotations: spec.annotations,
    async execute(input, ctx) {
      const parsed = spec.input.safeParse(input ?? {});
      if (!parsed.success) {
        // The validator's own messages, verbatim. An agent's feedback loop is only as good as
        // the error it gets back, and a generic "invalid input" turns a one-call correction into
        // a guessing game.
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        host.log({ tool: spec.name, at: Date.now(), ok: false, summary: `refused: ${detail}` });
        return { content: { error: "invalid input", detail }, isError: true };
      }
      host.busy?.(spec.name, true);
      try {
        const content = await spec.run(parsed.data, ctx);
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.log({ tool: spec.name, at: Date.now(), ok: false, summary: message });
        return { content: { error: message }, isError: true };
      } finally {
        host.busy?.(spec.name, false);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// the drawing
// ---------------------------------------------------------------------------

/**
 * An experiment in a project that has no as-is baseline yet is "the drawing": the architecture
 * being put on the canvas one patch at a time, which the import will seal. Experiments forked
 * from a baseline are redesigns and get no such hint.
 */
const isDrawing = (study: Study, candidate: Candidate): boolean =>
  candidate.role === "experiment" && !study.candidates.some((c) => c.role === "baseline");

/** The next step while drawing, with the ids and revision filled in so nothing has to be re-read. */
const drawingNext = (candidate: Candidate): string =>
  `Keep drawing with studio_apply_architecture_patch { candidateId: "${candidate.id}", expectedRevision: ${candidate.revision} }: ` +
  "add-node per component with x/y chosen from studio_get_catalog.layoutGuide (or include auto-layout in the patch and omit them), " +
  "set fanout and positive timing fields explicitly on every service component, add-edge once both ends exist with explicit positive one-way latency and fanoutFactor (1 for one-to-one), " +
  "make every active component reachable from its real external or autonomous client/work source, " +
  "and set-workflow for a source-backed state-changing flow when the project declares correctness invariants; " +
  `each accepted patch appears on the canvas. When complete, seal it with studio_import_architecture { fromCandidateId: "${candidate.id}", expectedRevision, repository, evidence }.`;

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

export function buildTools(host: ToolHost): ToolDefinition[] {
  return [
    define(
      {
        name: "studio_create_study",
        description:
          "Create and open a new project. The currently open project remains saved and can be reopened with " +
          "studio_open_study. Set the new project's yardstick with studio_update_study, then add candidates. " +
          "The page keeps showing its start screen until the project has a candidate: nothing is drawn until " +
          "studio_create_candidate (an empty canvas to draw on) or studio_import_architecture succeeds.",
        input: z
          .object({
            name: z.string().min(1).max(120),
            problem: z.string().max(4000).default(""),
          })
          .strict(),
        annotations: {},
        async run(args) {
          const study = await host.createStudy(args);
          host.log({
            tool: "studio_create_study",
            at: Date.now(),
            ok: true,
            summary: `created project "${study.name}"`,
          });
          return {
            studyId: study.id,
            name: study.name,
            contractLocked: false,
            next:
              "The canvas stays empty until a candidate exists. To draw live, call studio_create_candidate with no design " +
              "for an empty canvas, add each component and link with studio_apply_architecture_patch (position them from " +
              "studio_get_catalog.layoutGuide or include an auto-layout operation), then seal it with " +
              "studio_import_architecture { fromCandidateId }. Or import a complete design in one call.",
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_update_study",
        description:
                    "Set the shared yardstick: workload, SLOs, business goals, invariants, faults and exploration bounds. " +
          "Every candidate is judged against these. Set the invariants BEFORE running anything: a project with " +
          "none fails the correctness gate rather than passing it. Refused once any evaluation exists or a " +
          "candidate is promoted.",
        input: z
          .object({
            name: z.string().min(1).max(120).optional(),
            problem: z.string().max(4000).optional(),
            /*
             * `unknown` here, validated by `StudyContractPatchSchema` inside `run`.
             *
             * Not laziness: an invariant contains an expression, expressions nest without limit,
             * and a recursive validator has no finite JSON Schema. Publishing a truncated one
             * would describe a shape the tool does not actually accept, which is worse than
             * publishing none. Same treatment as `design`, for the same reason, and the
             * validator's own messages come back on a bad call.
             */
            contract: z
              .unknown()
              .optional()
              .describe(
                "Patch for the project contract: { workload?, targets?, contract?, correctness? }. " +
                  "correctness holds invariants, faults, bounds, identityDomains and stateOverrides. " +
                  "See studio_get_study for the current shape and studio_get_catalog for the vocabulary."
              ),
          })
          .strict(),
        annotations: {},
        async run(args) {
          let contract: StudyContractPatch = {};
          if (args.contract !== undefined) {
            // Lock checked BEFORE the patch is validated. When the yardstick is frozen no patch
            // will be accepted, so complaining about a typo would send an agent off to fix
            // something that was never the reason for the refusal.
            const lock = studyContractLock(host.getStudy());
            if (lock.locked) throw new StudyContractLockedError(lock.reason);

            const parsed = StudyContractPatchSchema.safeParse(args.contract);
            if (!parsed.success) {
              throw new Error(
                `the contract patch is not valid: ${parsed.error.issues
                  .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                  .join("; ")}`
              );
            }
            contract = parsed.data;
          }
          const study = await host.updateStudyContract({
            ...contract,
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.problem !== undefined ? { problem: args.problem } : {}),
          } as StudyContractPatch);
          host.log({
            tool: "studio_update_study",
            at: Date.now(),
            ok: true,
            summary: `updated the project contract`,
          });
          return summariseStudy(study);
        },
      },
      host
    ),

    define(
      {
        name: "studio_list_studies",
        description: "List saved projects.",
        input: EmptyInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run() {
          const listed = await host.listStudies();
          host.log({
            tool: "studio_list_studies",
            at: Date.now(),
            ok: true,
            summary: `${listed.saved.length} saved project${listed.saved.length === 1 ? "" : "s"}`,
          });
          return listed;
        },
      },
      host
    ),

    define(
      {
        name: "studio_open_study",
        description: "Open a saved project by studyId. Replaces what is open; nothing is deleted.",
        input: z
          .object({
            studyId: z.string().min(1).max(64),
          })
          .strict(),
        annotations: { untrustedContentHint: true },
        async run(args) {
          const study = await host.openStudy(args);
          host.log({
            tool: "studio_open_study",
            at: Date.now(),
            ok: true,
            summary: `opened "${study.name}"`,
          });
          return summariseStudy(study);
        },
      },
      host
    ),

    define(
      {
        name: "studio_import_architecture",
        description:
          "Import the current as-is architecture of a repository revision. Atomically links the repository and creates an " +
          "immutable baseline with code, config, runtime, documentation or user evidence. Use observed only for facts directly " +
          "supported by the cited source; mark deductions inferred and unknown production behaviour assumed. " +
          "Evidence must cover every component and link. Mark numeric measurements aspect=performance; code proving that a call " +
          "exists is architecture evidence, not timing calibration. Every component timing and link latency must be positive; " +
          "every link must set fanoutFactor (1 for one-to-one), and every active component must be reachable from a client/work source. " +
          "Zero timings and orphan components are refused. " +
          "If the project declares correctness invariants, the design must contain a workflow handler that can exercise them; " +
          "a vacuous immutable baseline is refused. " +
          "Two ways in: pass the complete design in one call, or pass fromCandidateId to seal an experiment you drew " +
          "step by step on the canvas (studio_create_candidate, then studio_apply_architecture_patch per component and link). " +
          "Either way this is what makes the drawing the immutable as-is baseline.",
        input: ImportArchitectureInput,
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async run(args) {
          const sealing = args.fromCandidateId !== undefined;
          const candidate = await host.importArchitecture({
            repository: { ...args.repository, capturedAt: Date.now() },
            label: args.label,
            intent: args.intent,
            ...(sealing ? { fromCandidateId: args.fromCandidateId } : { design: args.design }),
            ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
            evidence: args.evidence,
          });
          host.log({
            tool: "studio_import_architecture",
            at: Date.now(),
            ok: true,
            summary: `${sealing ? "sealed the drawing as" : "imported"} as-is baseline "${candidate.label}" with ${candidate.evidence.length} evidence records`,
            candidateId: candidate.id,
            revision: candidate.revision,
          });
          return {
            candidateId: candidate.id,
            role: candidate.role,
            revision: candidate.revision,
            designHash: contentHash(candidate.design),
            evidenceCount: candidate.evidence.length,
            next:
              "Create an experiment from this baseline with studio_create_candidate before proposing architecture changes.",
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_study",
        description:
                    "Read the current project: problem, workload, SLOs, business goals, invariants, bounds, and the candidates " +
          "with their revisions. Start here. Workload, SLOs, invariants and bounds are project-level; a candidate " +
          "cannot change them. Contains user-authored text.",
        input: EmptyInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run() {
          const study = host.getStudy();
          host.log({ tool: "studio_get_study", at: Date.now(), ok: true, summary: "read the project" });
          return summariseStudy(study);
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_architecture",
        description:
          "Read the active or named architecture as a repository-linked model: role, ancestry, revision, full design, topology " +
          "validation issues and per-node/per-link evidence. Use this before proposing or patching an experiment. Contains repository paths and " +
          "user- or agent-authored claims.",
        input: GetArchitectureInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run({ candidateId }) {
          const study = host.getStudy();
          const id = candidateId ?? study.activeCandidateId ?? study.candidates[0]?.id;
          if (!id) throw new Error("this project has no architecture yet; import an as-is baseline first");
          const candidate = requireCandidate(study, id);
          host.log({
            tool: "studio_get_architecture",
            at: Date.now(),
            ok: true,
            summary: `read ${candidate.role} "${candidate.label}"`,
            candidateId: candidate.id,
            revision: candidate.revision,
          });
          return architecturePayload(study, candidate);
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_catalog",
        description:
          "Read the modelling vocabulary: component kinds, workflow operations and which are indivisible, the shipped " +
          "patterns, injectable faults, layout rules, and non-zero latency placeholders. Read this before writing a " +
          "design. The operations are a closed set, and the indivisible ones are what make a design safe.",
        input: EmptyInput,
        annotations: { readOnlyHint: true },
        async run() {
          host.log({ tool: "studio_get_catalog", at: Date.now(), ok: true, summary: "read the catalog" });
          return host.getCatalog();
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_candidate",
        description:
                    "Read one candidate: its design, workflow, revision and stated intent. The revision is required by " +
          "studio_replace_candidate_draft. Contains user-authored text.",
        input: CandidateIdInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run({ candidateId }) {
          const candidate = requireCandidate(host.getStudy(), candidateId);
          host.log({
            tool: "studio_get_candidate",
            at: Date.now(),
            ok: true,
            summary: `read ${candidate.label}`,
            candidateId,
            revision: candidate.revision,
          });
          return {
            id: candidate.id,
            label: candidate.label,
            pattern: candidate.pattern,
            origin: candidate.origin,
            role: candidate.role,
            basedOnCandidateId: candidate.basedOnCandidateId,
            revision: candidate.revision,
            intent: candidate.intent,
            notes: candidate.notes,
            evidence: candidate.evidence,
            isPromoted: host.getStudy().promotedCandidateId === candidate.id,
            design: candidate.design,
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_apply_architecture_patch",
        description:
          "Apply a small atomic graph delta to an experiment instead of resending the whole design. Operations can add, " +
          "update or remove nodes and links, replace the workflow, or rename the design. Every accepted patch is drawn on " +
          "the canvas immediately, so drawing an architecture one component or link per call lets a person watch it form; " +
          "coordinates communicate the topology (callers to dependencies left-to-right, parallel branches on separate rows, " +
          "shared dependencies centered): either choose x/y per node from studio_get_catalog.layoutGuide, or include an " +
          "auto-layout operation and the studio computes that layout from the links. Overlapping nodes and missing " +
          "coordinates are otherwise refused, never silently repositioned. Agent-authored servers must set fanout explicitly; " +
          "agent-authored service components must set positive timing fields explicitly, and links must include positive one-way " +
          "latency plus fanoutFactor (1 for one-to-one; use a catalog benchmark marked assumed when timing is unmeasured). Requires the revision read from " +
          "studio_get_architecture or returned by the previous call, and refuses baselines, promoted candidates, stale " +
          "revisions, missing targets and results with errors (a link to a node that does not exist yet, for example).",
        input: ArchitecturePatchInput,
        annotations: { readOnlyHint: false },
        async run(args) {
          const result = await host.applyArchitecturePatch({
            candidateId: args.candidateId,
            expectedRevision: args.expectedRevision,
            operations: args.operations as ArchitecturePatchOperation[],
          });
          host.log({
            tool: "studio_apply_architecture_patch",
            at: Date.now(),
            ok: true,
            summary: `patched "${result.candidate.label}": ${result.changed.join(", ")}`,
            candidateId: result.candidate.id,
            revision: result.candidate.revision,
          });
          return {
            candidateId: result.candidate.id,
            revision: result.candidate.revision,
            designHash: contentHash(result.candidate.design),
            changed: result.changed,
            evidenceCount: result.candidate.evidence.length,
            ...(isDrawing(host.getStudy(), result.candidate) ? { next: drawingNext(result.candidate) } : {}),
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_attach_code_evidence",
        description:
          "Append evidence to nodes or links without replacing the architecture. Requires the current candidate revision and " +
          "refuses duplicate ids or missing targets. Evidence is append-only through WebMCP so an agent cannot silently erase " +
          "the basis for an as-is claim.",
        input: AttachEvidenceInput,
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async run(args) {
          const candidate = await host.attachArchitectureEvidence(args);
          host.log({
            tool: "studio_attach_code_evidence",
            at: Date.now(),
            ok: true,
            summary: `attached ${args.evidence.length} evidence records to "${candidate.label}"`,
            candidateId: candidate.id,
            revision: candidate.revision,
          });
          return {
            candidateId: candidate.id,
            revision: candidate.revision,
            evidenceCount: candidate.evidence.length,
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_validate_draft",
        description:
                    "Check a design without storing it. Returns schema, topology and workflow errors naming the field and what " +
          "is wrong, plus warnings. Call this before creating or replacing a candidate. A valid result changes nothing on " +
          "the page; pass the same design to studio_import_architecture or studio_create_candidate to render it.",
        input: ValidateDraftInput,
        annotations: { readOnlyHint: true },
        async run({ design }) {
          const result = validateDraft(design);
          host.log({
            tool: "studio_validate_draft",
            at: Date.now(),
            ok: result.valid,
            summary: result.valid ? "draft is valid, not stored" : `${result.errors.length} errors`,
          });
          if (!result.valid) return result;
          return {
            ...result,
            next:
              "Nothing was stored or drawn. Pass this design to studio_import_architecture (with repository and " +
              "evidence) or studio_create_candidate to put it on the canvas.",
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_create_candidate",
        description:
                    "Create a new candidate architecture: isolated, marked agent-authored, revision 0. Omit the design to copy " +
          "the active candidate, which is what you want when changing one aspect of it, or to start from an empty canvas " +
          "when the project has none. The candidate is drawn on the page at once. Never modifies an existing candidate.",
        input: CreateCandidateInput,
        annotations: { readOnlyHint: false },
        async run(args) {
          const candidate = await host.createCandidate({
            label: args.label,
            intent: args.intent,
            design: args.design,
            ...(args.copyFrom ? { copyFrom: args.copyFrom } : {}),
          });
          host.log({
            tool: "studio_create_candidate",
            at: Date.now(),
            ok: true,
            summary: `created "${candidate.label}"`,
            candidateId: candidate.id,
            revision: candidate.revision,
          });
          return {
            candidateId: candidate.id,
            revision: candidate.revision,
            origin: candidate.origin,
            designHash: contentHash(candidate.design),
            note:
              "This candidate is isolated and marked as agent-authored in the interface. Promoting it is a human-only action.",
            ...(isDrawing(host.getStudy(), candidate) ? { next: drawingNext(candidate) } : {}),
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_replace_candidate_draft",
        description:
                    "Replace a candidate's design with a complete, validated document. Requires the revision you read, and is " +
          "refused if the candidate changed since, so two editors cannot silently overwrite each other. Refused for " +
          "the promoted candidate and for an as-is baseline; create an experiment before redesigning code-derived architecture.",
        input: ReplaceDraftInput,
        annotations: { readOnlyHint: false },
        async run(args) {
          // `z.unknown()` makes a property optional in the inferred type even when a caller is
          // expected to supply it, so the presence check is explicit. An agent that omitted the
          // design entirely gets told so, rather than having `undefined` reach the migrator and
          // come back as "design document must be an object".
          if (args.design === undefined) {
            throw new Error(
              "design is required. Supply a complete design document, or use studio_get_candidate to read the current one first."
            );
          }
          const candidate = await host.replaceCandidateDraft({
            candidateId: args.candidateId,
            expectedRevision: args.expectedRevision,
            design: args.design,
          });
          host.log({
            tool: "studio_replace_candidate_draft",
            at: Date.now(),
            ok: true,
            summary: `replaced "${candidate.label}" draft`,
            candidateId: candidate.id,
            revision: candidate.revision,
          });
          return {
            candidateId: candidate.id,
            revision: candidate.revision,
            designHash: contentHash(candidate.design),
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_run_evaluation",
        description:
          "Run the bounded correctness search and/or the replicated performance measurement for one candidate. Performance " +
          "defaults off and is refused for a repository model until every component and link has observed runtime or user performance evidence. " +
          "Verdicts: VIOLATED, NO_VIOLATION_WITHIN_BOUNDS, INCONCLUSIVE_BOUND_REACHED, INVALID_MODEL. " +
          "NO_VIOLATION_WITHIN_BOUNDS is not proof of safety, and INCONCLUSIVE_BOUND_REACHED establishes nothing " +
          "either way. Fetch the counterexample with studio_get_evaluation.",
        input: EvaluationInput,
        annotations: { readOnlyHint: true },
        async run(args, ctx) {
          const study = host.getStudy();
          const candidate = requireCandidate(study, args.candidateId);
          const calibration = performanceCalibration(study, candidate);
          if (args.performance) assertPerformanceCalibrated(study, candidate);
          const evaluation = await host.runEvaluation({
            candidateId: args.candidateId,
            correctness: args.correctness,
            performance: args.performance,
            scenarios: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          host.log({
            tool: "studio_run_evaluation",
            at: Date.now(),
            ok: true,
            summary: `evaluated ${args.candidateId}: ${evaluation.correctness?.status ?? "performance only"}`,
            candidateId: args.candidateId,
          });
          const compact = compactEvaluation(evaluation);
          return calibration.calibrated
            ? compact
            : {
                ...compact,
                performance: null,
                business: null,
                resources: null,
                scenarios: [],
                performanceWithheld: calibration.message,
              };
        },
      },
      host
    ),

    define(
      {
        name: "studio_run_production_scenarios",
        description:
          "Run the standard production suite for one candidate: bounded concurrent requests and retries, a 3x " +
          "30-second traffic spike with recovery, a load ramp to the project SLO boundary, and 30% degradation " +
          "of a high-impact dependency. Returns measured evidence and a specific recommendation for every probe. " +
          "For a repository model this is refused until every component and link has observed runtime or user performance evidence. " +
          "An inconclusive result names the missing workflow, invariant, SLO, dependency or bound; never treat it as a pass.",
        input: CandidateIdInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run({ candidateId }, ctx) {
          const study = host.getStudy();
          const candidate = requireCandidate(study, candidateId);
          assertPerformanceCalibrated(study, candidate);
          const evaluation = await host.runEvaluation({
            candidateId,
            correctness: false,
            performance: false,
            scenarios: true,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          host.log({
            tool: "studio_run_production_scenarios",
            at: Date.now(),
            ok: true,
            summary: `ran ${evaluation.scenarios.length} production scenarios for ${candidateId}`,
            candidateId,
          });
          return {
            evaluationId: evaluation.evaluationId,
            candidateId,
            candidateRevision: evaluation.candidateRevision,
            scenarios: evaluation.scenarios,
            assumptions: evaluation.assumptions,
            warnings: evaluation.warnings,
            wallMs: evaluation.wallMs,
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_evaluation",
        description:
                    "Read a candidate's cached evaluation, including the full counterexample trace when an invariant was " +
          "violated: actor lanes, operation order, state changes and the faults injected. Null when the candidate " +
          "has not been evaluated at the current design, seeds and bounds.",
        input: CandidateIdInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run({ candidateId }) {
          const study = host.getStudy();
          const candidate = requireCandidate(study, candidateId);
          const evaluation = host.getEvaluation(candidateId);
          host.log({
            tool: "studio_get_evaluation",
            at: Date.now(),
            ok: true,
            summary: evaluation ? "read evaluation" : "no cached evaluation",
            candidateId,
          });
          if (!evaluation) {
            return {
              evaluation: null,
              reason:
                "No evaluation is cached for this candidate at the project's current design, seeds and bounds. Run studio_run_evaluation.",
            };
          }
          const calibration = performanceCalibration(study, candidate);
          if (!calibration.calibrated) {
            return {
              evaluation: {
                ...evaluation,
                performance: null,
                business: null,
                resources: null,
                scenarios: [],
              },
              performanceWithheld: calibration.message,
              interpretationWarning: correctnessInterpretationWarning(evaluation),
            };
          }
          return {
            evaluation,
            interpretationWarning: correctnessInterpretationWarning(evaluation),
          };
        },
      },
      host
    ),

    define(
      {
        name: "studio_compare_candidates",
        description:
          "Compare candidates. Returns each eligibility decision with the reason every gate opened or did not, and " +
          "the Pareto frontier among the ELIGIBLE ones. Eligible means the correctness search ran to exhaustion " +
          "without a violation, repository performance inputs are calibrated, AND the conservative end of the performance interval meets every SLO and goal. " +
          "The frontier is Pareto-optimal among the candidates tested: not globally best, and not ranked. " +
          "Differences within the measured intervals are ties, not wins.",
        input: CompareInput,
        annotations: { readOnlyHint: true },
        async run({ candidateIds }) {
          const portfolio = await host.comparePortfolio(candidateIds);
          host.log({
            tool: "studio_compare_candidates",
            at: Date.now(),
            ok: true,
            summary: `compared ${portfolio.decisions.length}, frontier of ${portfolio.frontier.length}`,
          });
          return portfolio;
        },
      },
      host
    ),

    define(
      {
        name: "studio_get_implementation_handoff",
        description:
          "Read the exact revision-pinned architecture change a person approved for implementation: repository source state, " +
          "before/after component and workflow values, source evidence, acceptance criteria, and unresolved production findings. " +
          "Returns a blocker until a repository-backed experiment has been approved in the interface. This tool does not approve, " +
          "edit repository files, run tests, deploy, or mark the visual model synchronized.",
        input: EmptyInput,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run() {
          const handoff = buildImplementationHandoff(host.getStudy());
          host.log({
            tool: "studio_get_implementation_handoff",
            at: Date.now(),
            ok: true,
            summary:
              handoff.status === "ready"
                ? `read implementation handoff for ${handoff.approvedDesign.candidateId}@r${handoff.approvedDesign.revision}`
                : `implementation handoff blocked: ${handoff.code}`,
            ...(handoff.status === "ready"
              ? {
                  candidateId: handoff.approvedDesign.candidateId,
                  revision: handoff.approvedDesign.revision,
                }
              : {}),
          });
          return handoff;
        },
      },
      host
    ),

    define(
      {
        name: "studio_annotate",
        description:
          "Pin a short note to a component, link, counterexample step or candidate so the person sees your reasoning on the canvas " +
          "(for example: which component the race happens at, what a proposed version trades off). Notes are session-only narration: " +
          "they are not part of the study, are never saved or exported, and cannot change any result.",
        input: AnnotateInput,
        annotations: {},
        async run(args) {
          const study = host.getStudy();
          const candidateId = args.candidateId ?? study.activeCandidateId;
          const candidate = candidateId ? requireCandidate(study, candidateId) : null;
          if (candidate && args.targetKind === "node" && !candidate.design.nodes.some((n) => n.id === args.targetId)) {
            throw new Error(`no node "${args.targetId}" in candidate ${candidate.id}`);
          }
          if (candidate && args.targetKind === "edge" && !candidate.design.edges.some((e) => e.id === args.targetId)) {
            throw new Error(`no edge "${args.targetId}" in candidate ${candidate.id}`);
          }
          if (args.targetKind === "candidate" && !study.candidates.some((c) => c.id === args.targetId)) {
            throw new Error(`no candidate "${args.targetId}"`);
          }
          const note = host.annotate({
            candidateId: args.targetKind === "candidate" ? args.targetId : (candidate?.id ?? null),
            targetKind: args.targetKind,
            targetId: args.targetId,
            text: args.text,
            tone: args.tone,
          });
          host.log({
            tool: "studio_annotate",
            at: Date.now(),
            ok: true,
            summary: `noted on ${args.targetKind} ${args.targetId}: ${args.text.slice(0, 80)}`,
            ...(candidate ? { candidateId: candidate.id } : {}),
          });
          return { noteId: note.id, candidateId: candidate?.id ?? null };
        },
      },
      host
    ),

    define(
      {
        name: "studio_focus",
        description:
          "Point the person at something: select and pan the canvas to a component or link, or scrub the active candidate's " +
          "counterexample to a step (0-based) so the sprites and state chips show that moment. Changes only what is on screen.",
        input: FocusToolInput,
        annotations: {},
        async run(args) {
          const study = host.getStudy();
          const candidateId = args.candidateId ?? study.activeCandidateId;
          const candidate = candidateId ? requireCandidate(study, candidateId) : null;
          if (!candidate) throw new Error("no candidate to focus in");
          if (args.kind === "step") {
            if (args.index === undefined) throw new Error("kind step needs an index");
            const ce = host.getEvaluation(candidate.id)?.correctness?.counterexample ?? null;
            if (!ce) throw new Error(`candidate ${candidate.id} has no counterexample to step through; run studio_run_evaluation first`);
            if (args.index >= ce.steps.length) {
              throw new Error(`step ${args.index} is out of range; the counterexample has ${ce.steps.length} steps`);
            }
            host.focus({ candidateId: candidate.id, target: { kind: "step", index: args.index } });
            host.log({ tool: "studio_focus", at: Date.now(), ok: true, summary: `focused step ${args.index + 1}`, candidateId: candidate.id });
            return { focused: { kind: "step", index: args.index }, candidateId: candidate.id };
          }
          if (args.id === undefined) throw new Error(`kind ${args.kind} needs an id`);
          if (args.kind === "node" && !candidate.design.nodes.some((n) => n.id === args.id)) {
            throw new Error(`no node "${args.id}" in candidate ${candidate.id}`);
          }
          if (args.kind === "edge" && !candidate.design.edges.some((e) => e.id === args.id)) {
            throw new Error(`no edge "${args.id}" in candidate ${candidate.id}`);
          }
          host.focus({ candidateId: candidate.id, target: { kind: args.kind, id: args.id } });
          host.log({
            tool: "studio_focus",
            at: Date.now(),
            ok: true,
            summary: `focused ${args.kind} ${args.id}`,
            candidateId: candidate.id,
          });
          return { focused: { kind: args.kind, id: args.id }, candidateId: candidate.id };
        },
      },
      host
    ),
  ];
}

// ---------------------------------------------------------------------------
// payload shaping
// ---------------------------------------------------------------------------

function requireCandidate(study: Study, id: string): Candidate {
  const candidate = study.candidates.find((c) => c.id === id);
  if (!candidate) {
    throw new Error(
      `no candidate "${id}". Available: ${study.candidates.map((c) => c.id).join(", ")}`
    );
  }
  return candidate;
}

function assertPerformanceCalibrated(study: Study, candidate: Candidate): void {
  const calibration = performanceCalibration(study, candidate);
  if (!calibration.calibrated) {
    throw new Error(
      `${calibration.message} Attach aspect=performance, confidence=observed evidence from runtime measurements or the user, ` +
        "then retry. Correctness can still run now with performance=false."
    );
  }
}

function architecturePayload(study: Study, candidate: Candidate) {
  const confidence = { observed: 0, inferred: 0, assumed: 0 };
  const aspects = { architecture: 0, behavior: 0, performance: 0 };
  for (const evidence of candidate.evidence) confidence[evidence.confidence] += 1;
  for (const evidence of candidate.evidence) aspects[evidence.aspect] += 1;
  return {
    repository: study.repository,
    candidate: {
      id: candidate.id,
      label: candidate.label,
      role: candidate.role,
      origin: candidate.origin,
      basedOnCandidateId: candidate.basedOnCandidateId,
      revision: candidate.revision,
      intent: candidate.intent,
      isPromoted: study.promotedCandidateId === candidate.id,
    },
    design: candidate.design,
    topologyIssues: validateDesign(candidate.design),
    evidence: candidate.evidence,
    performanceCalibration: performanceCalibration(study, candidate),
    evidenceSummary: {
      total: candidate.evidence.length,
      ...confidence,
      byAspect: aspects,
      uncoveredNodes: candidate.design.nodes
        .filter(
          (node) =>
            !candidate.evidence.some(
              (evidence) =>
                evidence.aspect !== "performance" &&
                evidence.targetKind === "node" &&
                evidence.targetId === node.id
            )
        )
        .map((node) => node.id),
      uncoveredEdges: candidate.design.edges
        .filter(
          (edge) =>
            !candidate.evidence.some(
              (evidence) =>
                evidence.aspect !== "performance" &&
                evidence.targetKind === "edge" &&
                evidence.targetId === edge.id
            )
        )
        .map((edge) => edge.id),
    },
  };
}

/**
 * The study, minus every candidate's full design.
 *
 * A study with seven candidates is hundreds of kilobytes of design document, and an agent
 * reading the study wants to know what candidates EXIST, not what they contain. Sending
 * everything would fill a context window with fields nobody asked for and would push the actual
 * problem statement past the point where it gets read. Individual designs come from
 * `studio_get_candidate`.
 */
export function summariseStudy(study: Study) {
  return {
    id: study.id,
    name: study.name,
    problem: study.problem,
    repository: study.repository,
    contract: study.contract,
    workload: study.workload,
    targets: study.targets,
    correctness: {
      invariants: study.correctness.invariants,
      faults: study.correctness.faults,
      bounds: study.correctness.bounds,
      identityDomains: study.correctness.identityDomains,
      stateOverrides: study.correctness.stateOverrides,
    },
    candidates: study.candidates.map((c) => ({
      id: c.id,
      label: c.label,
      pattern: c.pattern,
      origin: c.origin,
      role: c.role,
      basedOnCandidateId: c.basedOnCandidateId,
      revision: c.revision,
      intent: c.intent,
      evidenceCount: c.evidence.length,
      nodeCount: c.design.nodes.length,
      hasWorkflow: c.design.workflow !== null,
      performanceCalibration: performanceCalibration(study, c),
      isPromoted: study.promotedCandidateId === c.id,
      isActive: study.activeCandidateId === c.id,
    })),
    promotedCandidateId: study.promotedCandidateId,
    approval: study.approval,
    notes: [
      "The workload, SLOs, invariants and exploration bounds are project-level. A candidate's local copies are overwritten from the project before every evaluation, so a candidate cannot improve its results by changing the workload.",
      "There is no tool to delete or promote a candidate. Promotion is a human-only action in the interface.",
      "Every numeric and correctness claim you make must come from a studio result. Nothing here should be estimated.",
    ],
  };
}

/**
 * The evaluation, minus the counterexample trace.
 *
 * The trace is the largest part of an evaluation and is only wanted when a violation was found,
 * so `studio_run_evaluation` returns the verdict and the numbers, and the trace is a separate
 * fetch. What is kept is everything needed to decide whether to fetch it.
 */
export function compactEvaluation(evaluation: CandidateEvaluation) {
  const c = evaluation.correctness;
  const p = evaluation.performance;
  return {
    evaluationId: evaluation.evaluationId,
    candidateId: evaluation.candidateId,
    candidateRevision: evaluation.candidateRevision,
    candidateHash: evaluation.candidateHash,
    engineVersion: evaluation.engineVersion,
    seeds: evaluation.seeds,
    correctness: c
      ? {
          status: c.status,
          claim: c.claim,
          bounds: c.bounds,
          faults: c.faults,
          invariantsChecked: c.invariantsChecked,
          stats: c.stats,
          modelErrors: c.modelErrors,
          violatedInvariant: c.counterexample?.invariantId ?? null,
          counterexampleLength: c.counterexample?.steps.length ?? null,
          faultsUsed: c.counterexample?.faultsUsed ?? [],
          traceAvailableVia: c.counterexample ? "studio_get_evaluation" : null,
          interpretationWarning: correctnessInterpretationWarning(evaluation),
        }
      : null,
    performance: p,
    business: evaluation.business,
    resources: evaluation.resources,
    scenarios: evaluation.scenarios,
    assumptions: evaluation.assumptions,
    warnings: evaluation.warnings,
    wallMs: evaluation.wallMs,
  };
}

function correctnessInterpretationWarning(evaluation: CandidateEvaluation): string | null {
  const counterexample = evaluation.correctness?.counterexample;
  if (counterexample?.scope !== "safety" || counterexample.steps.length !== 1) return null;
  return (
    "This safety rule failed after one intermediate operation. If later work may legitimately restore the relationship, " +
    "model it as a postcondition and enable the relevant fault; this trace alone does not establish lost work."
  );
}

/**
 * Validate a draft the way the studio validates it, and say so in the same words.
 *
 * Five layers, reported separately because the fixes are different: agent-policy errors catch
 * semantically dangerous inherited defaults, Zod errors mean a field is the wrong type, topology
 * errors mean the graph does not make sense, layout errors mean authored coordinates collide, and
 * workflow errors mean the state model does not match the topology. An agent that gets one list
 * cannot tell which kind of mistake it made.
 */
export function validateDraft(design: unknown): {
  valid: boolean;
  errors: Array<{ layer: string; code: string; message: string; where?: string }>;
  warnings: Array<{ layer: string; code: string; message: string; where?: string }>;
  designHash: string | null;
} {
  const errors: Array<{ layer: string; code: string; message: string; where?: string }> = [];
  const warnings: Array<{ layer: string; code: string; message: string; where?: string }> = [];

  try {
    assertAgentModelFields(design);
  } catch (err) {
    if (err instanceof MutationRefused) {
      errors.push({ layer: "agent-policy", code: err.code, message: err.message });
    } else {
      throw err;
    }
  }

  let parsed;
  try {
    // Through the migrator, so an agent may legitimately submit an older schema version -- and so
    // it gets the same treatment a saved file gets rather than a stricter one.
    parsed = migrateAndParse(design);
  } catch (err) {
    if (err instanceof z.ZodError) {
      for (const issue of err.issues) {
        errors.push({
          layer: "schema",
          code: issue.code,
          message: issue.message,
          where: issue.path.join("."),
        });
      }
    } else {
      errors.push({
        layer: "schema",
        code: "parse",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { valid: false, errors, warnings, designHash: null };
  }

  for (const issue of validateDesign(parsed)) {
    const entry = {
      layer: "topology",
      code: issue.code,
      message: issue.message,
      ...(issue.nodeId ? { where: issue.nodeId } : issue.edgeId ? { where: issue.edgeId } : {}),
    };
    (issue.severity === "error" ? errors : warnings).push(entry);
  }

  const layout = layoutIssue(parsed.nodes);
  if (layout) {
    errors.push({ layer: "layout", code: layout.code, message: layout.message, where: layout.nodeIds.join(",") });
  }

  for (const issue of validateWorkflow(parsed)) {
    const entry = {
      layer: "workflow",
      code: issue.code,
      message: issue.message,
      ...(issue.opId ? { where: issue.opId } : issue.handlerId ? { where: issue.handlerId } : {}),
    };
    (issue.severity === "error" ? errors : warnings).push(entry);
  }

  if (parsed.workflow === null) {
    warnings.push({
      layer: "workflow",
      code: "no-workflow",
      message:
        "This design declares no workflow, so it has no state and no correctness contract. It can be measured for capacity but it cannot pass the correctness gate, and a verdict about it would be vacuous.",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    designHash: errors.length === 0 ? contentHash(DesignSchema.parse(parsed)) : null,
  };
}

/**
 * Study-level errors attributable to a candidate, for the create/replace path.
 *
 * Checked in addition to the design's own validation, because an invariant that cannot be
 * evaluated against a candidate is a problem with that candidate rather than with the study --
 * and silently skipping it would let the candidate pass a gate it was never tested against.
 */
export function candidateStudyErrors(study: Study, candidateId: string): string[] {
  return validateStudy(study)
    .filter((i) => i.severity === "error" && i.candidateId === candidateId)
    .map((i) => i.message);
}

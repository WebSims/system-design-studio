import { describe, expect, it, beforeEach } from "vitest";
import { pizzaStudy } from "@sds/models";
import {
  activeRepositorySnapshot,
  StudySchema,
  applyStudyContract,
  blankStudy,
  evaluationKey,
  isPlaceholderWorkload,
  studyContractLock,
  walkOperations,
  type CandidateEvaluation,
  type ArchitectureEvidence,
  type PortfolioResult,
  type Study,
  type StudyContractPatch,
} from "@sds/schema";
import { evaluateCandidate } from "@sds/study";
import { registerWebmcpTools, type RegistrationState } from "../src/webmcp/register";
import { buildTools, type ActivityEntry, type ToolHost, type ToolResult } from "../src/webmcp/tools";
import { buildCatalog } from "../src/webmcp/catalog";
import { toJsonSchema, UnsupportedSchema } from "../src/webmcp/json-schema";
import {
  MutationRefused,
  applyArchitecturePatch,
  attachArchitectureEvidence,
  createCandidate,
  createCandidateAlternatives,
  deleteCandidate,
  importRepositoryArchitecture,
  promoteCandidate,
  replaceCandidateDraft,
  upsertSourceInventory,
  upsertIssue,
  type ArchitecturePatchOperation,
} from "../src/study/mutations";
import { z } from "zod";

/**
 * The agent interface.
 *
 * WHAT THESE TESTS ARE REALLY ABOUT
 *
 * Not that the tools work -- that is the easy half. They are about the boundary: that an agent
 * cannot promote, cannot delete, cannot edit the promoted candidate, cannot pass off its work as a
 * human's, cannot silently overwrite an edit it did not see, and cannot make a claim the engine
 * did not produce. Each of those is a way the agent surface could quietly become the authority
 * rather than a caller, and each is asserted here rather than left to code review.
 *
 * The mock `document.modelContext` is deliberately minimal. It records what was registered and
 * lets a test call it, which is all the contract is: a name, a description, an input schema, some
 * annotations, and an executable.
 */

// ---------------------------------------------------------------------------
// a mock host and a mock modelContext
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  execute(input: unknown, ctx?: { signal?: AbortSignal }): Promise<unknown>;
}

class MockModelContext {
  readonly registered: RegisteredTool[] = [];
  readonly unregistered: string[] = [];
  failOn: string | null = null;

  registerTool(tool: RegisteredTool) {
    if (this.failOn === tool.name) throw new Error(`refusing to register ${tool.name}`);
    this.registered.push(tool);
    return { unregister: () => this.unregistered.push(tool.name) };
  }

  call(name: string, input: unknown, ctx?: { signal?: AbortSignal }) {
    const tool = this.registered.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(input, ctx);
  }
}

class TestHost implements ToolHost {
  study: Study;
  readonly activity: ActivityEntry[] = [];
  evaluations = new Map<string, CandidateEvaluation>();
  runCalls: Array<{ candidateId: string; correctness: boolean; performance: boolean; scenarios: boolean }> = [];
  /** Set to make `runEvaluation` wait, so a test can abort it mid-flight. */
  pending: ((abort: boolean) => void) | null = null;

  constructor(study: Study) {
    this.study = study;
  }

  getStudy() {
    return this.study;
  }
  getCatalog() {
    return buildCatalog();
  }
  log(entry: ActivityEntry) {
    this.activity.push(entry);
  }

  async createStudy(input: Parameters<ToolHost["createStudy"]>[0]) {
    this.study = blankStudy({ id: "study-new", ...input });
    return this.study;
  }

  async updateStudyContract(patch: StudyContractPatch & { name?: string; problem?: string }) {
    const { name, problem, ...contract } = patch;
    if (Object.keys(contract).length > 0) this.study = applyStudyContract(this.study, contract);
    if (name !== undefined) this.study = { ...this.study, name };
    if (problem !== undefined) this.study = { ...this.study, problem };
    return this.study;
  }

  async listStudies() {
    return {
      saved: [{ id: this.study.id, name: this.study.name, candidates: this.study.candidates.length, updatedAt: 1 }],
    };
  }

  async openStudy(input: { studyId: string }) {
    if (input.studyId !== this.study.id) throw new Error(`there is no saved project "${input.studyId}".`);
    return this.study;
  }

  async importArchitecture(input: Parameters<ToolHost["importArchitecture"]>[0]) {
    const result = importRepositoryArchitecture(this.study, { ...input, origin: "agent" });
    this.study = result.study;
    return result.candidate;
  }

  async createCandidate(input: Parameters<ToolHost["createCandidate"]>[0]) {
    const { study, candidate } = createCandidate(this.study, {
      label: input.label,
      intent: input.intent,
      ...(input.design !== undefined ? { design: input.design } : {}),
      ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}),
      candidateType: input.candidateType,
      issuePlans: input.issuePlans,
      origin: "agent",
    });
    this.study = study;
    return candidate;
  }

  async createCandidateAlternatives(inputs: Parameters<ToolHost["createCandidateAlternatives"]>[0]) {
    const result = createCandidateAlternatives(this.study, inputs.map((input) => ({ ...input, origin: "agent" as const })));
    this.study = result.study;
    return result.candidates;
  }

  async replaceCandidateDraft(input: { candidateId: string; expectedRevision: number; design: unknown }) {
    const { study, candidate } = replaceCandidateDraft(this.study, { ...input, by: "agent" });
    this.study = study;
    return candidate;
  }

  async applyArchitecturePatch(input: {
    candidateId: string;
    expectedRevision: number;
    operations: ArchitecturePatchOperation[];
  }) {
    const result = applyArchitecturePatch(this.study, { ...input, by: "agent" });
    this.study = result.study;
    return { candidate: result.candidate, changed: result.changed };
  }

  async attachArchitectureEvidence(input: Parameters<ToolHost["attachArchitectureEvidence"]>[0]) {
    const result = attachArchitectureEvidence(this.study, { ...input, by: "agent" });
    this.study = result.study;
    return result.candidate;
  }

  async upsertSourceInventory(input: Parameters<ToolHost["upsertSourceInventory"]>[0]) {
    const result = upsertSourceInventory(this.study, { ...input, by: "agent" });
    this.study = result.study;
    return result.candidate;
  }

  async upsertIssue(input: Parameters<ToolHost["upsertIssue"]>[0]) {
    const result = upsertIssue(this.study, { ...input, source: "agent", by: "agent" });
    this.study = result.study;
    return result.issue;
  }

  async runEvaluation(input: {
    candidateId: string;
    correctness: boolean;
    performance: boolean;
    scenarios: boolean;
    signal?: AbortSignal;
  }) {
    this.runCalls.push({
      candidateId: input.candidateId,
      correctness: input.correctness,
      performance: input.performance,
      scenarios: input.scenarios,
    });
    if (this.pending) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("evaluation aborted"));
        if (input.signal?.aborted) return abort();
        input.signal?.addEventListener("abort", abort);
        this.pending = (didAbort) => (didAbort ? abort() : resolve());
      });
    }
    const evaluation = stubEvaluation(input.candidateId);
    if (input.scenarios) {
      evaluation.scenarios = [
        {
          id: "traffic-spike",
          kind: "traffic-spike",
          label: "3× traffic spike",
          status: "warning",
          summary: "The backlog recovered slowly.",
          evidence: "p99 rose from 40ms to 220ms and recovered in 75s.",
          recommendation: "Add headroom and bound the queue.",
          metrics: { recoverySec: 75 },
          targetNodeId: "api",
          targetEdgeId: null,
          assumptions: ["three times modeled traffic"],
        },
      ];
    }
    this.evaluations.set(input.candidateId, evaluation);
    return evaluation;
  }

  getEvaluation(candidateId: string) {
    return this.evaluations.get(candidateId) ?? null;
  }

  async comparePortfolio(candidateIds: readonly string[]): Promise<PortfolioResult> {
    const ids = candidateIds.length > 0 ? [...candidateIds] : this.study.candidates.map((c) => c.id);
    return {
      studyId: this.study.id,
      engineVersion: "test",
      decisions: ids.map((id) => ({ candidateId: id, eligible: false, gates: [] })),
      frontier: [],
      dominated: [],
      ties: [],
      axes: [],
      claim: "No candidate is eligible for comparison.",
      warnings: [],
    };
  }

  readonly notes: Array<Parameters<ToolHost["annotate"]>[0]> = [];
  readonly focused: Array<Parameters<ToolHost["focus"]>[0]> = [];

  annotate(input: Parameters<ToolHost["annotate"]>[0]) {
    this.notes.push(input);
    return { id: `note-${this.notes.length}` };
  }

  focus(request: Parameters<ToolHost["focus"]>[0]) {
    this.focused.push(request);
  }
}

function stubEvaluation(candidateId: string): CandidateEvaluation {
  return {
    evaluationId: `${candidateId}@stub`,
    candidateId,
    candidateRevision: 0,
    candidateHash: "hash",
    engineVersion: "test",
    seeds: [1, 2],
    boundsHash: "bounds",
    correctness: {
      status: "VIOLATED",
      counterexample: {
        invariantId: "no-oversell",
        invariantLabel: "never oversell",
        message: "two people, one pizza",
        scope: "safety",
        lanes: [],
        steps: [
          { index: 0, laneId: "a1", opId: "r1", opKind: "read", label: "read", fault: null, diffs: [], observed: {} },
        ],
        minimal: true,
        faultsUsed: [],
      },
      invariantsChecked: ["no-oversell"],
      bounds: { actors: 3, faults: 1, transitions: 40, states: 100_000, timeMs: 30_000 },
      faults: {
        duplicateRequest: true,
        retrySameKey: true,
        retryNewKey: true,
        workerCrash: true,
        queueRedelivery: true,
        leaseExpiry: true,
        reservationExpiry: true,
      },
      stats: {
        statesVisited: 26,
        statesEnqueued: 93,
        transitionsApplied: 132,
        maxDepthReached: 4,
        duplicatesPruned: 40,
        independencePruned: 4,
        depthTruncated: 0,
        quiescentTerminals: 0,
        wallMs: 9,
        exhausted: false,
        capHit: "none",
      },
      modelErrors: [],
      claim: "Invariant is violated.",
      assumptions: ["one logical region"],
    },
    performance: null,
    business: null,
    resources: { cpuUnits: null, memoryMb: null, storageMb: null, connectionSlots: null, networkBytes: null, unknownAxes: [], unmeasuredNodes: [] },
    scenarios: [],
    assumptions: [],
    warnings: [],
    createdAt: 0,
    wallMs: 9,
  };
}

let host: TestHost;
let mc: MockModelContext;

beforeEach(() => {
  host = new TestHost(pizzaStudy());
  mc = new MockModelContext();
});

function register(): { state: RegistrationState; unregister: () => void } {
  const r = registerWebmcpTools({ host, target: { modelContext: mc } });
  return { state: r.state, unregister: r.unregister };
}

async function call(name: string, input: unknown, ctx?: { signal?: AbortSignal }) {
  register();
  return (await mc.call(name, input, ctx)) as { content: Record<string, unknown>; isError?: boolean };
}

/** An arrival somebody observed, so a test project is not stuck behind the placeholder gate. */
const OBSERVED_WORKLOAD = { arrival: { kind: "poisson" as const, ratePerSec: 120 } };
const SOURCE_HASH = "a".repeat(64);

function repositoryArchitectureInput(calibrated = false, sourceDesign?: Study["candidates"][number]["design"]) {
  const design = structuredClone(
    sourceDesign ?? pizzaStudy().candidates.find(
      (candidate) => candidate.id === "c7-atomic-decrement-unique-claim"
    )!.design
  );
  const evidence: ArchitectureEvidence[] = [
    ...design.nodes.map((node, index) => ({
      id: `node-${index}`,
      targetKind: "node" as const,
      targetId: node.id,
      target: { kind: "node" as const, nodeId: node.id },
      aspect: "architecture" as const,
      confidence: "observed" as const,
      source: "code" as const,
      path: "src/server.ts",
      lineStart: 12,
      lineEnd: 28,
      symbol: "startServer",
      contentHash: SOURCE_HASH,
      claim: `source establishes the ${node.label} runtime boundary`,
    })),
    ...design.edges.map((edge, index) => ({
      id: `edge-${index}`,
      targetKind: "edge" as const,
      targetId: edge.id,
      target: { kind: "edge" as const, edgeId: edge.id },
      aspect: "architecture" as const,
      confidence: "inferred" as const,
      source: "code" as const,
      path: "src/server.ts",
      lineStart: 12,
      lineEnd: 28,
      symbol: "startServer",
      contentHash: SOURCE_HASH,
      claim: `source establishes the ${edge.from} to ${edge.to} dependency`,
    })),
    ...(calibrated
      ? [
          ...design.nodes.map((node, index) => ({
            id: `perf-node-${index}`,
            targetKind: "node" as const,
            targetId: node.id,
            target: { kind: "node" as const, nodeId: node.id },
            aspect: "performance" as const,
            confidence: "observed" as const,
            source: "runtime" as const,
            path: "",
            lineStart: null,
            lineEnd: null,
            symbol: "",
            contentHash: "",
            claim: `runtime measurement supports ${node.label}'s performance inputs`,
          })),
          ...design.edges.map((edge, index) => ({
            id: `perf-edge-${index}`,
            targetKind: "edge" as const,
            targetId: edge.id,
            target: { kind: "edge" as const, edgeId: edge.id },
            aspect: "performance" as const,
            confidence: "observed" as const,
            source: "runtime" as const,
            path: "",
            lineStart: null,
            lineEnd: null,
            symbol: "",
            contentHash: "",
            claim: `runtime measurement supports ${edge.id}'s latency`,
          })),
        ]
      : []),
  ];
  const workflow = design.workflow;
  if (workflow) {
    evidence.push(
      ...workflow.collections.map((collection, index) => ({
        id: `collection-${index}`,
        target: { kind: "collection" as const, collectionId: collection.id },
        targetKind: "collection" as const,
        targetId: collection.id,
        aspect: "behavior" as const,
        confidence: "observed" as const,
        source: "code" as const,
        path: "src/server.ts",
        lineStart: 12,
        lineEnd: 28,
        symbol: "startServer",
        contentHash: SOURCE_HASH,
        claim: `source establishes collection ${collection.id}`,
      })),
      ...workflow.handlers.map((handler, index) => ({
        id: `handler-${index}`,
        target: { kind: "handler" as const, handlerId: handler.id },
        targetKind: "handler" as const,
        targetId: handler.id,
        aspect: "behavior" as const,
        confidence: "observed" as const,
        source: "code" as const,
        path: "src/server.ts",
        lineStart: 12,
        lineEnd: 28,
        symbol: "startServer",
        contentHash: SOURCE_HASH,
        claim: `source establishes handler ${handler.id}`,
      }))
    );
    for (const handler of workflow.handlers) {
      walkOperations(handler.steps, (operation) => evidence.push({
        id: `operation-${handler.id}-${operation.id}`,
        target: { kind: "operation" as const, handlerId: handler.id, operationId: operation.id },
        targetKind: "operation" as const,
        targetId: operation.id,
        aspect: "behavior" as const,
        confidence: "observed" as const,
        source: "code" as const,
        path: "src/server.ts",
        lineStart: 12,
        lineEnd: 28,
        symbol: "startServer",
        contentHash: SOURCE_HASH,
        claim: `source establishes operation ${operation.id}`,
      }));
    }
  }
  return {
    repository: {
      name: "checkout-service",
      rootHint: "services/checkout",
      branch: "main",
      revision: "abc123",
      dirty: false,
      scope: ["src", "infra"],
    },
    label: "As-is · abc123",
    design,
    evidence,
    sourceInventory: [{
      id: "checkout-entrypoint",
      kind: "entrypoint" as const,
      label: "checkout request",
      path: "src/server.ts",
      symbol: "startServer",
      contentHash: SOURCE_HASH,
      disposition: "modeled" as const,
      target: { kind: "node" as const, nodeId: design.nodes[0]!.id },
      reason: "",
    }],
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers the complete tool surface, imperatively, on the target given", () => {
    const { state } = register();
    expect(state.status).toBe("registered");
    expect(mc.registered.map((t) => t.name)).toEqual([
      "studio_create_study",
      "studio_update_study",
      "studio_list_studies",
      "studio_open_study",
      "studio_import_architecture",
      "studio_get_study",
      "studio_get_architecture",
      "studio_get_catalog",
      "studio_get_candidate",
      "studio_apply_architecture_patch",
      "studio_attach_code_evidence",
      "studio_upsert_source_inventory",
      "studio_get_grounding_report",
      "studio_upsert_issue",
      "studio_get_issues",
      "studio_validate_draft",
      "studio_create_candidate",
      "studio_propose_alternatives",
      "studio_replace_candidate_draft",
      "studio_run_evaluation",
      "studio_run_production_scenarios",
      "studio_get_evaluation",
      "studio_compare_candidates",
      "studio_get_implementation_handoff",
      "studio_annotate",
      "studio_focus",
    ]);
  });

  it("describes project creation as a recoverable switch", () => {
    register();
    const tool = mc.registered.find((candidate) => candidate.name === "studio_create_study")!;
    expect(tool.description).toContain("remains saved");
    expect(tool.description).toContain("studio_open_study");
    expect(tool.description).not.toContain("Replaces whatever is open");
  });

  it("exposes NO tool that could delete or promote a candidate", () => {
    register();
    const names = mc.registered.map((t) => t.name).join(" ");
    // Stronger than a permission check: an agent cannot be argued into calling a tool that was
    // never registered.
    expect(names).not.toMatch(/delete|remove|promote|approve|ship|deploy/i);
  });

  it("marks every read-only and testing tool with readOnlyHint", () => {
    register();
    const readOnly = mc.registered.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly).toEqual([
      "studio_list_studies",
      "studio_get_study",
      "studio_get_architecture",
      "studio_get_catalog",
      "studio_get_candidate",
      "studio_get_grounding_report",
      "studio_get_issues",
      "studio_validate_draft",
      "studio_run_evaluation",
      "studio_run_production_scenarios",
      "studio_get_evaluation",
      "studio_compare_candidates",
      "studio_get_implementation_handoff",
    ]);
  });

  it("marks every tool that can return user-authored text with untrustedContentHint", () => {
    register();
    const untrusted = mc.registered
      .filter((t) => t.annotations?.untrustedContentHint === true)
      .map((t) => t.name);
    // The problem statement, a candidate's notes and an invariant's message are all things a user
    // pasted in. A client that treated them as instruction is one paste away from following the
    // document instead of the user.
    expect(untrusted).toEqual([
      "studio_list_studies",
      "studio_open_study",
      "studio_import_architecture",
      "studio_get_study",
      "studio_get_architecture",
      "studio_get_candidate",
      "studio_attach_code_evidence",
      "studio_upsert_source_inventory",
      "studio_get_grounding_report",
      "studio_upsert_issue",
      "studio_get_issues",
      "studio_run_production_scenarios",
      "studio_get_evaluation",
      "studio_get_implementation_handoff",
    ]);
  });

  it("never interpolates user text into a tool description", () => {
    register();
    const study = host.study;
    for (const tool of mc.registered) {
      expect(tool.description).not.toContain(study.problem.slice(0, 40));
      expect(tool.description).not.toContain(study.name);
      for (const candidate of study.candidates) {
        expect(tool.description).not.toContain(candidate.label);
        if (candidate.intent) expect(tool.description).not.toContain(candidate.intent.slice(0, 30));
      }
    }
  });

  it("reports unsupported rather than throwing when modelContext is absent", () => {
    const r = registerWebmcpTools({ host, target: {} });
    expect(r.state.status).toBe("unsupported");
    if (r.state.status === "unsupported") {
      expect(r.state.reason).toContain("remains usable by hand");
    }
    // And the tool definitions still exist, so the UI can list what an agent WOULD be able to do.
    expect(r.tools.length).toBe(26);
  });

  it("reports unsupported when registerTool is present but not a function", () => {
    const r = registerWebmcpTools({ host, target: { modelContext: { registerTool: "nope" } } });
    expect(r.state.status).toBe("unsupported");
  });

  it("rolls back a partial registration rather than leaving half a surface", () => {
    // An agent that saw four of nine tools would infer the other five do not exist and would work
    // around their absence, which is worse than seeing none.
    mc.failOn = "studio_run_evaluation";
    const r = registerWebmcpTools({ host, target: { modelContext: mc } });
    expect(r.state.status).toBe("failed");
    expect(mc.unregistered.length).toBe(mc.registered.length);
  });

  it("unregisters everything it registered", () => {
    const { unregister } = register();
    unregister();
    expect(mc.unregistered.sort()).toEqual(mc.registered.map((t) => t.name).sort());
  });
});

// ---------------------------------------------------------------------------
// input schemas
// ---------------------------------------------------------------------------

describe("input schemas come from the validators", () => {
  it("every tool advertises a closed object schema", () => {
    register();
    for (const tool of mc.registered) {
      const schema = tool.inputSchema as { type?: string; additionalProperties?: boolean };
      expect(schema.type, tool.name).toBe("object");
      // An agent that sends an extra field has misunderstood something, and accepting it silently
      // means the misunderstanding survives into the next call.
      expect(schema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("matches a snapshot, so widening a validator without regenerating fails a test", () => {
    const tools = buildTools(host);
    const shapes = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    expect(shapes).toMatchSnapshot();
  });

  it("carries bounds from the Zod schema into the JSON Schema", () => {
    const schema = toJsonSchema(
      z.object({
        name: z.string().min(2).max(8),
        count: z.number().int().min(1).max(10),
        flag: z.boolean().default(true),
      })
    );
    expect(schema.properties!.name).toEqual({ type: "string", minLength: 2, maxLength: 8 });
    expect(schema.properties!.count).toEqual({ type: "integer", minimum: 1, maximum: 10 });
    expect(schema.properties!.flag).toEqual({ type: "boolean", default: true });
    // A defaulted field is not required, because the validator will supply it.
    expect(schema.required).toEqual(["name", "count"]);
  });

  it("widens a nullable rather than wrapping it in a union", () => {
    const schema = toJsonSchema(z.object({ x: z.number().nullable() }));
    expect(schema.properties!.x!.type).toEqual(["number", "null"]);
  });

  it("refuses to convert a construct it does not understand", () => {
    // The alternative is a silently wrong description of the input, which an agent then follows.
    expect(() => toJsonSchema(z.object({ when: z.date() }))).toThrow(UnsupportedSchema);
    expect(() => toJsonSchema(z.object({ when: z.date() }))).toThrow(/do NOT hand-write/);
  });
});

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

describe("reading the study", () => {
  it("returns the problem, the contract, the bounds and a candidate list", async () => {
    const { content } = await call("studio_get_study", {});
    expect(content.name).toBe(host.study.name);
    expect(content.problem).toContain("200 free pizzas");
    expect((content.candidates as unknown[]).length).toBe(7);
    expect((content.correctness as { bounds: { actors: number } }).bounds.actors).toBe(3);
  });

  it("omits every candidate's full design, and says where to get it", async () => {
    // A study with seven candidates is hundreds of kilobytes of design. Sending all of it would
    // push the problem statement past the point where it gets read.
    const { content } = await call("studio_get_study", {});
    for (const summary of content.candidates as Array<Record<string, unknown>>) {
      expect(summary.design).toBeUndefined();
      expect(summary.nodeCount).toBeGreaterThan(0);
      expect(typeof summary.revision).toBe("number");
    }
  });

  it("tells the agent it cannot bend the yardstick and cannot promote", async () => {
    const { content } = await call("studio_get_study", {});
    const notes = (content.notes as string[]).join(" ");
    expect(notes).toContain("cannot improve its results by changing the workload");
    expect(notes).toContain("Promotion is a human-only action");
    expect(notes).toContain("must come from a studio result");
  });

  it("returns one candidate in full, with its revision", async () => {
    const { content } = await call("studio_get_candidate", { candidateId: "c1-check-then-write" });
    expect(content.revision).toBe(0);
    expect((content.design as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
    expect(content.origin).toBe("library");
  });

  it("names the available candidates when asked for one that does not exist", async () => {
    const { content, isError } = await call("studio_get_candidate", { candidateId: "nope" });
    expect(isError).toBe(true);
    expect(content.error).toContain("c1-check-then-write");
  });

  it("returns the validator's own messages for bad input rather than a generic refusal", async () => {
    const { content, isError } = await call("studio_get_candidate", { wrongField: 1 });
    expect(isError).toBe(true);
    expect(content.error).toBe("invalid input");
    expect(content.detail).toContain("candidateId");
  });

  it("the catalogue tells an agent which operations are indivisible", async () => {
    const { content } = await call("studio_get_catalog", {});
    const ops = content.operations as Array<{ op: string; indivisible: boolean }>;
    const indivisible = ops.filter((o) => o.indivisible).map((o) => o.op).sort();
    expect(indivisible).toEqual(["acquireLease", "atomic", "conditionalWrite", "insertUnique", "releaseLease"]);
    // And that there is no exactly-once queue, which is the thing a model will otherwise assume.
    expect((content.notes as string[]).join(" ")).toContain("no exactly-once queue setting");
  });

  it("the catalogue keeps repository drawings at real runtime and capacity boundaries", async () => {
    const { content } = await call("studio_get_catalog", {});
    const server = (content.componentKinds as Array<{ kind: string; whatItModels: string }>).find(
      (kind) => kind.kind === "server"
    );
    const notes = (content.notes as string[]).join(" ");

    expect(server?.whatItModels).toContain("deployed runtime or independently bounded capacity/failure boundary");
    expect(server?.whatItModels).toContain("not an arbitrary package, handler, goroutine or class");
    expect(notes).toContain("mutually exclusive providers");
    expect(notes).toContain("schema-required placeholder");
    expect(notes).toContain("not a description of the current mechanism");
    expect(notes).toContain("correctness invariant without a workflow");
  });

  it("gives the agent the layout contract and both ways to meet it", async () => {
    const { content } = await call("studio_get_catalog", {})
    const layout = content.layoutGuide as {
      nodeSize: { width: number; height: number }
      minimumGap: number
      suggestedStep: { x: number; y: number }
      rules: string[]
    }

    expect(layout.nodeSize).toEqual({ width: 216, height: 150 })
    expect(layout.minimumGap).toBe(48)
    expect(layout.suggestedStep).toEqual({ x: 320, y: 240 })
    expect(layout.rules.join(" ")).toMatch(/Coordinates communicate architecture/)
    expect(layout.rules.join(" ")).toMatch(/auto-layout/)
    expect(layout.rules.join(" ")).toMatch(/dependency depth/)
    expect(layout.rules.join(" ")).toMatch(/Never overlap/)
  })

  it("publishes non-zero placeholders without calling them measurements", async () => {
    const { content } = await call("studio_get_catalog", {});
    const guide = content.performanceGuide as {
      requirement: string;
      componentTiming: string;
      edgeLatency: string;
      placeholders: Array<{ distribution: { kind: string } }>;
    };
    expect(guide.requirement).toContain("observed performance evidence");
    expect(guide.componentTiming).toContain("Zero is an unknown-value sentinel");
    expect(guide.edgeLatency).toContain("Zero is an unknown-value sentinel");
    expect(guide.edgeLatency).toContain("fanoutFactor");
    expect(guide.placeholders.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// unified issue registry
// ---------------------------------------------------------------------------

describe("agent issue proposals", () => {
  const proposedIssue = () => ({
    title: "queue consumers have no visible capacity margin",
    description: "The current topology does not establish consumer headroom.",
    severity: "warning",
    category: "scalability",
    evidence: [{ kind: "analysis", analysisHash: "analysis-1", findingId: "queue-headroom" }],
    verification: {
      kind: "performance",
      summary: "Run a matching load evaluation with measured consumer headroom.",
      requiredSignals: ["consumer utilization below target"],
    },
  });

  it("deduplicates repeated proposals and exposes only computed status", async () => {
    await call("studio_create_study", { name: "checkout" });
    const first = await call("studio_upsert_issue", proposedIssue());
    const retry = await call("studio_upsert_issue", proposedIssue());
    expect(first.isError).toBeFalsy();
    const firstIssue = first.content.issue as { id: string };
    expect(retry.content.issue).toMatchObject({ id: firstIssue.id, revision: 0, status: "open" });
    expect(host.study.issueRegistry).toHaveLength(1);

    const listed = await call("studio_get_issues", { status: "open", severity: "warning" });
    const issues = listed.content.issues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "agent", status: "open" });
  });

  it("revision-guards changed proposals and exposes no decision tool", async () => {
    await call("studio_create_study", { name: "checkout" });
    await call("studio_upsert_issue", proposedIssue());
    const stale = await call("studio_upsert_issue", { ...proposedIssue(), severity: "critical" });
    expect(stale.isError).toBe(true);
    expect(String(stale.content.error)).toContain("revision 0");
    const updated = await call("studio_upsert_issue", {
      ...proposedIssue(),
      severity: "critical",
      expectedRevision: 0,
    });
    expect(updated.content.issue).toMatchObject({ severity: "critical", revision: 1, status: "open" });
    expect(buildTools(host).map((tool) => tool.name).join(" ")).not.toMatch(/verify_issue|dismiss_issue|accept_risk/);
  });

  it("proposes multiple issue-linked alternatives without self-verification", async () => {
    await call("studio_create_study", { name: "checkout" });
    const proposed = await call("studio_upsert_issue", proposedIssue());
    const issueId = (proposed.content.issue as { id: string }).id;
    const issuePlan = {
      issueId,
      hypothesis: "Bounded consumers prevent runaway queue growth.",
      tradeoffs: ["Lower peak acceptance rate."],
      verificationPlan: "Run the measured load profile and check utilization.",
      expectedArchitectureImpact: { summary: "Add bounded consumer capacity.", targets: [] },
    };
    const result = await call("studio_propose_alternatives", {
      alternatives: [
        { label: "scale consumers", candidateType: "repository-fix", issuePlans: [issuePlan] },
        { label: "bound ingress", candidateType: "repository-fix", issuePlans: [issuePlan] },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect((result.content.candidates as unknown[])).toHaveLength(2);
    expect(host.study.candidates).toHaveLength(2);
    expect(host.study.candidates.every((candidate) => candidate.issuePlans[0]?.verification === null)).toBe(true);

    const selfVerified = await call("studio_create_candidate", {
      label: "self verified",
      candidateType: "repository-fix",
      issuePlans: [{ ...issuePlan, verification: { status: "passed" } }],
    });
    expect(selfVerified.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repository-backed architecture round trip
// ---------------------------------------------------------------------------

describe("repository-backed architecture", () => {
  it("seals an incomplete baseline as provisional and reports the gap", async () => {
    await call("studio_create_study", { name: "checkout" });
    const input = repositoryArchitectureInput();
    input.evidence.pop();
    const result = await call("studio_import_architecture", input);
    expect(result.isError).toBeFalsy();
    expect((result.content.grounding as { status: string }).status).toBe("provisional");
    expect(activeRepositorySnapshot(host.study)).not.toBeNull();
    expect(host.study.candidates).toHaveLength(1);
    expect(host.study.candidates[0]!.role).toBe("baseline");
  });

  it("keeps unreachable source reconstruction visible as provisional", async () => {
    await call("studio_create_study", { name: "checkout" });
    const input = repositoryArchitectureInput();
    const template = input.design.nodes.find((node) => node.kind === "server")!;
    input.design.nodes.push({
      ...structuredClone(template),
      id: "orphan-worker",
      label: "orphan worker",
      x: template.x + 1600,
      y: template.y + 960,
    });
    input.evidence.push({
      id: "orphan-worker-source",
      targetKind: "node",
      targetId: "orphan-worker",
      target: { kind: "node", nodeId: "orphan-worker" },
      aspect: "architecture",
      confidence: "observed",
      source: "code",
      path: "src/worker.ts",
      lineStart: 1,
      lineEnd: 10,
      symbol: "startWorker",
      contentHash: SOURCE_HASH,
      claim: "source establishes the worker runtime",
    });

    const result = await call("studio_import_architecture", input);
    expect(result.isError).toBeFalsy();
    const grounding = result.content.grounding as { status: string; gaps: Array<{ code: string }> };
    expect(grounding.status).toBe("provisional");
    expect(grounding.gaps).toContainEqual(expect.objectContaining({ code: "model-invalid" }));
  });

  it("imports an evidence-backed baseline atomically", async () => {
    await call("studio_create_study", { name: "checkout" });
    const result = await call("studio_import_architecture", repositoryArchitectureInput());
    expect(result.isError).toBeFalsy();
    expect(result.content.role).toBe("baseline");
    const baseline = host.study.candidates.find((candidate) => candidate.id === result.content.candidateId)!;
    expect(result.content.evidenceCount).toBe(baseline.evidence.length);
    expect(activeRepositorySnapshot(host.study)?.revision).toBe("abc123");
    expect(baseline.role).toBe("baseline");
    expect((result.content.grounding as { status: string }).status).toBe("grounded");
    expect(host.study.activeCandidateId).toBe(baseline.id);
  });

  it("reads coverage and confidence without inventing evidence", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const result = await call("studio_get_architecture", {
      candidateId: imported.content.candidateId,
    });
    const summary = result.content.evidenceSummary as {
      total: number;
      observed: number;
      inferred: number;
      assumed: number;
      uncoveredNodes: string[];
    };
    const baseline = host.study.candidates.find(
      (candidate) => candidate.id === imported.content.candidateId
    )!;
    expect(result.content.topologyIssues).toEqual([]);
    expect(summary.total).toBe(baseline.evidence.length);
    expect(summary.observed).toBeGreaterThanOrEqual(baseline.design.nodes.length);
    expect(summary.inferred).toBe(baseline.design.edges.length);
    expect(summary.uncoveredNodes).toEqual([]);
  });

  it("reports grounding without letting the caller set its status", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const report = await call("studio_get_grounding_report", {
      candidateId: imported.content.candidateId,
    });
    expect(report.content).toMatchObject({
      status: "grounded",
      eligibleForApproval: true,
      repository: { revision: "abc123" },
      inventory: { total: 1, unresolved: 0 },
    });
    expect(JSON.stringify(report.content)).not.toContain("source excerpt");
  });

  it("upserts source inventory with a revision guard and recomputes the receipt", async () => {
    await call("studio_create_study", { name: "checkout" });
    const input = repositoryArchitectureInput();
    input.sourceInventory = [];
    const imported = await call("studio_import_architecture", input);
    expect((imported.content.grounding as { status: string }).status).toBe("provisional");

    const stale = await call("studio_upsert_source_inventory", {
      candidateId: imported.content.candidateId,
      expectedRevision: 99,
      items: repositoryArchitectureInput().sourceInventory,
    });
    expect(stale.isError).toBe(true);
    expect(String(stale.content.error)).toContain("revision 0, not 99");

    const updated = await call("studio_upsert_source_inventory", {
      candidateId: imported.content.candidateId,
      expectedRevision: 0,
      items: repositoryArchitectureInput().sourceInventory,
    });
    expect(updated.content).toMatchObject({ revision: 1, grounding: { status: "grounded" } });
  });

  it("keeps the as-is baseline immutable and patches an experiment instead", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const refused = await call("studio_apply_architecture_patch", {
      candidateId: imported.content.candidateId,
      expectedRevision: 0,
      operations: [{ op: "set-design-name", name: "silently changed baseline" }],
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.content.error)).toContain("as-is baseline");

    const created = await call("studio_create_candidate", {
      label: "connection-pool experiment",
      copyFrom: imported.content.candidateId,
    });
    const patched = await call("studio_apply_architecture_patch", {
      candidateId: created.content.candidateId,
      expectedRevision: 0,
      operations: [{ op: "set-design-name", name: "larger connection pool" }],
    });
    expect(patched.isError).toBeFalsy();
    expect(patched.content.revision).toBe(1);
    expect((patched.content.changed as string[])).toContain("renamed design");
  });

  it("draws the as-is design one patch at a time on an empty canvas, then seals it as the baseline", async () => {
    await call("studio_create_study", { name: "checkout" });

    // No design, no candidate to copy: an empty canvas, visible at once.
    const drawing = await call("studio_create_candidate", { label: "as-is (drawing)" });
    expect(drawing.isError).toBeFalsy();
    expect(host.study.candidates).toHaveLength(1);
    expect(host.study.activeCandidateId).toBe(drawing.content.candidateId);
    const candidateId = drawing.content.candidateId as string;

    const unpositioned = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        {
          op: "add-node",
          node: { id: "browser", kind: "client", label: "browser", client: { arrival: { kind: "poisson", ratePerSec: 20 } } },
        },
      ],
    });
    expect(unpositioned.isError).toBe(true);
    expect(String(unpositioned.content.error)).toContain("needs numeric x and y");
    expect(host.study.candidates[0]!.revision).toBe(0);

    // The agent owns the layout and its coordinates are preserved.
    const client = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        {
          op: "add-node",
          node: { id: "browser", kind: "client", label: "browser", x: 0, y: 240, client: { arrival: { kind: "poisson", ratePerSec: 20 } } },
        },
      ],
    });
    expect(client.isError).toBeFalsy();
    expect((client.content.changed as string[])[0]).toBe("added node browser");

    const overlapping = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 1,
      operations: [
        {
          op: "add-node",
          node: { id: "api", kind: "server", label: "api", x: 0, y: 240, server: { concurrency: 8, fanout: "sequential", serviceTime: { kind: "deterministic", value: 0.01 } } },
        },
      ],
    });
    expect(overlapping.isError).toBe(true);
    expect(String(overlapping.content.error)).toContain("overlap");
    expect(host.study.candidates[0]!.revision).toBe(1);

    const api = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 1,
      operations: [
        {
          op: "add-node",
          node: { id: "api", kind: "server", label: "api", x: 320, y: 240, server: { concurrency: 8, fanout: "sequential", serviceTime: { kind: "deterministic", value: 0.01 } } },
        },
      ],
    });
    expect(api.isError).toBeFalsy();
    const placed = host.study.candidates[0]!.design.nodes;
    expect(placed).toHaveLength(2);
    expect(placed.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 240 },
      { x: 320, y: 240 },
    ]);

    // A link to a node that does not exist yet is refused, and the drawing is untouched.
    const dangling = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 2,
      operations: [{ op: "add-edge", edge: { id: "api-db", from: "api", to: "db", latency: { kind: "deterministic", value: 0.25 }, fanoutFactor: 1 } }],
    });
    expect(dangling.isError).toBe(true);
    expect(host.study.candidates[0]!.revision).toBe(2);

    const link = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 2,
      operations: [{ op: "add-edge", edge: { id: "browser-api", from: "browser", to: "api", latency: { kind: "deterministic", value: 0.25 }, fanoutFactor: 1 } }],
    });
    expect(link.isError).toBeFalsy();
    expect((link.content.changed as string[])[0]).toBe("added link browser → api");

    // Sealing needs the current revision.
    const stale = await call("studio_import_architecture", {
      repository: { name: "checkout-service", revision: "abc123" },
      fromCandidateId: candidateId,
      expectedRevision: 2,
    });
    expect(stale.isError).toBe(true);
    expect(String(stale.content.error)).toContain("revision 3, not 2");

    const sealed = await call("studio_import_architecture", {
      repository: { name: "checkout-service", revision: "abc123" },
      label: "As-is · abc123",
      fromCandidateId: candidateId,
      expectedRevision: 3,
      evidence: [
        {
          id: "browser-entrypoint",
          targetKind: "node",
          targetId: "browser",
          confidence: "observed",
          source: "code",
          path: "src/server.ts",
          claim: "the browser originates this request path",
        },
        {
          id: "api-entrypoint",
          targetKind: "node",
          targetId: "api",
          confidence: "observed",
          source: "code",
          path: "src/server.ts",
          claim: "the HTTP server is created here",
        },
        {
          id: "browser-api-route",
          targetKind: "edge",
          targetId: "browser-api",
          confidence: "observed",
          source: "code",
          path: "src/server.ts",
          claim: "the request reaches the HTTP server",
        },
      ],
    });
    expect(sealed.isError).toBeFalsy();
    // Same candidate, now the baseline: the picture on the canvas does not move.
    expect(sealed.content.candidateId).toBe(candidateId);
    expect(sealed.content.role).toBe("baseline");
    expect(sealed.content.evidenceCount).toBe(3);
    expect(host.study.candidates).toHaveLength(1);
    expect(activeRepositorySnapshot(host.study)?.revision).toBe("abc123");

    const again = await call("studio_import_architecture", {
      repository: { name: "checkout-service", revision: "abc123" },
      fromCandidateId: candidateId,
      expectedRevision: 4,
    });
    expect(again.isError).toBe(true);
    expect(String(again.content.error)).toContain("already an as-is baseline");
  });

  it("seals declared correctness invariants without a workflow as provisional", async () => {
    await call("studio_create_study", { name: "checkout" });
    await call("studio_update_study", {
      contract: {
        correctness: {
          invariants: [
            {
              id: "always-safe",
              label: "the declared rule holds",
              scope: "safety",
              expr: { kind: "lit", value: true },
              message: "The rule was violated.",
            },
          ],
        },
      },
    });
    const drawing = await call("studio_create_candidate", { label: "as-is (drawing)" });

    const sealed = await call("studio_import_architecture", {
      repository: { name: "checkout-service", revision: "abc123" },
      fromCandidateId: drawing.content.candidateId,
      expectedRevision: 0,
    });

    expect(sealed.isError).toBeFalsy();
    const report = sealed.content.grounding as { status: string; gaps: Array<{ code: string }> };
    expect(report.status).toBe("provisional");
    expect(report.gaps).toContainEqual(expect.objectContaining({ code: "model-invalid" }));
    expect(activeRepositorySnapshot(host.study)).not.toBeNull();
    expect(host.study.candidates[0]!.role).toBe("baseline");
  });

  it("lays a drawing out by dependency depth when the agent asks, placing nodes added without coordinates", async () => {
    await call("studio_create_study", { name: "checkout" });
    const drawing = await call("studio_create_candidate", { label: "as-is (drawing)" });
    const candidateId = drawing.content.candidateId as string;
    const server = { concurrency: 8, fanout: "sequential", serviceTime: { kind: "deterministic", value: 0.01 } };
    const latency = { kind: "deterministic", value: 0.25 };

    const patched = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        { op: "auto-layout" },
        { op: "add-node", node: { id: "browser", kind: "client", label: "browser", client: { arrival: { kind: "poisson", ratePerSec: 20 } } } },
        { op: "add-node", node: { id: "api", kind: "server", label: "api", server } },
        { op: "add-node", node: { id: "worker", kind: "server", label: "worker", server } },
        { op: "add-node", node: { id: "pg", kind: "database", label: "postgres", database: { serviceTime: { kind: "deterministic", value: 0.005 } } } },
        { op: "add-edge", edge: { id: "browser-api", from: "browser", to: "api", latency, fanoutFactor: 1 } },
        { op: "add-edge", edge: { id: "browser-worker", from: "browser", to: "worker", latency, fanoutFactor: 1 } },
        { op: "add-edge", edge: { id: "api-pg", from: "api", to: "pg", latency, fanoutFactor: 1 } },
        { op: "add-edge", edge: { id: "worker-pg", from: "worker", to: "pg", latency, fanoutFactor: 1 } },
      ],
    });
    expect(patched.isError).toBeFalsy();
    expect((patched.content.changed as string[]).at(-1)).toBe("laid out 4 nodes by dependency depth");

    const byId = new Map(host.study.candidates[0]!.design.nodes.map((node) => [node.id, node]));
    expect(byId.get("browser")!.x).toBeLessThan(byId.get("api")!.x);
    expect(byId.get("api")!.x).toBe(byId.get("worker")!.x);
    expect(byId.get("api")!.y).not.toBe(byId.get("worker")!.y);
    expect(byId.get("pg")!.x).toBeGreaterThan(byId.get("api")!.x);

    // Without auto-layout in the patch, a node still needs its coordinates.
    const unpositioned = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 1,
      operations: [{ op: "add-node", node: { id: "cache", kind: "cache", label: "cache", cache: { serviceTime: { kind: "deterministic", value: 0.2 } } } }],
    });
    expect(unpositioned.isError).toBe(true);
    expect(String(unpositioned.content.error)).toContain("auto-layout");
  });

  it("requires explicit server fanout, node timing and link multiplicity/latency from an agent", async () => {
    await call("studio_create_study", { name: "checkout" });
    const drawing = await call("studio_create_candidate", { label: "as-is (drawing)" });
    const candidateId = drawing.content.candidateId as string;

    const implicitFanout = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        {
          op: "add-node",
          node: {
            id: "api",
            kind: "server",
            label: "api",
            x: 320,
            y: 0,
            server: { concurrency: 8, serviceTime: { kind: "deterministic", value: 1 } },
          },
        },
      ],
    });
    expect(implicitFanout.isError).toBe(true);
    expect(String(implicitFanout.content.error)).toContain("fanout explicitly");

    const zeroTiming = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        {
          op: "add-node",
          node: {
            id: "zero-worker",
            kind: "server",
            label: "zero worker",
            x: 320,
            y: 0,
            server: {
              concurrency: 1,
              fanout: "sequential",
              serviceTime: { kind: "deterministic", value: 0 },
            },
          },
        },
      ],
    });
    expect(zeroTiming.isError).toBe(true);
    expect(String(zeroTiming.content.error)).toContain("never use 0ms");

    const nodes = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 0,
      operations: [
        { op: "auto-layout" },
        {
          op: "add-node",
          node: {
            id: "timer",
            kind: "client",
            label: "autonomous timer",
            client: { arrival: { kind: "deterministic", ratePerSec: 1 } },
          },
        },
        {
          op: "add-node",
          node: {
            id: "worker",
            kind: "server",
            label: "worker (in-process)",
            server: {
              concurrency: 1,
              fanout: "sequential",
              serviceTime: { kind: "deterministic", value: 1 },
            },
          },
        },
      ],
    });
    expect(nodes.isError).toBeFalsy();

    for (const edge of [
      { id: "missing", from: "timer", to: "worker", fanoutFactor: 1 },
      {
        id: "zero",
        from: "timer",
        to: "worker",
        latency: { kind: "deterministic", value: 0 },
        fanoutFactor: 1,
      },
    ]) {
      const result = await call("studio_apply_architecture_patch", {
        candidateId,
        expectedRevision: 1,
        operations: [{ op: "add-edge", edge }],
      });
      expect(result.isError).toBe(true);
      expect(String(result.content.error)).toMatch(/latency/);
      expect(host.study.candidates[0]!.revision).toBe(1);
    }

    const implicitMultiplicity = await call("studio_apply_architecture_patch", {
      candidateId,
      expectedRevision: 1,
      operations: [
        {
          op: "add-edge",
          edge: {
            id: "implicit-multiplicity",
            from: "timer",
            to: "worker",
            latency: { kind: "deterministic", value: 0.25 },
          },
        },
      ],
    });
    expect(implicitMultiplicity.isError).toBe(true);
    expect(String(implicitMultiplicity.content.error)).toContain("fanoutFactor explicitly");
  });

  it("refuses an import that names both a design and a drawn candidate, or neither", async () => {
    await call("studio_create_study", { name: "checkout" });
    const repository = { name: "checkout-service" };
    const neither = await call("studio_import_architecture", { repository });
    expect(neither.isError).toBe(true);
    const both = await call("studio_import_architecture", {
      ...repositoryArchitectureInput(),
      fromCandidateId: "agent-candidate-1",
      expectedRevision: 0,
    });
    expect(both.isError).toBe(true);
  });

  it("attaches evidence append-only with a revision guard", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const baseline = host.study.candidates.find(
      (candidate) => candidate.id === imported.content.candidateId
    )!;
    const edge = baseline.design.edges[0]!;
    const attached = await call("studio_attach_code_evidence", {
      candidateId: baseline.id,
      expectedRevision: 0,
      evidence: [
        {
          id: "client-route",
          targetKind: "edge",
          targetId: edge.id,
          confidence: "inferred",
          source: "config",
          path: "infra/routes.yaml",
          claim: "routing configuration connects these services",
        },
      ],
    });
    expect(attached.isError).toBeFalsy();
    expect(attached.content.revision).toBe(1);

    const stale = await call("studio_attach_code_evidence", {
      candidateId: baseline.id,
      expectedRevision: 0,
      evidence: [
        {
          id: "runtime-route",
          targetKind: "edge",
          targetId: edge.id,
          confidence: "observed",
          source: "runtime",
          claim: "a trace crossed this link",
        },
      ],
    });
    expect(stale.isError).toBe(true);
    expect(String(stale.content.error)).toContain("revision 1, not 0");
  });

  it("commits no partial patch when the final design is invalid", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const created = await call("studio_create_candidate", {
      label: "broken experiment",
      copyFrom: imported.content.candidateId,
    });
    const experiment = host.study.candidates.find(
      (candidate) => candidate.id === created.content.candidateId
    )!;
    const before = JSON.stringify(experiment.design);
    const target = experiment.design.nodes.find((node) => node.kind === "database")!;
    const result = await call("studio_apply_architecture_patch", {
      candidateId: experiment.id,
      expectedRevision: 0,
      operations: [{ op: "remove-node", nodeId: target.id }],
    });
    expect(result.isError).toBe(true);
    const after = host.study.candidates.find((candidate) => candidate.id === experiment.id)!;
    expect(after.revision).toBe(0);
    expect(JSON.stringify(after.design)).toBe(before);
  });

  it("returns a blocker until a person approves, then exposes the pinned implementation delta", async () => {
    const imported = await call("studio_import_architecture", repositoryArchitectureInput(true));
    const created = await call("studio_create_candidate", {
      label: "admission-control experiment",
      copyFrom: imported.content.candidateId,
    });
    const experiment = host.study.candidates.find(
      (candidate) => candidate.id === created.content.candidateId
    )!;
    const target = experiment.design.nodes[0]!;
    await call("studio_apply_architecture_patch", {
      candidateId: experiment.id,
      expectedRevision: 0,
      operations: [
        {
          op: "update-node",
          nodeId: target.id,
          patch: { label: `${target.label} with admission control` },
        },
      ],
    });

    const blocked = await call("studio_get_implementation_handoff", {});
    expect(blocked.content).toMatchObject({ status: "blocked", code: "approval-required" });

    const approvedCandidate = host.study.candidates.find(
      (candidate) => candidate.id === experiment.id
    )!;
    const actualEvaluation = evaluateCandidate(host.study, approvedCandidate);
    const key = evaluationKey({
      candidateHash: actualEvaluation.candidateHash,
      engineVersion: actualEvaluation.engineVersion,
      seeds: actualEvaluation.seeds,
      boundsHash: actualEvaluation.boundsHash,
    });
    host.study = StudySchema.parse({
      ...host.study,
      evaluations: { ...host.study.evaluations, [key]: actualEvaluation },
    });
    host.study = promoteCandidate(host.study, experiment.id, 500);
    const ready = await call("studio_get_implementation_handoff", {});
    expect(ready.isError).toBeFalsy();
    expect(ready.content.status).toBe("ready");
    expect((ready.content.approval as { candidateRevision: number }).candidateRevision).toBe(1);
    expect((ready.content.repository as { revision: string }).revision).toBe("abc123");
    expect((ready.content.sourcePaths as string[])).toEqual(["src/server.ts"]);
    expect(
      (ready.content.delta as { summary: { implementationChanges: number } }).summary
        .implementationChanges
    ).toBe(1);
    expect(String(ready.content.implementationPrompt)).toContain("Do not deploy");
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe("validating a draft", () => {
  it("accepts a shipped candidate's design", async () => {
    const design = host.study.candidates[6]!.design;
    const { content } = await call("studio_validate_draft", { design });
    expect(content.valid).toBe(true);
    expect(content.designHash).toBeTruthy();
  });

  it("reports dangerous inherited defaults before an agent tries to store them", async () => {
    const design = structuredClone(host.study.candidates[6]!.design) as {
      edges: Array<Record<string, unknown>>;
    };
    delete design.edges[0]!.latency;
    const { content } = await call("studio_validate_draft", { design });
    expect(content.valid).toBe(false);
    expect(content.errors).toContainEqual(
      expect.objectContaining({ layer: "agent-policy", code: "edge-latency-required" })
    );

    const implicitFanout = structuredClone(host.study.candidates[6]!.design) as {
      edges: Array<Record<string, unknown>>;
    };
    delete implicitFanout.edges[0]!.fanoutFactor;
    const checked = await call("studio_validate_draft", { design: implicitFanout });
    expect(checked.content.valid).toBe(false);
    expect(checked.content.errors).toContainEqual(
      expect.objectContaining({ layer: "agent-policy", code: "edge-fanout-required" })
    );
  });

  it("separates schema, topology and workflow errors, because the fixes differ", async () => {
    const design = structuredClone(host.study.candidates[6]!.design) as Record<string, unknown>;
    const wf = design.workflow as Record<string, unknown>;
    (wf.collections as Array<Record<string, unknown>>)[0]!.node = "lb";
    const { content } = await call("studio_validate_draft", { design });
    expect(content.valid).toBe(false);
    const errors = content.errors as Array<{ layer: string; code: string }>;
    expect(errors.some((e) => e.layer === "workflow" && e.code === "collection-node-kind")).toBe(true);
  });

  it("warns that a design with no workflow cannot make a correctness claim", async () => {
    const design = structuredClone(host.study.candidates[0]!.design) as Record<string, unknown>;
    design.workflow = null;
    const { content } = await call("studio_validate_draft", { design });
    expect(content.valid).toBe(true);
    const warnings = content.warnings as Array<{ message: string }>;
    expect(warnings.some((w) => w.message.includes("vacuous"))).toBe(true);
  });

  it("reports overlapping authored coordinates as a layout error", async () => {
    const design = structuredClone(host.study.candidates[6]!.design)
    design.nodes[1]!.x = design.nodes[0]!.x
    design.nodes[1]!.y = design.nodes[0]!.y

    const { content } = await call("studio_validate_draft", { design })
    expect(content.valid).toBe(false)
    const errors = content.errors as Array<{ layer: string; code: string }>
    expect(errors).toContainEqual(
      expect.objectContaining({ layer: "layout", code: "node-overlap" })
    )
  })

  it("does not store anything", async () => {
    const before = host.study.candidates.length;
    await call("studio_validate_draft", { design: host.study.candidates[0]!.design });
    expect(host.study.candidates.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// creating and replacing
// ---------------------------------------------------------------------------

describe("creating a candidate", () => {
  it("marks it agent-authored, and offers no way to say otherwise", async () => {
    const { content } = await call("studio_create_candidate", { label: "my idea" });
    expect(content.origin).toBe("agent");
    const created = host.study.candidates.find((c) => c.id === content.candidateId)!;
    expect(created.origin).toBe("agent");
    // The tool's own schema has no `origin` parameter, so an agent cannot pass off its work as a
    // human's even by trying.
    register();
    const schema = mc.registered.find((t) => t.name === "studio_create_candidate")!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).not.toContain("origin");
  });

  it("gives it an id that says where it came from", async () => {
    const { content } = await call("studio_create_candidate", { label: "my idea" });
    expect(content.candidateId).toMatch(/^agent-candidate-/);
  });

  it("copies the active candidate when no design is supplied", async () => {
    const active = host.study.candidates.find((c) => c.id === host.study.activeCandidateId)!;
    const { content } = await call("studio_create_candidate", { label: "a variation" });
    const created = host.study.candidates.find((c) => c.id === content.candidateId)!;
    expect(JSON.stringify(created.design)).toBe(JSON.stringify(active.design));
    // A copy, not an alias: editing one must not edit the other.
    expect(created.design).not.toBe(active.design);
    expect(created.role).toBe("experiment");
    expect(created.basedOnCandidateId).toBe(active.id);
  });

  it("starts at revision zero and never touches an existing candidate", async () => {
    const before = host.study.candidates.map((c) => `${c.id}@${c.revision}`);
    const { content } = await call("studio_create_candidate", { label: "isolated" });
    expect(content.revision).toBe(0);
    const after = host.study.candidates.filter((c) => c.id !== content.candidateId);
    expect(after.map((c) => `${c.id}@${c.revision}`)).toEqual(before);
  });

  it("refuses an invalid design rather than storing a broken candidate", async () => {
    const design = structuredClone(host.study.candidates[6]!.design) as Record<string, unknown>;
    (design.nodes as Array<Record<string, unknown>>).find((n) => n.id === "db")!.database = undefined;
    const { content, isError } = await call("studio_create_candidate", { label: "broken", design });
    expect(isError).toBe(true);
    expect(String(content.error)).toMatch(/error/i);
    expect(host.study.candidates.some((c) => c.label === "broken")).toBe(false);
  });

  it("says in its result that promotion is not available to it", async () => {
    const { content } = await call("studio_create_candidate", { label: "hopeful" });
    expect(String(content.note)).toContain("human-only");
  });
});

describe("replacing a draft", () => {
  it("requires the revision it believes it is replacing", async () => {
    const target = host.study.candidates[0]!;
    const { content } = await call("studio_replace_candidate_draft", {
      candidateId: target.id,
      expectedRevision: 0,
      design: host.study.candidates[6]!.design,
    });
    expect(content.revision).toBe(1);
  });

  it("refuses a stale revision, naming both numbers", async () => {
    const target = host.study.candidates[0]!;
    await call("studio_replace_candidate_draft", {
      candidateId: target.id,
      expectedRevision: 0,
      design: host.study.candidates[6]!.design,
    });
    const { content, isError } = await call("studio_replace_candidate_draft", {
      candidateId: target.id,
      expectedRevision: 0,
      design: host.study.candidates[5]!.design,
    });
    expect(isError).toBe(true);
    // Enough for the agent to re-read and retry rather than guess.
    expect(String(content.error)).toContain("revision 1, not 0");
    expect(String(content.error)).toContain("studio_get_candidate");
  });

  it("refuses to modify the promoted candidate at all", async () => {
    host.study = promoteCandidate(host.study, "c6-serializable-transaction");
    const { content, isError } = await call("studio_replace_candidate_draft", {
      candidateId: "c6-serializable-transaction",
      expectedRevision: 0,
      design: host.study.candidates[0]!.design,
    });
    expect(isError).toBe(true);
    expect(String(content.error)).toContain("promoted version");
    expect(String(content.error)).toContain("human-only");
    // And it really is untouched.
    const promoted = host.study.candidates.find((c) => c.id === "c6-serializable-transaction")!;
    expect(promoted.revision).toBe(0);
  });

  it("refuses when the design is missing entirely", async () => {
    const { content, isError } = await call("studio_replace_candidate_draft", {
      candidateId: host.study.candidates[0]!.id,
      expectedRevision: 0,
    });
    expect(isError).toBe(true);
    expect(String(content.error)).toContain("design is required");
  });
});

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

describe("running and reading an evaluation", () => {
  it("returns the verdict and the numbers, but not the trace", async () => {
    const { content } = await call("studio_run_evaluation", { candidateId: "c1-check-then-write" });
    const correctness = content.correctness as Record<string, unknown>;
    expect(correctness.status).toBe("VIOLATED");
    expect(correctness.counterexampleLength).toBe(1);
    // The trace is the largest part of an evaluation and is only wanted when something broke, so
    // it is a separate fetch -- and the result says so rather than leaving the agent to guess.
    expect(correctness.traceAvailableVia).toBe("studio_get_evaluation");
    expect(JSON.stringify(content)).not.toContain("two people, one pizza");
  });

  it("carries the bounds, seeds, hashes and assumptions with every result", async () => {
    const { content } = await call("studio_run_evaluation", { candidateId: "c1-check-then-write" });
    expect(content.candidateHash).toBe("hash");
    expect(content.engineVersion).toBe("test");
    expect(content.seeds).toEqual([1, 2]);
    const correctness = content.correctness as Record<string, unknown>;
    expect(correctness.bounds).toBeTruthy();
    expect(correctness.faults).toBeTruthy();
    expect(correctness.claim).toBeTruthy();
  });

  it("lets an agent ask for correctness without paying for performance", async () => {
    await call("studio_run_evaluation", { candidateId: "c6-serializable-transaction", performance: false });
    expect(host.runCalls.at(-1)).toEqual({
      candidateId: "c6-serializable-transaction",
      correctness: true,
      performance: false,
      scenarios: false,
    });
  });

  it("defaults performance off", async () => {
    await call("studio_run_evaluation", { candidateId: "c6-serializable-transaction" });
    expect(host.runCalls.at(-1)?.performance).toBe(false);
  });

  it("withholds repository load results until every target is calibrated", async () => {
    await call("studio_create_study", { name: "checkout", workload: OBSERVED_WORKLOAD });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const candidateId = imported.content.candidateId as string;

    const correctness = await call("studio_run_evaluation", { candidateId });
    expect(correctness.isError).toBeFalsy();
    expect(correctness.content.performance).toBeNull();
    expect(String(correctness.content.performanceWithheld)).toContain("uncalibrated");
    expect(host.runCalls.at(-1)).toMatchObject({ correctness: true, performance: false });

    const before = host.runCalls.length;
    const performance = await call("studio_run_evaluation", { candidateId, performance: true });
    expect(performance.isError).toBe(true);
    expect(String(performance.content.error)).toContain("Performance is uncalibrated");
    const scenarios = await call("studio_run_production_scenarios", { candidateId });
    expect(scenarios.isError).toBe(true);
    expect(host.runCalls).toHaveLength(before);

    const architecture = await call("studio_get_architecture", { candidateId });
    expect(architecture.content.performanceCalibration).toMatchObject({
      required: true,
      calibrated: false,
    });
  });

  it("allows repository performance after every target has observed measurements", async () => {
    await call("studio_create_study", { name: "checkout", workload: OBSERVED_WORKLOAD });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput(true));
    const result = await call("studio_run_evaluation", {
      candidateId: imported.content.candidateId,
      performance: true,
    });
    expect(result.isError).toBeFalsy();
    expect(host.runCalls.at(-1)?.performance).toBe(true);
  });

  it("runs the named production suite without rerunning the ordinary evaluation", async () => {
    const { content } = await call("studio_run_production_scenarios", {
      candidateId: "c6-serializable-transaction",
    });
    expect(host.runCalls.at(-1)).toEqual({
      candidateId: "c6-serializable-transaction",
      correctness: false,
      performance: false,
      scenarios: true,
    });
    expect(content.scenarios).toEqual([
      expect.objectContaining({ kind: "traffic-spike", status: "warning", targetNodeId: "api" }),
    ]);
  });

  it("returns the full trace from studio_get_evaluation", async () => {
    await call("studio_run_evaluation", { candidateId: "c1-check-then-write" });
    const { content } = await call("studio_get_evaluation", { candidateId: "c1-check-then-write" });
    const evaluation = content.evaluation as { correctness: { counterexample: { message: string } } };
    expect(evaluation.correctness.counterexample.message).toBe("two people, one pizza");
  });

  it("explains why there is no cached evaluation rather than returning a bare null", async () => {
    const { content } = await call("studio_get_evaluation", { candidateId: "c5-fenced-lease" });
    expect(content.evaluation).toBeNull();
    expect(String(content.reason)).toContain("studio_run_evaluation");
    expect(String(content.reason)).toContain("seeds and bounds");
  });
});

describe("cancellation", () => {
  it("honours an abort signal instead of running to completion", async () => {
    host.pending = null;
    const controller = new AbortController();
    register();
    // Arm the host to block, then abort while the call is in flight.
    host.pending = () => {};
    const inFlight = mc.call("studio_run_evaluation", { candidateId: "c1-check-then-write" }, {
      signal: controller.signal,
    }) as Promise<{ content: Record<string, unknown>; isError?: boolean }>;
    await Promise.resolve();
    controller.abort();
    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(String(result.content.error)).toContain("aborted");
  });

  it("refuses immediately when the signal is already aborted", async () => {
    host.pending = () => {};
    register();
    const controller = new AbortController();
    controller.abort();
    const result = (await mc.call("studio_run_evaluation", { candidateId: "c1-check-then-write" }, {
      signal: controller.signal,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

describe("comparing", () => {
  it("returns eligibility per candidate and a frontier among the eligible only", async () => {
    const { content } = await call("studio_compare_candidates", {});
    expect((content.decisions as unknown[]).length).toBe(7);
    expect(content.frontier).toEqual([]);
    expect(String(content.claim)).toContain("No candidate is eligible");
  });

  it("its description states the qualifier an agent must repeat", async () => {
    register();
    const tool = mc.registered.find((t) => t.name === "studio_compare_candidates")!;
    expect(tool.description).toContain("Pareto-optimal among the versions tested");
    expect(tool.description).toContain("not globally best");
    expect(tool.description).toContain("ties, not wins");
  });

  it("the run-evaluation description states what the verdicts do and do not mean", async () => {
    register();
    const tool = mc.registered.find((t) => t.name === "studio_run_evaluation")!;
    expect(tool.description).toContain("is not proof of safety");
    expect(tool.description).toContain("establishes nothing either way");
  });
});

// ---------------------------------------------------------------------------
// the activity log
// ---------------------------------------------------------------------------

describe("the activity log", () => {
  it("records every call, successful or not", async () => {
    await call("studio_get_study", {});
    await call("studio_create_candidate", { label: "logged" });
    await call("studio_get_candidate", { candidateId: "nope" });
    const tools = host.activity.map((a) => a.tool);
    expect(tools).toContain("studio_get_study");
    expect(tools).toContain("studio_create_candidate");
    expect(host.activity.some((a) => !a.ok)).toBe(true);
  });

  it("records the resulting candidate revision, so an edit is traceable", async () => {
    await call("studio_replace_candidate_draft", {
      candidateId: "c1-check-then-write",
      expectedRevision: 0,
      design: host.study.candidates[6]!.design,
    });
    const entry = host.activity.find((a) => a.tool === "studio_replace_candidate_draft")!;
    expect(entry.candidateId).toBe("c1-check-then-write");
    expect(entry.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the human-only side
// ---------------------------------------------------------------------------

describe("promotion and deletion are human-only", () => {
  it("promotion is reachable only through the mutation module, not through any tool", () => {
    const promoted = promoteCandidate(pizzaStudy(), "c7-atomic-decrement-unique-claim", 1234);
    expect(promoted.promotedCandidateId).toBe("c7-atomic-decrement-unique-claim");
    expect(promoted.approval).toEqual({
      candidateId: "c7-atomic-decrement-unique-claim",
      candidateRevision: 0,
      baselineCandidateId: null,
      baselineRevision: null,
      approvedAt: 1234,
    });
    const toolNames = buildTools(host).map((t) => t.name);
    expect(toolNames).not.toContain("studio_promote_candidate");
  });

  it("the promoted candidate cannot be deleted either", () => {
    const promoted = promoteCandidate(pizzaStudy(), "c7-atomic-decrement-unique-claim");
    expect(() => deleteCandidate(promoted, "c7-atomic-decrement-unique-claim")).toThrow(MutationRefused);
  });

  it("a human edit bumps the revision, so an agent's snapshot goes stale", () => {
    // If a human edit did not bump, an agent could overwrite it with a revision that looked
    // current and the human's change would vanish without trace.
    let study = pizzaStudy();
    const before = study.candidates[0]!.revision;
    const result = replaceCandidateDraft(study, {
      candidateId: study.candidates[0]!.id,
      expectedRevision: before,
      design: study.candidates[6]!.design,
      by: "human",
    });
    study = result.study;
    expect(study.candidates[0]!.revision).toBe(before + 1);
    expect(() =>
      replaceCandidateDraft(study, {
        candidateId: study.candidates[0]!.id,
        expectedRevision: before,
        design: study.candidates[5]!.design,
        by: "agent",
      })
    ).toThrow(/revision 1, not 0/);
  });

  it("a human may edit the promoted candidate; an agent may not", () => {
    const study = promoteCandidate(pizzaStudy(), "c1-check-then-write");
    const humanEdit = replaceCandidateDraft(study, {
      candidateId: "c1-check-then-write",
      expectedRevision: 0,
      design: study.candidates[6]!.design,
      by: "human",
    });
    expect(humanEdit.study.promotedCandidateId).toBeNull();
    expect(humanEdit.study.approval).toBeNull();
    expect(() =>
      replaceCandidateDraft(study, {
        candidateId: "c1-check-then-write",
        expectedRevision: 0,
        design: study.candidates[6]!.design,
        by: "agent",
      })
    ).toThrow(/promoted version/);
  });

  it("pins the as-is revision and withdraws approval when that baseline changes", () => {
    const sourceDesign = pizzaStudy().candidates[0]!.design;
    const grounded = repositoryArchitectureInput(false, sourceDesign);
    const imported = importRepositoryArchitecture(blankStudy({ id: "repo-study" }), {
      repository: {
        id: "repo-abc123",
        name: "checkout",
        rootHint: "services/checkout",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: ["src"],
        excludedScope: [],
        changedPaths: [],
        workingTreeFingerprint: "",
        capturedAt: 100,
      },
      label: "As-is",
      design: sourceDesign,
      evidence: grounded.evidence,
      sourceInventory: grounded.sourceInventory,
      origin: "human",
    });
    const experiment = createCandidate(imported.study, {
      label: "Proposed",
      copyFrom: imported.candidate.id,
      origin: "human",
    });
    const approved = promoteCandidate(experiment.study, experiment.candidate.id, 200);

    expect(approved.approval).toMatchObject({
      candidateId: experiment.candidate.id,
      candidateRevision: 0,
      baselineCandidateId: imported.candidate.id,
      baselineRevision: 0,
    });

    const baselineEdit = replaceCandidateDraft(approved, {
      candidateId: imported.candidate.id,
      expectedRevision: 0,
      design: imported.candidate.design,
      by: "human",
    });
    expect(baselineEdit.study.promotedCandidateId).toBeNull();
    expect(baselineEdit.study.approval).toBeNull();
  });

  it("does not let an agent change either side of an approved comparison", () => {
    const sourceDesign = pizzaStudy().candidates[0]!.design;
    const grounded = repositoryArchitectureInput(false, sourceDesign);
    const imported = importRepositoryArchitecture(blankStudy({ id: "repo-study" }), {
      repository: {
        id: "repo-abc123",
        name: "checkout",
        rootHint: "services/checkout",
        branch: "main",
        revision: "abc123",
        dirty: false,
        scope: ["src"],
        excludedScope: [],
        changedPaths: [],
        workingTreeFingerprint: "",
        capturedAt: 100,
      },
      label: "As-is",
      design: sourceDesign,
      evidence: grounded.evidence,
      sourceInventory: grounded.sourceInventory,
      origin: "human",
    });
    const experiment = createCandidate(imported.study, {
      label: "Proposed",
      copyFrom: imported.candidate.id,
      origin: "human",
    });
    const approved = promoteCandidate(experiment.study, experiment.candidate.id);

    expect(() =>
      attachArchitectureEvidence(approved, {
        candidateId: imported.candidate.id,
        expectedRevision: imported.candidate.revision,
        evidence: [],
        by: "agent",
      })
    ).toThrow(/human-approved comparison/);
    expect(() =>
      importRepositoryArchitecture(approved, {
        repository: { ...activeRepositorySnapshot(approved)!, id: "repo-def456", revision: "def456", capturedAt: 300 },
        label: "New as-is",
        design: imported.candidate.design,
        origin: "agent",
      })
    ).toThrow(/human-approved design/);
  });

  it("a study round-trips after agent edits, so nothing an agent does corrupts the document", async () => {
    await call("studio_create_candidate", { label: "agent one" });
    await call("studio_create_candidate", { label: "agent two" });
    const json = JSON.stringify(host.study);
    expect(() => StudySchema.parse(JSON.parse(json))).not.toThrow();
    expect(host.study.candidates.filter((c) => c.origin === "agent").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// an agent bringing its own problem
// ---------------------------------------------------------------------------

describe("an agent can define the study, not just answer it", () => {
  let host: TestHost;
  let mc: MockModelContext;

  beforeEach(() => {
    // Starts from an EMPTY study, which is what the product actually boots into. A test that
    // started from the pizza example would never exercise the path a real user takes.
    host = new TestHost(blankStudy({ id: "study-empty" }));
    mc = new MockModelContext();
  });

  const call = (name: string, input: unknown = {}): Promise<ToolResult> => {
    if (mc.registered.length === 0) registerWebmcpTools({ host, target: { modelContext: mc } });
    return mc.call(name, input) as Promise<ToolResult>;
  };

  it("creates a study for a problem of its own", async () => {
    const r = await call("studio_create_study", {
      name: "one seat, many buyers",
      problem: "Sell each concert seat exactly once during an on-sale rush.",
    });
    expect(r.isError).toBeFalsy();
    expect(host.study.name).toBe("one seat, many buyers");
    // Born with one empty version to draw on, so the canvas opens on this call.
    expect(host.study.candidates).toHaveLength(1);
    expect(r.content).toMatchObject({ candidateId: host.study.candidates[0]!.id, revision: 0, workloadIsPlaceholder: true });
    expect(String((r.content as { next: string }).next)).toContain("studio_get_catalog");
  });

  it("sets the yardstick, and the study reports it back", async () => {
    await call("studio_create_study", { name: "seats", problem: "sell each seat once" });
    const r = await call("studio_update_study", {
      contract: {
        workload: { durationSec: 300, seeds: [1, 2, 3] },
        correctness: {
          invariants: [
            {
              id: "no-double-sell",
              label: "a seat is never sold twice",
              scope: "safety",
              expr: {
                kind: "compare",
                op: "<=",
                left: { kind: "count", collection: "sales" },
                right: { kind: "lit", value: 1 },
              },
              message: "Two people hold the same seat.",
            },
          ],
        },
      },
    });
    expect(r.isError).toBeFalsy();
    expect(host.study.workload.durationSec).toBe(300);
    expect(host.study.correctness.invariants).toHaveLength(1);
  });

  it("gets the validator's own message back on a malformed contract", async () => {
    await call("studio_create_study", { name: "seats" });
    const r = await call("studio_update_study", { contract: { workload: { durationSec: -5 } } });
    expect(r.isError).toBe(true);
    // Specific enough to correct in one more call, rather than "invalid input".
    expect(JSON.stringify(r.content)).toMatch(/durationSec/);
  });

  it("CANNOT move the yardstick once a result exists", async () => {
    await call("studio_create_study", { name: "seats" });
    host.study = { ...host.study, evaluations: { "some-key": {} as never } };
    const r = await call("studio_update_study", {
      contract: { correctness: { invariants: [] } },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/locked/);
  });

  it("CANNOT weaken an invariant after a candidate is promoted", async () => {
    await call("studio_create_study", { name: "seats" });
    host.study = { ...host.study, promotedCandidateId: "c1" };
    const r = await call("studio_update_study", {
      contract: { targets: { slo: { p99Ms: 500 } } },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/promoted/);
  });

  it("can still fix the prose after the contract is frozen", async () => {
    await call("studio_create_study", { name: "seats" });
    host.study = { ...host.study, promotedCandidateId: "c1" };
    const r = await call("studio_update_study", { problem: "clearer wording of the same problem" });
    expect(r.isError).toBeFalsy();
    expect(host.study.problem).toBe("clearer wording of the same problem");
  });

  it("lists and opens saved projects", async () => {
    const listed = await call("studio_list_studies");
    const content = listed.content as { saved: Array<{ id: string; name: string }> };
    expect(content.saved).toHaveLength(1);

    const opened = await call("studio_open_study", { studyId: content.saved[0]!.id });
    expect(opened.isError).toBeFalsy();
    expect(host.study.name).toBe(content.saved[0]!.name);
  });

  it("refuses the removed example input", async () => {
    const r = await call("studio_open_study", { exampleId: "limited-free-pizza" });
    expect(r.isError).toBe(true);
  });

  it("refuses an open that names neither", async () => {
    const r = await call("studio_open_study", {});
    expect(r.isError).toBe(true);
  });

  it("still has no tool to promote or delete, now that it can create projects too", async () => {
    if (mc.registered.length === 0) registerWebmcpTools({ host, target: { modelContext: mc } });
    const names = mc.registered.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/delete|remove|promote|approve|ship|deploy/i);
  });

  // ---- the start flow: canvas open on the first call, one version, no placeholder locked in ----

  it("opens the canvas on studio_create_study and leaves exactly one empty version", async () => {
    const r = await call("studio_create_study", { name: "seats" });
    const content = r.content as { candidateId: string; revision: number; next: string };
    expect(host.study.candidates).toHaveLength(1);
    expect(host.study.candidates[0]).toMatchObject({ id: content.candidateId, origin: "agent", role: "experiment", revision: 0 });
    expect(host.study.activeCandidateId).toBe(content.candidateId);
    expect(host.activity.at(-1)).toMatchObject({ tool: "studio_create_study", candidateId: content.candidateId, revision: 0 });
  });

  it("studio_create_candidate right after adopts the blank drawing instead of adding a second one", async () => {
    const created = await call("studio_create_study", { name: "seats" });
    const first = (created.content as { candidateId: string }).candidateId;
    const again = await call("studio_create_candidate", { label: "as-is · api", intent: "the http service" });
    expect(again.isError).toBeFalsy();
    expect((again.content as { candidateId: string }).candidateId).toBe(first);
    expect(host.study.candidates).toHaveLength(1);
    expect(host.study.candidates[0]).toMatchObject({ id: first, label: "as-is · api", intent: "the http service", revision: 0 });
  });

  it("does not adopt a drawing somebody has already touched", async () => {
    await call("studio_create_study", { name: "seats" });
    const id = host.study.candidates[0]!.id;
    await call("studio_apply_architecture_patch", {
      candidateId: id,
      expectedRevision: 0,
      operations: [{ op: "set-design-name", name: "touched" }],
    });
    await call("studio_create_candidate", { label: "another" });
    expect(host.study.candidates).toHaveLength(2);
  });

  it("studio_import_architecture with a complete design seals the blank drawing in place", async () => {
    const created = await call("studio_create_study", { name: "checkout" });
    const first = (created.content as { candidateId: string }).candidateId;
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    expect(imported.isError).toBeFalsy();
    expect((imported.content as { candidateId: string }).candidateId).toBe(first);
    expect(host.study.candidates).toHaveLength(1);
    expect(host.study.candidates[0]!.role).toBe("baseline");
  });

  it("refuses to run while the workload is the placeholder, and the yardstick stays unlocked", async () => {
    await call("studio_create_study", { name: "checkout" });
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const candidateId = (imported.content as { candidateId: string }).candidateId;
    expect(isPlaceholderWorkload(host.study.workload)).toBe(true);

    const refused = await call("studio_run_evaluation", { candidateId, correctness: true, performance: false });
    expect(refused.isError).toBe(true);
    expect(String((refused.content as { error: string }).error)).toMatch(/placeholder/);
    expect(String((refused.content as { error: string }).error)).toMatch(/every version/);
    expect(host.runCalls).toHaveLength(0);
    const scenarios = await call("studio_run_production_scenarios", { candidateId });
    expect(scenarios.isError).toBe(true);
    expect(host.runCalls).toHaveLength(0);
    expect(studyContractLock(host.study).locked).toBe(false);

    const set = await call("studio_update_study", { contract: { workload: { arrival: { kind: "poisson", ratePerSec: 300 } } } });
    expect(set.isError).toBeFalsy();
    const ran = await call("studio_run_evaluation", { candidateId, correctness: true, performance: false });
    expect(ran.isError).toBeFalsy();
    expect(host.runCalls).toHaveLength(1);
  });

  it("a project born with its workload is not the placeholder and runs at once", async () => {
    const r = await call("studio_create_study", {
      name: "checkout",
      workload: { arrival: { kind: "deterministic", ratePerSec: 12 }, durationSec: 600 },
    });
    expect(r.isError).toBeFalsy();
    expect((r.content as { workloadIsPlaceholder: boolean }).workloadIsPlaceholder).toBe(false);
    expect(isPlaceholderWorkload(host.study.workload)).toBe(false);
    expect(host.study.workload.durationSec).toBe(600);
    const imported = await call("studio_import_architecture", repositoryArchitectureInput());
    const ran = await call("studio_run_evaluation", { candidateId: (imported.content as { candidateId: string }).candidateId });
    expect(ran.isError).toBeFalsy();
  });

  it("names the version/project distinction when the yardstick is locked", async () => {
    await call("studio_create_study", { name: "seats" });
    host.study = { ...host.study, evaluations: { "some-key": {} as never } };
    const r = await call("studio_update_study", { contract: { workload: { arrival: { kind: "poisson", ratePerSec: 9 } } } });
    expect(String((r.content as { error: string }).error)).toMatch(/new version\s+cannot change it/);
  });

  // ---- invariants without trial and error ----

  it("the catalogue exposes the invariant templates and the Invariant shape", async () => {
    const r = await call("studio_get_catalog");
    const catalog = r.content as {
      invariantTemplates: Array<{ id: string; params: Array<{ name: string }> }>;
      invariantShape: { exprKinds: string[]; scopes: string[]; example: unknown };
    };
    expect(catalog.invariantTemplates.map((t) => t.id)).toContain("counter-non-negative");
    expect(catalog.invariantTemplates.find((t) => t.id === "one-per-key")!.params.map((p) => p.name)).toEqual(["table", "field"]);
    expect(catalog.invariantShape.exprKinds).toContain("compare");
    expect(catalog.invariantShape.scopes).toEqual(["safety", "postcondition"]);
  });

  it("accepts template invariants and builds the same expression the interface would", async () => {
    await call("studio_create_study", { name: "seats" });
    const r = await call("studio_update_study", {
      contract: {
        correctness: {
          invariants: [
            { template: "counter-non-negative", args: { collection: "stock" } },
            { template: "one-per-key", args: { table: "claims", field: "userId" }, id: "one-claim", scope: "safety" },
          ],
        },
      },
    });
    expect(r.isError).toBeFalsy();
    const [first, second] = host.study.correctness.invariants;
    expect(first!.expr).toEqual({ kind: "compare", op: ">=", left: { kind: "counter", collection: "stock" }, right: { kind: "lit", value: 0 } });
    expect(first!.scope).toBe("safety");
    expect(first!.message.length).toBeGreaterThan(0);
    expect(second!.id).toBe("one-claim");
    expect(second!.expr).toMatchObject({ kind: "compare", op: "==" });
  });

  it("names the template's args when one is missing, and the templates when the id is unknown", async () => {
    await call("studio_create_study", { name: "seats" });
    const missing = await call("studio_update_study", {
      contract: { correctness: { invariants: [{ template: "counter-at-most", args: { collection: "stock" } }] } },
    });
    expect(missing.isError).toBe(true);
    expect(String((missing.content as { error: string }).error)).toMatch(/max \(number\)/);
    const unknown = await call("studio_update_study", {
      contract: { correctness: { invariants: [{ template: "no-such-rule", args: {} }] } },
    });
    expect(String((unknown.content as { error: string }).error)).toMatch(/counter-non-negative/);
  });

  it("adds a repair hint when a hand-written invariant does not fit the schema", async () => {
    await call("studio_create_study", { name: "seats" });
    const r = await call("studio_update_study", {
      contract: {
        correctness: {
          invariants: [{ id: "x", label: "x", postcondition: true, expr: { kind: "compare" }, message: "m" }],
        },
      },
    });
    expect(r.isError).toBe(true);
    const error = String((r.content as { error: string }).error);
    expect(error).toMatch(/invariantTemplates/);
    expect(error).toMatch(/"postcondition" is a scope value, not a field/);
  });
});

// ---------------------------------------------------------------------------
// pointing at things: annotate and focus
// ---------------------------------------------------------------------------

describe("studio_annotate and studio_focus", () => {
  const activeNode = () => host.study.candidates.find((c) => c.id === host.study.activeCandidateId)!.design.nodes[0]!.id;

  it("pins a note to a node of the active candidate and logs it", async () => {
    const r = await call("studio_annotate", { targetKind: "node", targetId: activeNode(), text: "the race happens here", tone: "bad" });
    expect(r.isError).toBeFalsy();
    expect(host.notes).toHaveLength(1);
    expect(host.notes[0]).toMatchObject({
      candidateId: host.study.activeCandidateId,
      targetKind: "node",
      targetId: activeNode(),
      tone: "bad",
    });
    expect(host.activity.at(-1)?.tool).toBe("studio_annotate");
  });

  it("refuses a note on a node that does not exist, so a typo cannot pin to nothing", async () => {
    const r = await call("studio_annotate", { targetKind: "node", targetId: "nope", text: "?" });
    expect(r.isError).toBe(true);
    expect(host.notes).toHaveLength(0);
  });

  it("notes never touch the study document", async () => {
    const before = JSON.stringify(host.study);
    await call("studio_annotate", { targetKind: "candidate", targetId: host.study.activeCandidateId, text: "a thought" });
    expect(JSON.stringify(host.study)).toBe(before);
  });

  it("focuses a node and requires an id for it", async () => {
    const ok = await call("studio_focus", { kind: "node", id: activeNode() });
    expect(ok.isError).toBeFalsy();
    expect(host.focused).toEqual([{ candidateId: host.study.activeCandidateId, target: { kind: "node", id: activeNode() } }]);

    const missing = await call("studio_focus", { kind: "node" });
    expect(missing.isError).toBe(true);
  });

  it("refuses to focus a step before a counterexample exists, and past its end after", async () => {
    const early = await call("studio_focus", { kind: "step", index: 0 });
    expect(early.isError).toBe(true);
    expect((early.content as { error: string }).error).toMatch(/no counterexample/);

    await call("studio_run_evaluation", { candidateId: host.study.activeCandidateId, correctness: true, performance: false });
    const ok = await call("studio_focus", { kind: "step", index: 0 });
    expect(ok.isError).toBeFalsy();
    expect(host.focused.at(-1)).toEqual({ candidateId: host.study.activeCandidateId, target: { kind: "step", index: 0 } });

    const far = await call("studio_focus", { kind: "step", index: 999 });
    expect(far.isError).toBe(true);
  });
});

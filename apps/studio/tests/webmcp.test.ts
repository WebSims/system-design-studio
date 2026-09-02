import { describe, expect, it, beforeEach } from "vitest";
import { pizzaStudy, STUDY_EXAMPLES } from "@sds/models";
import {
  StudySchema,
  applyStudyContract,
  blankStudy,
  type CandidateEvaluation,
  type PortfolioResult,
  type Study,
  type StudyContractPatch,
} from "@sds/schema";
import { registerWebmcpTools, type RegistrationState } from "../src/webmcp/register";
import { buildTools, type ActivityEntry, type ToolHost, type ToolResult } from "../src/webmcp/tools";
import { buildCatalog } from "../src/webmcp/catalog";
import { toJsonSchema, UnsupportedSchema } from "../src/webmcp/json-schema";
import {
  MutationRefused,
  createCandidate,
  deleteCandidate,
  promoteCandidate,
  replaceCandidateDraft,
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
  runCalls: Array<{ candidateId: string; correctness: boolean; performance: boolean }> = [];
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

  async createStudy(input: { name?: string; problem?: string }) {
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
      examples: STUDY_EXAMPLES.map((e) => ({ id: e.id, label: e.label, summary: e.summary, teaches: e.teaches })),
    };
  }

  async openStudy(input: { studyId?: string; exampleId?: string }) {
    if (input.exampleId) {
      const found = STUDY_EXAMPLES.find((e) => e.id === input.exampleId);
      if (!found) throw new Error(`there is no example "${input.exampleId}".`);
      this.study = found.build();
    }
    return this.study;
  }

  async createCandidate(input: { label: string; intent: string; design: unknown; copyFrom?: string }) {
    const { study, candidate } = createCandidate(this.study, {
      label: input.label,
      intent: input.intent,
      ...(input.design !== undefined ? { design: input.design } : {}),
      ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}),
      origin: "agent",
    });
    this.study = study;
    return candidate;
  }

  async replaceCandidateDraft(input: { candidateId: string; expectedRevision: number; design: unknown }) {
    const { study, candidate } = replaceCandidateDraft(this.study, { ...input, by: "agent" });
    this.study = study;
    return candidate;
  }

  async runEvaluation(input: {
    candidateId: string;
    correctness: boolean;
    performance: boolean;
    signal?: AbortSignal;
  }) {
    this.runCalls.push({
      candidateId: input.candidateId,
      correctness: input.correctness,
      performance: input.performance,
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

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers exactly the thirteen tools, imperatively, on the target given", () => {
    const { state } = register();
    expect(state.status).toBe("registered");
    expect(mc.registered.map((t) => t.name)).toEqual([
      "studio_create_study",
      "studio_update_study",
      "studio_list_studies",
      "studio_open_study",
      "studio_get_study",
      "studio_get_catalog",
      "studio_get_candidate",
      "studio_validate_draft",
      "studio_create_candidate",
      "studio_replace_candidate_draft",
      "studio_run_evaluation",
      "studio_get_evaluation",
      "studio_compare_candidates",
    ]);
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
      "studio_get_catalog",
      "studio_get_candidate",
      "studio_validate_draft",
      "studio_run_evaluation",
      "studio_get_evaluation",
      "studio_compare_candidates",
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
      "studio_get_study",
      "studio_get_candidate",
      "studio_get_evaluation",
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
    expect(r.tools.length).toBe(13);
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
    expect(String(content.error)).toContain("promoted candidate");
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
    });
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
    expect(tool.description).toContain("Pareto-optimal among the candidates tested");
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
    const promoted = promoteCandidate(pizzaStudy(), "c7-atomic-decrement-unique-claim");
    expect(promoted.promotedCandidateId).toBe("c7-atomic-decrement-unique-claim");
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
    expect(() =>
      replaceCandidateDraft(study, {
        candidateId: "c1-check-then-write",
        expectedRevision: 0,
        design: study.candidates[6]!.design,
        by: "human",
      })
    ).not.toThrow();
    expect(() =>
      replaceCandidateDraft(study, {
        candidateId: "c1-check-then-write",
        expectedRevision: 0,
        design: study.candidates[6]!.design,
        by: "agent",
      })
    ).toThrow(/promoted candidate/);
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
    expect(host.study.candidates).toEqual([]);
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

  it("lists the examples with a reason to open each, and opens one", async () => {
    const listed = await call("studio_list_studies");
    const content = listed.content as { examples: Array<{ id: string; teaches: string }> };
    expect(content.examples.length).toBeGreaterThan(0);
    expect(content.examples[0]!.teaches.length).toBeGreaterThan(20);

    const opened = await call("studio_open_study", { exampleId: content.examples[0]!.id });
    expect(opened.isError).toBeFalsy();
    expect(host.study.candidates.length).toBeGreaterThan(1);
  });

  it("refuses an open that names both a study and an example", async () => {
    const r = await call("studio_open_study", { studyId: "a", exampleId: "b" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/exactly one/);
  });

  it("refuses an open that names neither", async () => {
    const r = await call("studio_open_study", {});
    expect(r.isError).toBe(true);
  });

  it("still has no tool to promote or delete, now that it can create studies too", async () => {
    if (mc.registered.length === 0) registerWebmcpTools({ host, target: { modelContext: mc } });
    const names = mc.registered.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/delete|remove|promote|approve|ship|deploy/i);
  });
});

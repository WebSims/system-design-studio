import { useEffect, useState } from "react";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { Inspector } from "./panels/Inspector";
import { ResultsRail } from "./panels/ResultsRail";
import { BehaviourRail } from "./panels/BehaviourRail";
import { RaceDock } from "./panels/RaceDock";
import { AgentPanel } from "./panels/AgentPanel";
import { Topbar } from "./chrome/Topbar";
import { StartScreen } from "./chrome/StartScreen";
import { restoreStudy, useStudyStore } from "./study/store";
import { PerformanceView } from "./views/PerformanceView";
import { CompareView } from "./views/CompareView";
import { CandidateBar } from "./panels/CandidateBar";
import { registerWebmcpTools } from "./webmcp/register";
import { buildCatalog } from "./webmcp/catalog";
import type { ToolHost } from "./webmcp/tools";
import { cancelWorker, portfolioInWorker } from "./engine/client";
import { useRaceModel } from "./raceModel";
import { changedPaths, touchedByOperations, type ElementRef } from "./agentAttention";
import type { Candidate, Design } from "@sds/schema";

/**
 * After an agent mutation, do what a person's hand would have done: look at the candidate it
 * touched, mark what changed, and bring it into view with the worked-on element selected.
 *
 * The switch to the candidate is the same rule `studio_focus` applies: work the person cannot see
 * is work that did not happen, as far as they can tell.
 */
const revealAgentWork = (input: {
  candidateId: string;
  scope: "element" | "design";
  nodeIds: string[];
  edgeIds: string[];
  primary: ElementRef | null;
  changedPaths: string[];
}) => {
  const store = useStudyStore.getState();
  if (input.candidateId !== store.study.activeCandidateId) store.selectCandidate(input.candidateId);
  store.setAgentAttention({
    candidateId: input.candidateId,
    scope: input.scope,
    nodeIds: input.nodeIds,
    edgeIds: input.edgeIds,
    primary: input.primary,
    changedPaths: input.changedPaths,
  });
  store.requestFocus({ kind: "reveal", nodeIds: input.nodeIds, edgeIds: input.edgeIds, select: input.primary });
};

/** A whole candidate arrived or was replaced: show all of it, nothing selected. */
const revealWholeCandidate = (candidate: Candidate) =>
  revealAgentWork({
    candidateId: candidate.id,
    scope: "design",
    nodeIds: [],
    edgeIds: [],
    primary: null,
    changedPaths: [],
  });

const elementIn = (design: Design | undefined, ref: ElementRef | null): unknown => {
  if (!design || !ref) return undefined;
  return ref.kind === "node" ? design.nodes.find((n) => n.id === ref.id) : design.edges.find((e) => e.id === ref.id);
};

const designOf = (candidateId: string): Design | undefined =>
  useStudyStore.getState().study.candidates.find((c) => c.id === candidateId)?.design;

/**
 * The bottom dock: the lens's results, in the DevTools position.
 *
 * Behaviour: the counterexample timeline, synced with the sprites above it. Load: the measured
 * results, production scenarios and business outcomes. Collapsible, because the canvas is the point.
 */
function BottomDock() {
  const lens = useStudyStore((s) => s.lens);
  const plan = useRaceModel((s) => s.plan);
  const [collapsed, setCollapsed] = useState(false);
  const [autoOpened, setAutoOpened] = useState<string | null>(null);

  // A freshly found race opens the dock even if the person had closed it: the result is the point.
  const planKey = plan ? `${plan.steps.length}:${plan.violatingNodeId ?? ""}` : null;
  useEffect(() => {
    if (planKey && planKey !== autoOpened) {
      setCollapsed(false);
      setAutoOpened(planKey);
    }
  }, [autoOpened, planKey]);

  return (
    <section className={`dock ${collapsed ? "collapsed" : ""}`} aria-label={lens === "behaviour" ? "how it breaks" : "measured under load"}>
      <header className="dock-head">
        <h2>{lens === "behaviour" ? "how it breaks" : "measured under load"}</h2>
        <span className="muted dock-hint">
          {lens === "behaviour"
            ? "one column per request, one row per step; click a row to jump there"
            : "production scenarios, replicated measurement and business outcomes for the active version"}
        </span>
        <button className="btn small" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {collapsed ? "show" : "hide"}
        </button>
      </header>
      {!collapsed && <div className="dock-content">{lens === "behaviour" ? <RaceDock /> : <PerformanceView />}</div>}
    </section>
  );
}

function ReviewDrawer() {
  const setReviewOpen = useStudyStore((s) => s.setReviewOpen);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setReviewOpen]);
  return (
    <>
      <div className="drawer-backdrop" onClick={() => setReviewOpen(false)} />
      <aside className="review-drawer" aria-label="review and hand off">
        <header className="drawer-head">
          <div>
            <h2>review &amp; hand off</h2>
            <p className="muted">Which versions pass the rules, how they trade off, and the one change a person approved.</p>
          </div>
          <button className="btn small" onClick={() => setReviewOpen(false)} aria-label="close review">
            close
          </button>
        </header>
        <CompareView />
      </aside>
    </>
  );
}

function Workbench() {
  const hasCandidates = useStudyStore((s) => s.study.candidates.length > 0);
  const homeOpen = useStudyStore((s) => s.homeOpen);
  const lens = useStudyStore((s) => s.lens);
  if (homeOpen || !hasCandidates) return <StartScreen />;
  return (
    <>
      {lens === "behaviour" ? <BehaviourRail /> : <ResultsRail />}
      <FlowCanvas />
      <Inspector />
      <BottomDock />
    </>
  );
}

/**
 * Register the agent tool surface once, against the live store.
 *
 * The host is an adapter over commands the manual UI already issues -- there is no capability here
 * that a person does not have, and there are two the agent does not: promotion and deletion have no
 * tool at all.
 */
function useWebmcp() {
  const setWebmcp = useStudyStore((s) => s.setWebmcp);

  useEffect(() => {
    const host: ToolHost = {
      getStudy: () => useStudyStore.getState().study,
      getCatalog: () => buildCatalog(),
      createStudy: async (input) => {
        const store = useStudyStore.getState();
        const study = store.createStudy(input);
        // The agent's first call opens the panel that narrates the rest, same rule `annotate` uses:
        // work the person cannot see is work that did not happen, as far as they can tell.
        if (!store.agentOpen) store.setAgentOpen(true);
        return study;
      },
      updateStudyContract: async (patch) => {
        const { name, problem, ...contract } = patch as typeof patch & { name?: string; problem?: string };
        const store = useStudyStore.getState();
        // Prose and contract go through different doors on purpose: the prose is always writable,
        // the executable half throws once results exist. Applying the contract FIRST means a
        // refusal cannot leave the name changed and the yardstick not.
        if (Object.keys(contract).length > 0) {
          const before = store.study;
          store.updateContract(contract);
          const err = useStudyStore.getState().error;
          if (err) throw new Error(err);
          // The yardstick lives in the left rail, not on the canvas: name the sections that moved
          // so they can flash, and leave the camera alone.
          useStudyStore.getState().setAgentAttention({
            candidateId: null,
            scope: "study",
            nodeIds: [],
            edgeIds: [],
            primary: null,
            changedPaths: Object.keys(contract).flatMap((key) =>
              changedPaths(before[key as keyof typeof before], useStudyStore.getState().study[key as keyof typeof before]).map(
                (path) => (path === "new" ? key : `${key}.${path}`)
              )
            ),
          });
        }
        if (name !== undefined || problem !== undefined) {
          useStudyStore.getState().updateStudy((study) => ({
            ...study,
            ...(name !== undefined ? { name } : {}),
            ...(problem !== undefined ? { problem } : {}),
          }));
        }
        return useStudyStore.getState().study;
      },
      listStudies: async () => ({
        saved: (await useStudyStore.getState().storedStudies()).map((s) => ({
          id: s.id,
          name: s.name,
          candidates: s.candidateCount,
          updatedAt: s.updatedAt,
        })),
      }),
      openStudy: async (input) => {
        const store = useStudyStore.getState();
        await store.openStudy(input.studyId);
        const err = useStudyStore.getState().error;
        if (err) throw new Error(err);
        return useStudyStore.getState().study;
      },
      importArchitecture: async (input) => {
        const candidate = useStudyStore.getState().importArchitecture({ ...input, origin: "agent" });
        revealWholeCandidate(candidate);
        return candidate;
      },
      createCandidate: async (input) => {
        const candidate = useStudyStore.getState().addCandidate({
          label: input.label,
          intent: input.intent,
          ...(input.design !== undefined ? { design: input.design } : {}),
          ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}),
          // Set here, not accepted as a parameter. An agent cannot mark its own work as a human's.
          origin: "agent",
        });
        revealWholeCandidate(candidate);
        return candidate;
      },
      replaceCandidateDraft: async (input) => {
        const candidate = useStudyStore.getState().replaceDraft({ ...input, by: "agent" });
        revealWholeCandidate(candidate);
        return candidate;
      },
      applyArchitecturePatch: async (input) => {
        const before = designOf(input.candidateId);
        const result = useStudyStore.getState().patchArchitecture({ ...input, by: "agent" });
        if (before) {
          const touched = touchedByOperations(input.operations, before, result.candidate.design);
          revealAgentWork({
            candidateId: result.candidate.id,
            scope: touched.primary ? "element" : "design",
            // A reshaped drawing is shown whole; a local change is shown around itself.
            nodeIds: touched.wholeDesign ? [] : touched.nodeIds,
            edgeIds: touched.wholeDesign ? [] : touched.edgeIds,
            primary: touched.primary,
            changedPaths: changedPaths(
              elementIn(before, touched.primary),
              elementIn(result.candidate.design, touched.primary)
            ),
          });
        }
        return result;
      },
      attachArchitectureEvidence: async (input) => {
        const candidate = useStudyStore.getState().attachEvidence({ ...input, by: "agent" });
        const last = input.evidence[input.evidence.length - 1];
        const primary: ElementRef | null =
          last && (last.targetKind === "node" || last.targetKind === "edge")
            ? { kind: last.targetKind, id: last.targetId }
            : null;
        revealAgentWork({
          candidateId: candidate.id,
          scope: primary ? "element" : "design",
          nodeIds: input.evidence.filter((e) => e.targetKind === "node").map((e) => e.targetId),
          edgeIds: input.evidence.filter((e) => e.targetKind === "edge").map((e) => e.targetId),
          primary,
          changedPaths: ["evidence"],
        });
        return candidate;
      },
      upsertSourceInventory: async (input) =>
        useStudyStore.getState().upsertInventory({ ...input, by: "agent" }),
      upsertIssue: async (input) =>
        useStudyStore.getState().upsertIssue({ ...input, source: "agent", by: "agent" }),
      runEvaluation: async (input) => {
        if (input.signal?.aborted) throw new Error("evaluation aborted before it began");
        const abort = () => cancelWorker();
        input.signal?.addEventListener("abort", abort, { once: true });
        try {
          const evaluation = await useStudyStore.getState().evaluate(input.candidateId, {
            correctness: input.correctness,
            performance: input.performance,
            scenarios: input.scenarios,
          });
          if (!evaluation) {
            throw new Error(useStudyStore.getState().error ?? "evaluation failed");
          }
          return evaluation;
        } finally {
          input.signal?.removeEventListener("abort", abort);
        }
      },
      getEvaluation: (candidateId) => useStudyStore.getState().evaluationFor(candidateId),
      comparePortfolio: async (candidateIds) => {
        const study = useStudyStore.getState().study;
        const wanted = new Set(candidateIds);
        const missing = candidateIds.filter((id) => !study.candidates.some((candidate) => candidate.id === id));
        if (missing.length > 0) throw new Error(`unknown version (candidateId): ${missing.join(", ")}`);
        return portfolioInWorker(
          candidateIds.length === 0
            ? study
            : {
                ...study,
                candidates: study.candidates.filter((candidate) => wanted.has(candidate.id)),
              }
        );
      },
      annotate: (input) => {
        const store = useStudyStore.getState();
        const note = store.addAnnotation({ ...input, by: "agent" });
        // A note is worth nothing unseen. Open the panel the first time the agent speaks.
        if (!store.agentOpen) store.setAgentOpen(true);
        return note;
      },
      focus: (request) => {
        const store = useStudyStore.getState();
        if ("candidateId" in request && request.candidateId && request.candidateId !== store.study.activeCandidateId) {
          store.selectCandidate(request.candidateId);
        }
        store.requestFocus(request.target);
      },
      log: (entry) => useStudyStore.getState().logActivity(entry),
      busy: (_tool, inFlight) => useStudyStore.getState().setAgentBusy(inFlight ? 1 : -1),
    };

    const registration = registerWebmcpTools({ host });
    setWebmcp(
      registration.state.status === "registered" ? `${registration.state.tools.length} tools` : registration.state.status,
      registration.state.status === "registered"
        ? `registered: ${registration.state.tools.join(", ")}`
        : registration.state.reason
    );
    return () => registration.unregister();
  }, [setWebmcp]);
}

export function App() {
  const lens = useStudyStore((s) => s.lens);
  const uiDensity = useStudyStore((s) => s.uiDensity);
  const error = useStudyStore((s) => s.error);
  const hasCandidates = useStudyStore((s) => s.study.candidates.length > 0);
  const homeOpen = useStudyStore((s) => s.homeOpen);
  const reviewOpen = useStudyStore((s) => s.reviewOpen);
  const agentOpen = useStudyStore((s) => s.agentOpen);
  const showWorkbench = hasCandidates && !homeOpen;
  useWebmcp();

  useEffect(() => {
    void restoreStudy();
  }, []);

  return (
    <div className={`shell shell-${lens} density-${uiDensity} ${showWorkbench ? "" : "shell-empty"} ${agentOpen ? "agent-open" : ""}`}>
      <Topbar />
      {showWorkbench ? <CandidateBar /> : null}
      {error && <div className="banner banner-error">{error}</div>}
      <Workbench />
      {agentOpen && <AgentPanel />}
      {reviewOpen && showWorkbench && <ReviewDrawer />}
    </div>
  );
}

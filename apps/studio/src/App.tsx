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
  const lens = useStudyStore((s) => s.lens);
  if (!hasCandidates) return <StartScreen />;
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
      createStudy: async (input) => useStudyStore.getState().createStudy(input),
      updateStudyContract: async (patch) => {
        const { name, problem, ...contract } = patch as typeof patch & { name?: string; problem?: string };
        const store = useStudyStore.getState();
        // Prose and contract go through different doors on purpose: the prose is always writable,
        // the executable half throws once results exist. Applying the contract FIRST means a
        // refusal cannot leave the name changed and the yardstick not.
        if (Object.keys(contract).length > 0) {
          store.updateContract(contract);
          const err = useStudyStore.getState().error;
          if (err) throw new Error(err);
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
      importArchitecture: async (input) =>
        useStudyStore.getState().importArchitecture({ ...input, origin: "agent" }),
      createCandidate: async (input) =>
        useStudyStore.getState().addCandidate({
          label: input.label,
          intent: input.intent,
          ...(input.design !== undefined ? { design: input.design } : {}),
          ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}),
          // Set here, not accepted as a parameter. An agent cannot mark its own work as a human's.
          origin: "agent",
        }),
      replaceCandidateDraft: async (input) =>
        useStudyStore.getState().replaceDraft({ ...input, by: "agent" }),
      applyArchitecturePatch: async (input) =>
        useStudyStore.getState().patchArchitecture({ ...input, by: "agent" }),
      attachArchitectureEvidence: async (input) =>
        useStudyStore.getState().attachEvidence({ ...input, by: "agent" }),
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
        if (missing.length > 0) throw new Error(`unknown candidate: ${missing.join(", ")}`);
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
  const error = useStudyStore((s) => s.error);
  const hasCandidates = useStudyStore((s) => s.study.candidates.length > 0);
  const reviewOpen = useStudyStore((s) => s.reviewOpen);
  const agentOpen = useStudyStore((s) => s.agentOpen);
  useWebmcp();

  useEffect(() => {
    void restoreStudy();
  }, []);

  return (
    <div className={`shell shell-${lens} ${hasCandidates ? "" : "shell-empty"} ${agentOpen ? "agent-open" : ""}`}>
      <Topbar />
      {hasCandidates ? <CandidateBar /> : null}
      {error && <div className="banner banner-error">{error}</div>}
      <Workbench />
      {agentOpen && <AgentPanel />}
      {reviewOpen && hasCandidates && <ReviewDrawer />}
    </div>
  );
}

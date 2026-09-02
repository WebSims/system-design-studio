import { useCallback, useEffect, useRef, useState } from "react";
import { PRESETS, EXAMPLES, STUDY_EXAMPLES } from "@sds/models";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { Inspector } from "./panels/Inspector";
import { ResultsRail } from "./panels/ResultsRail";
import { nextNodeId } from "./ids";
import { useStudio } from "./store";
import { restoreStudy, useStudyStore, type ViewId } from "./study/store";
import { CorrectnessView } from "./views/CorrectnessView";
import { PerformanceView } from "./views/PerformanceView";
import { CompareView } from "./views/CompareView";
import { CandidateBar } from "./panels/CandidateBar";
import { ActivityLog } from "./panels/ActivityLog";
import { studyFilename } from "./persist";
import { registerWebmcpTools } from "./webmcp/register";
import { buildCatalog } from "./webmcp/catalog";
import type { ToolHost } from "./webmcp/tools";
import { cancelWorker, portfolioInWorker } from "./engine/client";

/**
 * The component palette.
 *
 * Every preset is assembled from the cited benchmark library, so dropping one in
 * starts you at a defensible number with visible provenance rather than at a
 * placeholder. The blurb says when the component is the wrong choice, which is the
 * more useful half.
 */
function Palette({ onClose }: { onClose: () => void }) {
  const edit = useStudio((s) => s.edit);
  const select = useStudio((s) => s.select);

  const add = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      edit((d) => {
        const id = nextNodeId(preset.kind, d.nodes.map((n) => n.id));
        const maxX = d.nodes.reduce((m, n) => Math.max(m, n.x), 0);
        d.nodes.push(preset.build(id, maxX + 300, 240));
        return;
      });
      // Select the new node so the inspector opens on it immediately.
      setTimeout(() => {
        const nodes = useStudio.getState().design.nodes;
        const last = nodes[nodes.length - 1];
        if (last) select({ kind: "node", id: last.id });
      }, 0);
      onClose();
    },
    [edit, select, onClose]
  );

  return (
    <div className="palette" onClick={(e) => e.stopPropagation()}>
      <div className="palette-title">add component</div>
      {PRESETS.map((p) => (
        <button key={p.id} className="palette-item" onClick={() => add(p.id)}>
          <span className={`palette-dot kind-${p.kind}`} />
          <span className="palette-body">
            <span className="palette-label">{p.label}</span>
            <span className="palette-blurb">{p.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ExampleMenu({ onClose }: { onClose: () => void }) {
  const load = useStudio((s) => s.loadDesign);
  return (
    <div className="palette" onClick={(e) => e.stopPropagation()}>
      <div className="palette-title">load example</div>
      {EXAMPLES.map((e) => (
        <button
          key={e.id}
          className="palette-item"
          onClick={() => {
            load(e.build());
            onClose();
          }}
        >
          <span className="palette-body">
            <span className="palette-label">{e.label}</span>
            <span className="palette-blurb">{e.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Saved studies and worked examples.
 *
 * Separated on purpose. A saved study is the user's own work and is what they came back for; an
 * example is a teaching aid, and each says what it teaches rather than what it contains, because
 * "seven architectures, four broken" is a reason to open something and "a pizza study" is not.
 */
function StudyMenu({ onClose }: { onClose: () => void }) {
  const openStudy = useStudyStore((s) => s.openStudy);
  const openExample = useStudyStore((s) => s.openExample);
  const storedStudies = useStudyStore((s) => s.storedStudies);
  const currentId = useStudyStore((s) => s.study.id);
  const [saved, setSaved] = useState<Array<{ id: string; name: string; candidateCount: number }> | null>(null);

  useEffect(() => {
    void storedStudies().then((list) =>
      setSaved(list.map((l) => ({ id: l.id, name: l.name, candidateCount: l.candidateCount })))
    );
  }, [storedStudies]);

  return (
    <div className="palette palette-wide" onClick={(e) => e.stopPropagation()}>
      <div className="palette-title">studies</div>
      {saved && saved.length > 0 && (
        <>
          <div className="palette-title">saved</div>
          {saved.map((st) => (
            <button
              key={st.id}
              className="palette-item"
              disabled={st.id === currentId}
              onClick={() => {
                void openStudy(st.id);
                onClose();
              }}
            >
              <span className="palette-body">
                <span className="palette-label">
                  {st.name}
                  {st.id === currentId && <span className="muted"> &middot; open</span>}
                </span>
                <span className="palette-blurb">
                  {st.candidateCount} candidate{st.candidateCount === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          ))}
        </>
      )}

      <div className="palette-title">worked examples</div>
      {STUDY_EXAMPLES.map((e) => (
        <button
          key={e.id}
          className="palette-item"
          onClick={() => {
            openExample(e.id);
            onClose();
          }}
        >
          <span className="palette-body">
            <span className="palette-label">{e.label}</span>
            <span className="palette-blurb">{e.teaches}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * What the studio shows before there is anything to show.
 *
 * The app opens empty, so this is the first screen and it has one job: say what to do next. Three
 * routes, in the order they are likely to be wanted -- describe the problem, hand it to an agent,
 * or read an example first. It is not a marketing panel; every line is an action or the reason to
 * take it.
 */
function EmptyStudy() {
  const webmcp = useStudyStore((s) => s.webmcp);
  const openExample = useStudyStore((s) => s.openExample);
  const example = STUDY_EXAMPLES[0];

  return (
    <div className="empty-study">
      <div className="empty-card">
        <div className="empty-kicker">Evidence-first system design</div>
        <h1>Start a system study</h1>
        <p className="empty-lede">
          Describe the real problem to Codex. It will draft options, test races and load, then
          bring the evidence back here.
        </p>

        <div className="starter-prompt">
          <span>Try this prompt</span>
          <p>
            Design three options for my system. Test races and bottlenecks, compare the
            trade-offs, and show the evidence.
          </p>
        </div>

        <div className="empty-actions">
          {example && (
            <button className="btn primary" onClick={() => openExample(example.id)}>
              Open demo
            </button>
          )}
        </div>

        <p className="muted empty-agent">
          {webmcp.status.includes("tools")
            ? "Codex is connected. You make the final choice."
            : "Open this page in Codex's browser to connect."}
        </p>
      </div>
    </div>
  );
}

const VIEWS: Array<{ id: ViewId; label: string; hint: string }> = [
  { id: "design", label: "Design", hint: "Draw the architecture and behavior" },
  { id: "correctness", label: "Correctness", hint: "Search for unsafe interleavings" },
  { id: "performance", label: "Performance", hint: "Measure load, latency, and outcomes" },
  { id: "compare", label: "Compare", hint: "Review gates and trade-offs" },
];

/**
 * The view switcher.
 *
 * Four views over ONE study document. Not four modes with their own state: a correctness verdict and
 * a latency figure that described slightly different documents would be the incoherence the whole
 * study format exists to prevent, and separate stores is how that happens.
 */
function ViewTabs() {
  const view = useStudyStore((s) => s.view);
  const setView = useStudyStore((s) => s.setView);
  return (
    <nav className="tabs">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={view === v.id ? "active" : ""}
          title={v.hint}
          onClick={() => setView(v.id)}
        >
          {v.label}
        </button>
      ))}
    </nav>
  );
}

function Topbar() {
  const design = useStudio((s) => s.design);
  const study = useStudyStore((s) => s.study);
  const exportStudyJson = useStudyStore((s) => s.exportStudyJson);
  const importStudyJson = useStudyStore((s) => s.importStudyJson);
  const persistence = useStudyStore((s) => s.persistence);
  const webmcp = useStudyStore((s) => s.webmcp);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<"palette" | "examples" | "studies" | "activity" | null>(null);

  const download = useCallback(() => {
    // A STUDY, not a design. The design alone would lose the invariants, the bounds and every
    // other candidate -- which is to say it would lose the argument and keep only one of its
    // conclusions.
    const blob = new Blob([exportStudyJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = studyFilename(study);
    a.click();
    URL.revokeObjectURL(url);
  }, [exportStudyJson, study]);

  return (
    <header className="topbar" onClick={() => setMenu(null)}>
      <div className="topbar-primary">
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <div>
            <div className="brand-name">
              System Design <b>Studio</b>
            </div>
            <div className="brand-sub">Model · test · compare</div>
          </div>
        </div>
        <ViewTabs />
        <div className="tb-spacer" />
        <div className="topbar-status">
          {study.candidates.length > 0 && (
            <span className="tb-meta tnum">
              {design.nodes.length} nodes · {design.edges.length} links
            </span>
          )}
          {persistence.status !== "idle" && (
            <span
              className={`save-status ${persistence.status === "failed" ? "issue-error" : ""}`}
              title={persistence.detail}
            >
              {persistence.status === "failed" ? "Not saved" : persistence.status}
            </span>
          )}
          <div className="menu-anchor activity-anchor">
            <button
              className="btn status-btn"
              title={webmcp.detail}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "activity" ? null : "activity");
              }}
            >
              <span className={`status-dot ${webmcp.status.includes("tools") ? "ready" : ""}`} />
              {webmcp.status.includes("tools") ? "Codex ready" : "Codex"}
            </button>
            {menu === "activity" && <ActivityLog onClose={() => setMenu(null)} />}
          </div>
        </div>
      </div>

      <div className="topbar-secondary">
        <div className="tb-group">
          <div className="menu-anchor">
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "studies" ? null : "studies");
              }}
            >
              Studies
            </button>
            {menu === "studies" && <StudyMenu onClose={() => setMenu(null)} />}
          </div>
          {study.candidates.length > 0 && (
            <>
              <div className="menu-anchor">
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === "palette" ? null : "palette");
                  }}
                >
                  Add component
                </button>
                {menu === "palette" && <Palette onClose={() => setMenu(null)} />}
              </div>
              <div className="menu-anchor">
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === "examples" ? null : "examples");
                  }}
                >
                  Examples
                </button>
                {menu === "examples" && <ExampleMenu onClose={() => setMenu(null)} />}
              </div>
            </>
          )}
        </div>

        <div className="tb-spacer" />

        <div className="tb-group file-actions">
          <button className="btn" onClick={download}>
            Export
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              // Accepts a study OR a bare design; a design becomes a one-candidate study with no
              // correctness contract, which is the honest treatment of a document that has no
              // invariants.
              importStudyJson(await file.text());
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </header>
  );
}

function DesignView() {
  const hasCandidates = useStudyStore((s) => s.study.candidates.length > 0);
  if (!hasCandidates) return <EmptyStudy />;
  return (
    <>
      <ResultsRail />
      <FlowCanvas />
      <Inspector />
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
        examples: STUDY_EXAMPLES.map((e) => ({
          id: e.id,
          label: e.label,
          summary: e.summary,
          teaches: e.teaches,
        })),
      }),
      openStudy: async (input) => {
        const store = useStudyStore.getState();
        if (input.exampleId) store.openExample(input.exampleId);
        else if (input.studyId) await store.openStudy(input.studyId);
        const err = useStudyStore.getState().error;
        if (err) throw new Error(err);
        return useStudyStore.getState().study;
      },
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
      runEvaluation: async (input) => {
        if (input.signal?.aborted) throw new Error("evaluation aborted before it began");
        const abort = () => cancelWorker();
        input.signal?.addEventListener("abort", abort, { once: true });
        try {
          const evaluation = await useStudyStore.getState().evaluate(input.candidateId, {
            correctness: input.correctness,
            performance: input.performance,
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
  const view = useStudyStore((s) => s.view);
  const error = useStudyStore((s) => s.error);
  useWebmcp();

  useEffect(() => {
    void restoreStudy();
  }, []);

  return (
    <div className={`shell shell-${view}`}>
      <Topbar />
      <CandidateBar />
      {error && <div className="banner banner-error">{error}</div>}
      {view === "design" && <DesignView />}
      {view === "correctness" && <CorrectnessView />}
      {view === "performance" && <PerformanceView />}
      {view === "compare" && <CompareView />}
    </div>
  );
}

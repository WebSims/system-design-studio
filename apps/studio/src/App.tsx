import { useCallback, useEffect, useRef, useState } from "react";
import { PRESETS, EXAMPLES } from "@sds/models";
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
 * Saved projects. `Study` remains the internal document type, but it is not a user concept.
 */
function ProjectMenu({ onClose }: { onClose: () => void }) {
  const openStudy = useStudyStore((s) => s.openStudy);
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
      <div className="palette-title">projects</div>
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
      {saved?.length === 0 && <p className="muted">No saved projects yet.</p>}
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
const REPOSITORY_PROMPT =
  "Inspect this repository and reconstruct its current as-is architecture in System Design Studio. " +
  "Cite code or configuration for every observed component and connection, label deductions as inferred, " +
  "and keep unknown production behavior as explicit assumptions. Then create experiments for the highest-risk " +
  "bottlenecks or concurrency issues and evaluate them. Do not change the code yet.";

function EmptyProject() {
  const webmcp = useStudyStore((s) => s.webmcp);
  const addCandidate = useStudyStore((s) => s.addCandidate);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(REPOSITORY_PROMPT);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="empty-study">
      <div className="empty-card">
        <div className="empty-kicker">Architecture twin for your codebase</div>
        <h1>See the system your code actually builds.</h1>
        <p className="empty-lede">
          Ask Codex to inspect a repository. It will map the current architecture with source
          evidence, then this studio can stress it, expose failure paths, and compare fixes.
        </p>

        <ol className="onboarding-steps">
          <li>
            <span>01</span>
            <div><b>Inspect code</b><small>Routes, services, stores, queues, config and deployment.</small></div>
          </li>
          <li>
            <span>02</span>
            <div><b>Build the as-is twin</b><small>Observed facts stay separate from inference and assumptions.</small></div>
          </li>
          <li>
            <span>03</span>
            <div><b>Break it safely</b><small>Test load, faults and races before changing production code.</small></div>
          </li>
        </ol>

        <div className="starter-prompt">
          <span>Repository handoff prompt</span>
          <p>{REPOSITORY_PROMPT}</p>
        </div>

        <div className="empty-actions">
          <button className="btn primary" onClick={() => void copyPrompt()}>
            {copyState === "copied" ? "Prompt copied" : copyState === "failed" ? "Copy unavailable" : "Copy agent prompt"}
          </button>
          <button
            className="btn"
            onClick={() => {
              const example = EXAMPLES[0];
              if (!example) return;
              addCandidate({
                label: example.label,
                intent: `Worked example: ${example.blurb}`,
                design: example.build(),
                origin: "human",
              });
            }}
          >
            Explore worked example
          </button>
        </div>

        <p className="muted empty-agent">
          {webmcp.status.includes("tools")
            ? "Codex is connected. It can write the model; you approve what becomes real."
            : "Open this page in Codex's browser to expose the studio tools."}
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
    <nav className="tabs" aria-label="Project views">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={view === v.id ? "active" : ""}
          aria-current={view === v.id ? "page" : undefined}
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
  const [menu, setMenu] = useState<"palette" | "examples" | "projects" | "activity" | null>(null);
  const webmcpReady = webmcp.status.includes("tools");
  const activeCandidate =
    study.candidates.find((candidate) => candidate.id === study.activeCandidateId) ??
    study.candidates[0];
  const evidenceCoverage = activeCandidate
    ? new Set(
        activeCandidate.evidence.map((evidence) => `${evidence.targetKind}:${evidence.targetId}`)
      ).size
    : 0;
  const architectureElements = activeCandidate
    ? activeCandidate.design.nodes.length + activeCandidate.design.edges.length
    : 0;
  const sourceRevision = study.repository?.revision
    ? study.repository.revision.slice(0, 9)
    : "unversioned";

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
            <div className="brand-sub">Code → model → test → code</div>
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
              aria-expanded={menu === "activity"}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "activity" ? null : "activity");
              }}
            >
              <span className={`status-dot ${webmcpReady ? "ready" : ""}`} />
              {webmcpReady ? "Codex ready" : `Codex ${webmcp.status}`}
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
              aria-expanded={menu === "projects"}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "projects" ? null : "projects");
              }}
            >
              Projects
            </button>
            {menu === "projects" && <ProjectMenu onClose={() => setMenu(null)} />}
          </div>
          {study.candidates.length > 0 && (
            <>
              <div className="menu-anchor">
                <button
                  className="btn"
                  aria-expanded={menu === "palette"}
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
                  aria-expanded={menu === "examples"}
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

        {study.repository && (
          <div
            className="repository-status"
            title={`${study.repository.rootHint || study.repository.name} · ${evidenceCoverage}/${architectureElements} architecture elements have evidence`}
          >
            <span className="repository-dot" />
            <strong>{study.repository.name}</strong>
            <code>{study.repository.branch || "workspace"}@{sourceRevision}</code>
            <span className="repository-coverage">
              {evidenceCoverage}/{architectureElements} evidenced
            </span>
            {study.repository.dirty && <span className="repository-dirty">dirty</span>}
          </div>
        )}

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
  if (!hasCandidates) return <EmptyProject />;
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

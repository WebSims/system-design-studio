import { useMemo, useState } from "react";
import type {
  CorrectnessResult,
  Counterexample,
  Expr,
  Invariant,
  InvariantScope,
  Study,
} from "@sds/schema";
import { useStudyStore } from "../study/store";
import { layoutCounterexample, verdictHeadline, describeFault } from "../correctness/layout";
import {
  buildInvariant,
  describeInvariant,
  invariantTemplates,
  templateFor,
  type InvariantDraft,
} from "../correctness/builder";

/**
 * The correctness view.
 *
 * TWO WAYS IN, ONE MODEL
 *
 * The guided builder composes an invariant from a template and a couple of collection names; the
 * expert editor edits the same invariant as raw declarative JSON. They are not two features, they
 * are two projections of one `Invariant`, and switching between them mid-edit is lossless because
 * there is nothing to lose -- the guided form is a constructor, not a separate representation.
 *
 * That is what "both learner and expert" has to mean to be worth saying. Two editors over two
 * models would drift, and the drift would show up as an invariant that reads correctly in the
 * guided view and checks something else.
 */
export function CorrectnessView() {
  const study = useStudyStore((s) => s.study);
  const active = useStudyStore((s) => s.activeCandidate());
  const evaluation = useStudyStore((s) => (active ? s.evaluationFor(active.id) : null));
  const running = useStudyStore((s) => (active ? s.running.has(active.id) : false));
  const checkOnly = useStudyStore((s) => s.checkOnly);
  const cancel = useStudyStore((s) => s.cancel);

  const correctness = evaluation?.correctness ?? null;

  return (
    <div className="view view-correctness">
      <div className="view-main">
        <section className="section">
          <header className="section-head">
            <h2>correctness</h2>
            {active && (
              <div className="row-actions">
                {running ? (
                  <button className="btn" onClick={cancel}>
                    cancel
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => void checkOnly(active.id)}>
                    run the bounded search
                  </button>
                )}
              </div>
            )}
          </header>

          {active ? (
            <p className="muted">{active.label}</p>
          ) : (
            <p className="muted">Ask Codex to create a candidate first.</p>
          )}

          {!correctness && !running && (
            <p className="muted">
              Not checked yet. Limit: {study.correctness.bounds.actors} initial requests and{" "}
              {study.correctness.bounds.states.toLocaleString()} states.
            </p>
          )}

          {running && <p className="muted">exploring\u2026</p>}

          {correctness && <Verdict result={correctness} />}
        </section>

        {correctness?.counterexample && (
          <CounterexamplePanel counterexample={correctness.counterexample} />
        )}
      </div>

      <aside className="view-side">
        <InvariantEditor study={study} />
        <BoundsEditor study={study} />
      </aside>
    </div>
  );
}

function Verdict({ result }: { result: CorrectnessResult }) {
  const headline = verdictHeadline(result.status, result.stats);
  return (
    <div className={`verdict verdict-${headline.tone}`}>
      <div className="verdict-status">{result.status.replace(/_/g, " ").toLowerCase()}</div>
      <p className="verdict-headline">{headline.text}</p>
      <p className="verdict-claim">{result.claim}</p>

      {result.modelErrors.length > 0 && (
        <ul className="issue-list">
          {result.modelErrors.map((e, i) => (
            <li key={i} className="issue-error">
              {e}
            </li>
          ))}
        </ul>
      )}

      <dl className="stat-grid">
        <div>
          <dt>states examined</dt>
          <dd className="tnum">{result.stats.statesVisited.toLocaleString()}</dd>
        </div>
        <div>
          <dt>transitions</dt>
          <dd className="tnum">{result.stats.transitionsApplied.toLocaleString()}</dd>
        </div>
        <div>
          <dt>pruned as equivalent</dt>
          <dd className="tnum">{result.stats.duplicatesPruned.toLocaleString()}</dd>
        </div>
        <div>
          <dt>search finished</dt>
          <dd>{result.stats.exhausted ? "yes" : `no \u2014 hit the ${result.stats.capHit} cap`}</dd>
        </div>
        <div>
          <dt>reached quiescence</dt>
          <dd className="tnum">{result.stats.quiescentTerminals.toLocaleString()} times</dd>
        </div>
        <div>
          <dt>wall clock</dt>
          <dd className="tnum">{Math.round(result.stats.wallMs)}ms</dd>
        </div>
      </dl>

      <details className="assumptions">
        <summary>what this result assumes ({result.assumptions.length})</summary>
        <ul>
          {result.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Swimlanes plus a scrubber.
 *
 * The scrubber matters more than it looks. A counterexample is a story about ORDER, and a static
 * list of six operations does not communicate order -- a reader has to hold the state in their
 * head. Stepping through it with the state shown beside each step is the difference between
 * being told there is a race and seeing one.
 */
function CounterexamplePanel({ counterexample }: { counterexample: Counterexample }) {
  const layout = useMemo(() => layoutCounterexample(counterexample), [counterexample]);
  const [at, setAt] = useState(layout.steps.length - 1);
  const cursor = Math.min(at, layout.steps.length - 1);

  return (
    <section className="section counterexample">
      <header className="section-head">
        <h2>counterexample</h2>
        <span className="badge badge-bad">
          {counterexample.steps.length} transitions, minimal
        </span>
      </header>

      {layout.explanation.map((paragraph, i) => (
        <p key={i} className={i === 0 ? "lede" : ""}>
          {paragraph}
        </p>
      ))}

      {counterexample.faultsUsed.length > 0 && (
        <ul className="fault-list">
          {counterexample.faultsUsed.map((f) => (
            <li key={f}>
              <span className="badge badge-warn">{f}</span> {describeFault(f)}
            </li>
          ))}
        </ul>
      )}

      {layout.inconsistencies.length > 0 && (
        <ul className="issue-list">
          {layout.inconsistencies.map((i, k) => (
            <li key={k} className="issue-error">
              trace inconsistency: {i}
            </li>
          ))}
        </ul>
      )}

      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={Math.max(0, layout.steps.length - 1)}
          value={cursor}
          onChange={(e) => setAt(Number(e.target.value))}
          aria-label="step through the counterexample"
        />
        <span className="tnum">
          step {cursor + 1} of {layout.steps.length}
        </span>
      </div>

      <div className="lanes" style={{ gridTemplateColumns: `repeat(${layout.lanes.length}, minmax(0, 1fr))` }}>
        {layout.lanes.map((lane) => (
          <div key={lane.id} className={`lane-head lane-${lane.kind}`}>
            <span className="lane-id">{lane.id}</span>
            <span className="lane-label">{lane.label}</span>
          </div>
        ))}

        {layout.steps.map((laid, i) => (
          <div
            key={laid.step.index}
            className={`lane-row ${i === cursor ? "lane-row-current" : ""} ${i > cursor ? "lane-row-future" : ""}`}
            style={{ gridColumn: `${laid.column + 1}` }}
          >
            <div className={`lane-cell ${laid.step.fault ? "lane-cell-fault" : ""}`}>
              <span className="lane-step">{laid.step.index + 1}</span>
              <span className="lane-op">{laid.step.label}</span>
              {laid.observedSummary && <span className="lane-saw">saw {laid.observedSummary}</span>}
              {laid.diffSummary && <span className="lane-diff">{laid.diffSummary}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="timeline">
        <h3>state after step {cursor + 1}</h3>
        <dl className="stat-grid">
          {Object.entries(layout.timeline[cursor]?.values ?? {}).map(([id, value]) => (
            <div key={id}>
              <dt>{id}</dt>
              <dd className="tnum">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/**
 * The invariant list, with a guided builder and an expert JSON editor.
 *
 * Editing an invariant invalidates every cached correctness result, because the bounds hash covers
 * the correctness contract. That is deliberate and it is why the button says so: a user who tightens
 * an invariant and sees the old green verdict still on screen has been told something false.
 */
function InvariantEditor({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract);
  const [mode, setMode] = useState<"guided" | "expert">("guided");
  const [draft, setDraft] = useState<InvariantDraft>({
    templateId: invariantTemplates[0]!.id,
    label: "",
    message: "",
    scope: "safety",
    args: {},
  });

  const collections = useMemo(() => {
    const active = study.candidates.find((c) => c.id === study.activeCandidateId) ?? study.candidates[0];
    return active?.design.workflow?.collections ?? [];
  }, [study]);

  const template = templateFor(draft.templateId);

  const add = () => {
    const built = buildInvariant(draft);
    if (!built.ok) return;
    updateContract({
      correctness: {
        ...study.correctness,
        invariants: [...study.correctness.invariants, built.invariant],
      },
    });
  };

  const remove = (id: string) => {
    updateContract({
      correctness: {
        ...study.correctness,
        invariants: study.correctness.invariants.filter((i) => i.id !== id),
      },
    });
  };

  const built = buildInvariant(draft);

  return (
    <section className="section">
      <header className="section-head">
        <h2>invariants</h2>
        <div className="tabs tabs-small">
          <button className={mode === "guided" ? "active" : ""} onClick={() => setMode("guided")}>
            guided
          </button>
          <button className={mode === "expert" ? "active" : ""} onClick={() => setMode("expert")}>
            expert
          </button>
        </div>
      </header>

      {study.correctness.invariants.length === 0 && (
        <p className="muted">Add at least one rule to check.</p>
      )}

      <ul className="invariant-list">
        {study.correctness.invariants.map((inv) => (
          <li key={inv.id}>
            <div className="invariant-head">
              <span className={`badge ${inv.scope === "safety" ? "badge-info" : "badge-muted"}`}>
                {inv.scope}
              </span>
              <strong>{inv.label}</strong>
              <button className="btn btn-quiet" onClick={() => remove(inv.id)} title="remove">
                &times;
              </button>
            </div>
            <p className="muted">{describeInvariant(inv)}</p>
            {mode === "expert" && <ExpertExpression invariant={inv} />}
          </li>
        ))}
      </ul>

      {mode === "guided" ? (
        <div className="builder">
          <label>
            rule
            <select
              value={draft.templateId}
              onChange={(e) => setDraft({ ...draft, templateId: e.target.value, args: {} })}
            >
              {invariantTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{template?.explanation}</p>

          {template?.params.map((param) => (
            <label key={param.name}>
              {param.label}
              {param.kind === "collection" ? (
                <select
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: e.target.value } })}
                >
                  <option value="">choose\u2026</option>
                  {collections
                    .filter((c) => (param.of ? c.kind === param.of : true))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.id} ({c.kind})
                      </option>
                    ))}
                </select>
              ) : param.kind === "field" ? (
                <select
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: e.target.value } })}
                >
                  <option value="">choose\u2026</option>
                  {collections
                    .flatMap((c) => (c.kind === "table" ? c.fields.map((f) => `${c.id}.${f.name}`) : []))
                    .map((f) => (
                      <option key={f} value={f.split(".")[1]}>
                        {f}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={String(draft.args[param.name] ?? "")}
                  onChange={(e) => setDraft({ ...draft, args: { ...draft.args, [param.name]: Number(e.target.value) } })}
                />
              )}
            </label>
          ))}

          <label>
            when is it checked
            <select
              value={draft.scope}
              onChange={(e) => setDraft({ ...draft, scope: e.target.value as InvariantScope })}
            >
              <option value="safety">after every transition (safety)</option>
              <option value="postcondition">only once everything has finished (postcondition)</option>
            </select>
          </label>
          <p className="muted">
            {draft.scope === "safety"
              ? "Checked after every operation."
              : "Checked after all work finishes."}
          </p>

          <label>
            name it
            <input
              value={draft.label}
              placeholder="never allocate more than exists"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label>
            what it costs when it breaks
            <input
              value={draft.message}
              placeholder="two people are holding the same last pizza"
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            />
          </label>

          {built.ok ? (
            <pre className="expr-preview">{JSON.stringify(built.invariant.expr, null, 1)}</pre>
          ) : (
            <p className="issue-error">{built.reason}</p>
          )}

          <button className="btn primary" disabled={!built.ok} onClick={add}>
            add invariant
          </button>
        </div>
      ) : (
        <p className="muted">Raw rule expressions. Invalid expressions fail the check.</p>
      )}
    </section>
  );
}

function ExpertExpression({ invariant }: { invariant: Invariant }) {
  return <pre className="expr-preview">{JSON.stringify(invariant.expr as Expr, null, 1)}</pre>;
}

/**
 * The bounds, which are the size of every claim the search can make.
 *
 * Rendered as editable fields with the consequence of each stated, because these numbers are the
 * product: "no violation found" is meaningless without them and defensible with them.
 */
function BoundsEditor({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract);
  const b = study.correctness.bounds;

  const set = (patch: Partial<typeof b>) =>
    updateContract({ correctness: { ...study.correctness, bounds: { ...b, ...patch } } });

  return (
    <section className="section">
      <header className="section-head">
        <h2>bounds</h2>
      </header>
      <p className="muted">Limits for the race search.</p>

      <label>
        initial concurrent requests
        <input
          type="number"
          min={1}
          max={6}
          value={b.actors}
          onChange={(e) => set({ actors: Number(e.target.value) })}
        />
      </label>
      <p className="muted">More actors cost much more time.</p>

      <label>
        injected faults per execution
        <input
          type="number"
          min={0}
          max={4}
          value={b.faults}
          onChange={(e) => set({ faults: Number(e.target.value) })}
        />
      </label>

      <label>
        transitions per execution
        <input
          type="number"
          min={1}
          max={500}
          value={b.transitions}
          onChange={(e) => set({ transitions: Number(e.target.value) })}
        />
      </label>

      <label>
        state cap
        <input
          type="number"
          min={100}
          step={1000}
          value={b.states}
          onChange={(e) => set({ states: Number(e.target.value) })}
        />
      </label>
      <p className="muted">Hitting a limit means inconclusive.</p>

      <FaultToggles study={study} />
    </section>
  );
}

function FaultToggles({ study }: { study: Study }) {
  const updateContract = useStudyStore((s) => s.updateContract);
  const faults = study.correctness.faults;

  const toggle = (key: keyof typeof faults) =>
    updateContract({
      correctness: { ...study.correctness, faults: { ...faults, [key]: !faults[key] } },
    });

  const labels: Array<[keyof typeof faults, string]> = [
    ["duplicateRequest", "the same person submits twice"],
    ["retrySameKey", "a retry with the same idempotency key"],
    ["retryNewKey", "a retry with a fresh idempotency key"],
    ["workerCrash", "a worker dies after writing, before answering"],
    ["queueRedelivery", "a queue delivers a message again"],
    ["leaseExpiry", "a lease expires under a live holder"],
    ["reservationExpiry", "a reservation expires"],
  ];

  return (
    <div className="fault-toggles">
      <h3>faults in scope</h3>
      <p className="muted">Only enabled faults are tested.</p>
      {labels.map(([key, label]) => (
        <label key={key} className="toggle">
          <input type="checkbox" checked={faults[key]} onChange={() => toggle(key)} />
          {label}
        </label>
      ))}
    </div>
  );
}

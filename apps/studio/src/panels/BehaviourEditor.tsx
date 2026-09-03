import { useMemo, useState } from "react"
import {
  HandlerSchema,
  MAX_CONCURRENCY,
  type Collection,
  type Design,
  type Expr,
  type Handler,
  type Operation,
} from "@sds/schema"

import {
  applyPattern,
  behaviourPatterns,
  emptyWorkflow,
  patternFor,
  suggestBinding,
  suggestedRules,
  SUGGESTED_STATE_OVERRIDES,
  type PatternId,
} from "../behaviour/patterns"
import {
  appendAt,
  conflictText,
  describeStep,
  freshOpId,
  isSchedulingPoint,
  localsBound,
  moveAt,
  removeAt,
  triggerText,
  type StepPath,
} from "../behaviour/steps"
import { useStudio } from "../store"
import { useStudyStore } from "../study/store"
import { Field, NumberInput, Select, Toggle } from "./controls"

/**
 * Request-steps authoring.
 *
 * This is the editor the plan's diagnosis A asked for: the thing that races is the
 * workflow, and until this existed a person could not write one. It lives in the Inspector
 * because behaviour belongs to a node -- a handler runs *on* a service and state lives *on*
 * a database -- and selecting the node is how you get at it.
 *
 * Three entry points, one per node kind that carries behaviour:
 *
 *   `BehaviourEditor` on a server: the handlers that run there, their steps, a pattern picker.
 *   `StateEditor`     on a database: the counters and tables stored there.
 *   `LockEditor`      on a lock: capacity, TTL, and whether it fences.
 */

const DEFAULT_STOCK = 200

// ---------------------------------------------------------------------------
// pattern picker
// ---------------------------------------------------------------------------

function PatternPicker({
  nodeId,
  replacing,
  onDone,
}: {
  nodeId: string
  replacing: boolean
  onDone?: () => void
}) {
  const design = useStudio((s) => s.design)
  const edit = useStudio((s) => s.edit)
  const study = useStudyStore((s) => s.study)
  const updateContract = useStudyStore((s) => s.updateContract)
  const [patternId, setPatternId] = useState<PatternId>("check-then-write")
  const [stock, setStock] = useState(DEFAULT_STOCK)

  const pattern = patternFor(patternId) ?? behaviourPatterns[0]!
  const suggestion = suggestBinding(design, pattern, nodeId, stock)

  const apply = (blank: boolean) => {
    if (!suggestion.binding) return
    const binding = suggestion.binding
    edit((d) => {
      if (blank) d.workflow = emptyWorkflow(binding)
      else applyPattern(d, pattern, binding)
    })
    if (study.correctness.invariants.length === 0) {
      updateContract({
        correctness: {
          ...study.correctness,
          invariants: suggestedRules(),
          stateOverrides: { ...study.correctness.stateOverrides, ...SUGGESTED_STATE_OVERRIDES },
        },
      })
    }
    onDone?.()
  }

  return (
    <div className="pattern-picker">
      <Field label="pattern">
        <Select
          value={patternId}
          options={behaviourPatterns.map((p) => ({
            value: p.id,
            label: `${p.label} · ${p.verdict === "safe" ? "expected safe" : "known to break"}`,
          }))}
          onChange={setPatternId}
        />
      </Field>
      <p className="note">
        <span className={`badge ${pattern.verdict === "safe" ? "badge-ok" : "badge-bad"}`}>
          {pattern.verdict === "safe" ? "expected safe" : "known to break"}
        </span>{" "}
        {pattern.summary}
      </p>
      <Field label="units at the start" hint="the scarce thing">
        <NumberInput value={stock} min={1} max={100_000} step={10} onChange={(v) => setStock(Math.round(v))} />
      </Field>
      {suggestion.missing && <p className="note warn">{suggestion.missing}.</p>}
      <div className="pattern-actions">
        <button className="btn primary small" disabled={!suggestion.binding} onClick={() => apply(false)}>
          {replacing ? "replace with this pattern" : "use this pattern"}
        </button>
        {!replacing && (
          <button className="btn small" disabled={!suggestion.binding} onClick={() => apply(true)}>
            start empty
          </button>
        )}
        {onDone && (
          <button className="btn small ghost" onClick={onDone}>
            cancel
          </button>
        )}
      </div>
      {!replacing && study.correctness.invariants.length === 0 && (
        <p className="note">
          Three rules come with it: the count never goes below zero, never more claims than units, one
          claim per person. The search starts from one unit so a break is reachable with a handful of
          requests. Both are editable in the Behaviour rail.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// step list
// ---------------------------------------------------------------------------

type QuickOp =
  | "read"
  | "if"
  | "delta"
  | "row"
  | "conditionalDelta"
  | "insertUnique"
  | "atomic"
  | "acquireLease"
  | "releaseLease"
  | "publish"
  | "ack"
  | "respond"

const QUICK_OPS: Array<{ value: QuickOp; label: string }> = [
  { value: "read", label: "read a counter into a local" },
  { value: "if", label: "if … (branch)" },
  { value: "delta", label: "add to a counter" },
  { value: "row", label: "write a row" },
  { value: "conditionalDelta", label: "guarded add to a counter (indivisible)" },
  { value: "insertUnique", label: "insert a row unless present (unique)" },
  { value: "atomic", label: "transaction block" },
  { value: "acquireLease", label: "acquire a lease" },
  { value: "releaseLease", label: "release a lease" },
  { value: "publish", label: "publish to a queue" },
  { value: "ack", label: "acknowledge the message" },
  { value: "respond", label: "respond" },
]

const COMPARE_OPS = ["==", "!=", "<", "<=", ">", ">="] as const
type CompareOp = (typeof COMPARE_OPS)[number]

interface QuickDraft {
  kind: QuickOp
  collection: string
  into: string
  local: string
  compare: CompareOp
  number: number
  keyField: string
  lock: string
  leaseKey: string
  ttlMs: number
  fencing: boolean
  queue: string
  status: "success" | "rejected" | "error"
  outcome: string
}

const lit = (value: number | string | boolean): Expr => ({ kind: "lit", value })
const req = (field: string): Expr => ({ kind: "request", field })

/**
 * Row fields for a write or insert, filled from request fields of the same name.
 *
 * The key field is left out because the key is the address, not a value. Anything without
 * a matching request field falls back to the collection's declared default, which is what
 * the engine would apply anyway; writing it down keeps the expert view honest.
 */
const rowFields = (design: Design, table: Collection | undefined): Record<string, Expr> => {
  if (!table || table.kind !== "table") return {}
  const requestNames = new Set(design.workflow?.requestFields.map((f) => f.name) ?? [])
  const out: Record<string, Expr> = {}
  for (const field of table.fields) {
    if (field.name === table.key) continue
    if (requestNames.has(field.name)) out[field.name] = req(field.name)
    else if (field.default !== null) out[field.name] = lit(field.default)
  }
  return out
}

const buildQuickOp = (design: Design, handler: Handler, draft: QuickDraft): Operation | null => {
  const id = (base: string) => freshOpId(handler, base)
  const table = design.workflow?.collections.find((c) => c.id === draft.collection)
  switch (draft.kind) {
    case "read":
      if (!draft.collection || !draft.into.trim()) return null
      return { op: "read", id: id("read"), value: { kind: "counter", collection: draft.collection }, into: draft.into.trim() }
    case "if":
      if (!draft.local.trim()) return null
      return {
        op: "branch",
        id: id("if"),
        cond: { kind: "compare", op: draft.compare, left: { kind: "local", name: draft.local.trim() }, right: lit(draft.number) },
        then: [],
        else: [],
      }
    case "delta":
      if (!draft.collection) return null
      return { op: "write", id: id("add"), collection: draft.collection, key: null, mode: "delta", value: lit(draft.number), fields: {} }
    case "row":
      if (!draft.collection || !draft.keyField) return null
      return {
        op: "write",
        id: id("write-row"),
        collection: draft.collection,
        key: req(draft.keyField),
        mode: "set",
        value: null,
        fields: rowFields(design, table),
      }
    case "conditionalDelta":
      if (!draft.collection) return null
      return {
        op: "conditionalWrite",
        id: id("guarded-add"),
        collection: draft.collection,
        key: null,
        guard: { kind: "compare", op: draft.compare, left: { kind: "counter", collection: draft.collection }, right: lit(draft.number) },
        mode: "delta",
        value: lit(-1),
        fields: {},
        onFail: "continue",
        into: draft.into.trim() || "took",
      }
    case "insertUnique":
      if (!draft.collection || !draft.keyField) return null
      return {
        op: "insertUnique",
        id: id("insert-once"),
        collection: draft.collection,
        key: req(draft.keyField),
        fields: rowFields(design, table),
        onConflict: "continue",
        into: draft.into.trim() || "mine",
      }
    case "atomic":
      return { op: "atomic", id: id("tx"), body: [] }
    case "acquireLease":
      if (!draft.lock) return null
      return {
        op: "acquireLease",
        id: id("acquire"),
        lock: draft.lock,
        key: lit(draft.leaseKey || "key"),
        ttlMs: Math.max(1, Math.round(draft.ttlMs)),
        fencing: draft.fencing,
        into: draft.into.trim() || "lease",
        onBusy: "fail",
      }
    case "releaseLease":
      if (!draft.lock) return null
      return { op: "releaseLease", id: id("release"), lock: draft.lock, key: lit(draft.leaseKey || "key") }
    case "publish":
      if (!draft.queue) return null
      return {
        op: "publish",
        id: id("publish"),
        queue: draft.queue,
        message: Object.fromEntries((design.workflow?.requestFields ?? []).map((f) => [f.name, req(f.name)])),
      }
    case "ack":
      return { op: "ack", id: id("ack") }
    case "respond":
      return { op: "respond", id: id("respond"), status: draft.status, outcome: draft.outcome.trim() || null }
  }
}

function StepAdder({ handlerId, path }: { handlerId: string; path: StepPath }) {
  const design = useStudio((s) => s.design)
  const edit = useStudio((s) => s.edit)
  const [open, setOpen] = useState(false)
  const handler = design.workflow?.handlers.find((h) => h.id === handlerId)

  const counters = design.workflow?.collections.filter((c) => c.kind === "counter") ?? []
  const tables = design.workflow?.collections.filter((c) => c.kind === "table") ?? []
  const requestFields = design.workflow?.requestFields ?? []
  const locks = design.nodes.filter((n) => n.kind === "lock")
  const queues = design.nodes.filter((n) => n.kind === "queue")
  const locals = handler ? localsBound(handler.steps) : []

  const [draft, setDraft] = useState<QuickDraft>({
    kind: "read",
    collection: counters[0]?.id ?? "",
    into: "left",
    local: locals[0] ?? "left",
    compare: ">",
    number: 0,
    keyField: requestFields[0]?.name ?? "",
    lock: locks[0]?.id ?? "",
    leaseKey: "key",
    ttlMs: 2000,
    fencing: true,
    queue: queues[0]?.id ?? "",
    status: "success",
    outcome: "",
  })
  const set = <K extends keyof QuickDraft>(key: K, value: QuickDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  if (!handler) return null
  if (!open) {
    return (
      <button className="btn small ghost step-add" onClick={() => setOpen(true)}>
        + add step
      </button>
    )
  }

  const usesCounter = draft.kind === "read" || draft.kind === "delta" || draft.kind === "conditionalDelta"
  const usesTable = draft.kind === "row" || draft.kind === "insertUnique"
  const collectionOptions = (usesCounter ? counters : tables).map((c) => ({ value: c.id, label: c.label || c.id }))

  const pick = (kind: QuickOp) => {
    const wantsCounter = kind === "read" || kind === "delta" || kind === "conditionalDelta"
    const wantsTable = kind === "row" || kind === "insertUnique"
    setDraft((d) => ({
      ...d,
      kind,
      collection: wantsCounter ? counters[0]?.id ?? "" : wantsTable ? tables[0]?.id ?? "" : d.collection,
      into: kind === "read" ? "left" : kind === "conditionalDelta" ? "took" : kind === "insertUnique" ? "mine" : kind === "acquireLease" ? "lease" : d.into,
      number: kind === "delta" ? -1 : 0,
    }))
  }

  const built = buildQuickOp(design, handler, draft)
  const add = () => {
    if (!built) return
    edit((d) => {
      const h = d.workflow?.handlers.find((x) => x.id === handlerId)
      if (h) appendAt(h.steps, path, built)
    })
    setOpen(false)
  }

  return (
    <div className="step-adder">
      <Field label="step">
        <Select value={draft.kind} options={QUICK_OPS} onChange={pick} />
      </Field>

      {(usesCounter || usesTable) && (
        <Field label={usesCounter ? "counter" : "table"}>
          {collectionOptions.length === 0 ? (
            <span className="field-empty">none on the canvas yet · add one on the database</span>
          ) : (
            <Select value={draft.collection} options={collectionOptions} onChange={(v) => set("collection", v)} />
          )}
        </Field>
      )}

      {draft.kind === "read" && (
        <Field label="into local">
          <input className="input" value={draft.into} onChange={(e) => set("into", e.target.value)} />
        </Field>
      )}

      {draft.kind === "if" && (
        <div className="step-adder-row">
          <Field label="local">
            <input className="input" list={`locals-${handlerId}`} value={draft.local} onChange={(e) => set("local", e.target.value)} />
            <datalist id={`locals-${handlerId}`}>
              {locals.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label="is">
            <Select value={draft.compare} options={COMPARE_OPS.map((op) => ({ value: op, label: op }))} onChange={(v) => set("compare", v)} />
          </Field>
          <Field label="value">
            <NumberInput value={draft.number} onChange={(v) => set("number", v)} />
          </Field>
        </div>
      )}

      {draft.kind === "delta" && (
        <Field label="add" hint="negative to take">
          <NumberInput value={draft.number} step={1} onChange={(v) => set("number", Math.round(v))} />
        </Field>
      )}

      {draft.kind === "conditionalDelta" && (
        <>
          <div className="step-adder-row">
            <Field label="only if counter is">
              <Select value={draft.compare} options={COMPARE_OPS.map((op) => ({ value: op, label: op }))} onChange={(v) => set("compare", v)} />
            </Field>
            <Field label="value">
              <NumberInput value={draft.number} onChange={(v) => set("number", v)} />
            </Field>
          </div>
          <Field label="record outcome in local">
            <input className="input" value={draft.into} onChange={(e) => set("into", e.target.value)} />
          </Field>
          <p className="note">Takes one unit. The check and the write cannot be interleaved.</p>
        </>
      )}

      {(draft.kind === "row" || draft.kind === "insertUnique") && (
        <Field label="row key from request field">
          <Select
            value={draft.keyField}
            options={requestFields.map((f) => ({ value: f.name, label: f.name }))}
            onChange={(v) => set("keyField", v)}
          />
        </Field>
      )}
      {draft.kind === "insertUnique" && (
        <Field label="record outcome in local">
          <input className="input" value={draft.into} onChange={(e) => set("into", e.target.value)} />
        </Field>
      )}

      {(draft.kind === "acquireLease" || draft.kind === "releaseLease") && (
        <>
          <Field label="lock service">
            {locks.length === 0 ? (
              <span className="field-empty">no lock service on the canvas</span>
            ) : (
              <Select value={draft.lock} options={locks.map((n) => ({ value: n.id, label: n.label }))} onChange={(v) => set("lock", v)} />
            )}
          </Field>
          <Field label="lease key">
            <input className="input" value={draft.leaseKey} onChange={(e) => set("leaseKey", e.target.value)} />
          </Field>
        </>
      )}
      {draft.kind === "acquireLease" && (
        <>
          <Field label="ttl" hint="ms">
            <NumberInput value={draft.ttlMs} min={1} step={500} onChange={(v) => set("ttlMs", v)} />
          </Field>
          <Toggle
            label={draft.fencing ? "fenced" : "not fenced"}
            hint={draft.fencing ? "the datastore refuses a stale holder" : "an expired holder is indistinguishable from the real one"}
            on={draft.fencing}
            onChange={(v) => set("fencing", v)}
          />
        </>
      )}

      {draft.kind === "publish" && (
        <Field label="queue">
          {queues.length === 0 ? (
            <span className="field-empty">no queue on the canvas</span>
          ) : (
            <Select value={draft.queue} options={queues.map((n) => ({ value: n.id, label: n.label }))} onChange={(v) => set("queue", v)} />
          )}
        </Field>
      )}

      {draft.kind === "respond" && (
        <div className="step-adder-row">
          <Field label="status">
            <Select
              value={draft.status}
              options={[
                { value: "success", label: "success" },
                { value: "rejected", label: "rejected" },
                { value: "error", label: "error" },
              ]}
              onChange={(v) => set("status", v)}
            />
          </Field>
          <Field label="outcome" hint="counted">
            <input className="input" value={draft.outcome} placeholder="allocated" onChange={(e) => set("outcome", e.target.value)} />
          </Field>
        </div>
      )}

      <div className="pattern-actions">
        <button className="btn primary small" disabled={!built} onClick={add}>
          add
        </button>
        <button className="btn small ghost" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
    </div>
  )
}

function StepBlock({ handlerId, steps, path }: { handlerId: string; steps: Operation[]; path: StepPath }) {
  const edit = useStudio((s) => s.edit)
  const patch = (fn: (steps: Operation[]) => void) =>
    edit((d) => {
      const h = d.workflow?.handlers.find((x) => x.id === handlerId)
      if (h) fn(h.steps)
    })

  return (
    <ol className="step-list">
      {steps.map((op, index) => {
        const conflict = conflictText(op)
        return (
          <li key={op.id} className={`step ${isSchedulingPoint(op) ? "step-sched" : ""} step-${op.op}`}>
            <div className="step-row">
              <span className="step-index tnum">{index + 1}</span>
              <span className="step-text" title={op.id}>
                {describeStep(op)}
                {isSchedulingPoint(op) && (
                  <span className="step-sched-mark" title="scheduling point: another request may run between this step and the next">
                    ⇄
                  </span>
                )}
              </span>
              <span className="step-tools">
                <button className="icon-btn" title="move up" disabled={index === 0} onClick={() => patch((s) => moveAt(s, path, index, -1))}>
                  ↑
                </button>
                <button className="icon-btn" title="move down" disabled={index === steps.length - 1} onClick={() => patch((s) => moveAt(s, path, index, 1))}>
                  ↓
                </button>
                <button className="icon-btn danger" title="remove step" onClick={() => patch((s) => removeAt(s, path, index))}>
                  ×
                </button>
              </span>
            </div>
            {conflict && <div className="step-conflict">{conflict}</div>}
            {op.op === "branch" && (
              <>
                <div className="step-block-label">then</div>
                <StepBlock handlerId={handlerId} steps={op.then} path={[...path, index, "then"]} />
                <div className="step-block-label">else</div>
                <StepBlock handlerId={handlerId} steps={op.else} path={[...path, index, "else"]} />
              </>
            )}
            {op.op === "atomic" && <StepBlock handlerId={handlerId} steps={op.body} path={[...path, index, "body"]} />}
          </li>
        )
      })}
      <li className="step step-adder-slot">
        <StepAdder handlerId={handlerId} path={path} />
      </li>
    </ol>
  )
}

// ---------------------------------------------------------------------------
// handler card
// ---------------------------------------------------------------------------

function ExpertHandler({ handler }: { handler: Handler }) {
  const edit = useStudio((s) => s.edit)
  const [text, setText] = useState(() => JSON.stringify(handler, null, 2))
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    const result = HandlerSchema.safeParse(parsed)
    if (!result.success) {
      setError(result.error.issues.map((i) => `${i.path.join(".") || "handler"}: ${i.message}`).join("; "))
      return
    }
    const next = result.data
    edit((d) => {
      if (!d.workflow) return
      const index = d.workflow.handlers.findIndex((h) => h.id === handler.id)
      if (index >= 0) d.workflow.handlers[index] = next
    })
    setError(null)
  }

  return (
    <div className="expert-handler">
      <textarea
        className="input expert-json"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(30, text.split("\n").length + 1)}
      />
      {error && <p className="note warn">{error}</p>}
      <div className="pattern-actions">
        <button className="btn primary small" onClick={apply}>
          apply JSON
        </button>
        <button className="btn small ghost" onClick={() => setText(JSON.stringify(handler, null, 2))}>
          reset
        </button>
      </div>
    </div>
  )
}

function HandlerCard({ handler, removable }: { handler: Handler; removable: boolean }) {
  const edit = useStudio((s) => s.edit)
  const [expert, setExpert] = useState(false)
  const allIssues = useStudyStore((s) => s.workflowIssues)
  const issues = allIssues.filter((i) => i.handlerId === handler.id)

  const patch = (fn: (h: Handler) => void) =>
    edit((d) => {
      const h = d.workflow?.handlers.find((x) => x.id === handler.id)
      if (h) fn(h)
    })

  return (
    <section className="handler-card">
      <div className="handler-head">
        <input className="input handler-label" value={handler.label} placeholder={handler.id} onChange={(e) => patch((h) => { h.label = e.target.value })} />
        <button className={`btn small ghost ${expert ? "on" : ""}`} onClick={() => setExpert((v) => !v)}>
          {expert ? "steps" : "JSON"}
        </button>
        {removable && (
          <button
            className="icon-btn danger"
            title="remove this handler"
            onClick={() =>
              edit((d) => {
                if (d.workflow) d.workflow.handlers = d.workflow.handlers.filter((h) => h.id !== handler.id)
              })
            }
          >
            ×
          </button>
        )}
      </div>
      <div className="handler-trigger">{triggerText(handler)}</div>
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((issue, i) => (
            <li key={i} className={`issue issue-${issue.severity}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {expert ? <ExpertHandler key={JSON.stringify(handler)} handler={handler} /> : <StepBlock handlerId={handler.id} steps={handler.steps} path={[]} />}
    </section>
  )
}

function AddHandler({ nodeId }: { nodeId: string }) {
  const design = useStudio((s) => s.design)
  const edit = useStudio((s) => s.edit)
  const queues = design.nodes.filter((n) => n.kind === "queue")
  const hasRequestHandler = design.workflow?.handlers.some((h) => h.trigger.kind === "request") ?? false

  const add = (trigger: Handler["trigger"]) =>
    edit((d) => {
      if (!d.workflow) return
      const taken = new Set(d.workflow.handlers.map((h) => h.id))
      const base = trigger.kind === "request" ? "handle" : trigger.kind === "queue" ? "worker" : "expire"
      let id = base
      let n = 2
      while (taken.has(id)) id = `${base}-${n++}`
      d.workflow.handlers.push({
        id,
        label: trigger.kind === "request" ? "handle the request" : trigger.kind === "queue" ? "process a message" : "when the timer fires",
        trigger,
        node: nodeId,
        steps: trigger.kind === "queue" ? [{ op: "ack", id: "ack" }] : [{ op: "respond", id: "ok", status: "success", outcome: null }],
      })
    })

  return (
    <div className="chip-row handler-add">
      {!hasRequestHandler && (
        <button className="chip" onClick={() => add({ kind: "request" })}>
          + request handler
        </button>
      )}
      {queues.map((q) => (
        <button key={q.id} className="chip" onClick={() => add({ kind: "queue", queue: q.id })}>
          + worker for {q.label}
        </button>
      ))}
      <button className="chip" onClick={() => add({ kind: "expiry" })}>
        + timer handler
      </button>
    </div>
  )
}

/** Request steps for a server node. */
export function BehaviourEditor({ nodeId }: { nodeId: string }) {
  const design = useStudio((s) => s.design)
  const [replacing, setReplacing] = useState(false)
  const workflow = design.workflow
  const handlers = useMemo(() => workflow?.handlers.filter((h) => h.node === nodeId) ?? [], [workflow, nodeId])
  const elsewhere = (workflow?.handlers.length ?? 0) - handlers.length

  if (!workflow) {
    return (
      <>
        <div className="section">request steps</div>
        <p className="note">
          Nothing happens here yet. Without steps there is no state, and without state there is
          nothing to race. Start from a pattern the demo already knows how to break, or start empty.
        </p>
        <PatternPicker nodeId={nodeId} replacing={false} />
      </>
    )
  }

  return (
    <>
      <div className="section">
        request steps
        <span className="section-tag">
          <span className="step-sched-mark">⇄</span> = another request may cut in
        </span>
      </div>
      {handlers.length === 0 && (
        <p className="note">
          No steps run on this service.
          {elsewhere > 0 && ` ${elsewhere} handler${elsewhere === 1 ? "" : "s"} run on other services.`}
        </p>
      )}
      {handlers.map((h) => (
        <HandlerCard key={h.id} handler={h} removable={workflow.handlers.length > 1} />
      ))}
      <AddHandler nodeId={nodeId} />
      {replacing ? (
        <PatternPicker nodeId={nodeId} replacing onDone={() => setReplacing(false)} />
      ) : (
        <button className="btn small ghost" onClick={() => setReplacing(true)}>
          replace everything with a pattern…
        </button>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// state on a database
// ---------------------------------------------------------------------------

function CollectionCard({ collection }: { collection: Collection }) {
  const edit = useStudio((s) => s.edit)
  const allIssues = useStudyStore((s) => s.workflowIssues)
  const issues = allIssues.filter((i) => i.message.includes(`"${collection.id}"`))
  const patch = (fn: (c: Collection) => void) =>
    edit((d) => {
      const c = d.workflow?.collections.find((x) => x.id === collection.id)
      if (c) fn(c)
    })
  const remove = () =>
    edit((d) => {
      if (d.workflow) d.workflow.collections = d.workflow.collections.filter((c) => c.id !== collection.id)
    })

  return (
    <section className="collection-card">
      <div className="handler-head">
        <span className={`badge ${collection.kind === "counter" ? "badge-info" : "badge-muted"}`}>{collection.kind}</span>
        <code className="collection-id">{collection.id}</code>
        <button className="icon-btn danger" title="remove" onClick={remove}>
          ×
        </button>
      </div>
      <Field label="label">
        <input className="input" value={collection.label} onChange={(e) => patch((c) => { c.label = e.target.value })} />
      </Field>
      {collection.kind === "counter" ? (
        <Field label="starts at">
          <NumberInput
            value={collection.initial}
            step={10}
            onChange={(v) =>
              patch((c) => {
                if (c.kind === "counter") c.initial = Math.round(v)
              })
            }
          />
        </Field>
      ) : (
        <div className="table-fields">
          <div className="field-label">fields · keyed by {collection.key}</div>
          <ul className="field-chips">
            {collection.fields.map((f) => (
              <li key={f.name} className={`chip static ${f.name === collection.key ? "on" : ""}`}>
                {f.name}
                <small> {f.type}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.map((issue, i) => (
        <p key={i} className="note warn">
          {issue.message}
        </p>
      ))}
    </section>
  )
}

/** Counters and tables stored on a database node. */
export function StateEditor({ nodeId }: { nodeId: string }) {
  const design = useStudio((s) => s.design)
  const edit = useStudio((s) => s.edit)
  const workflow = design.workflow
  const here = workflow?.collections.filter((c) => c.node === nodeId) ?? []

  const addCollection = (collection: Collection) =>
    edit((d) => {
      if (d.workflow) d.workflow.collections.push(collection)
    })

  const freshId = (base: string) => {
    const taken = new Set(workflow?.collections.map((c) => c.id) ?? [])
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base}${n}`)) n += 1
    return `${base}${n}`
  }

  return (
    <>
      <div className="section">state stored here</div>
      {!workflow ? (
        <p className="note">
          State appears once there are request steps. Select a service and start from a pattern; its
          counters and table will be stored on this database.
        </p>
      ) : (
        <>
          {here.length === 0 && <p className="note">Nothing is stored here yet.</p>}
          {here.map((c) => (
            <CollectionCard key={c.id} collection={c} />
          ))}
          <div className="chip-row">
            <button
              className="chip"
              onClick={() =>
                addCollection({ kind: "counter", id: freshId("counter"), label: "a count", node: nodeId, initial: 100 })
              }
            >
              + counter
            </button>
            <button
              className="chip"
              onClick={() =>
                addCollection({
                  kind: "table",
                  id: freshId("rows"),
                  label: "rows keyed by request id",
                  node: nodeId,
                  key: "id",
                  fields: [
                    { name: "id", type: "string", values: [], default: null },
                    { name: "userId", type: "string", values: [], default: null },
                  ],
                  seed: [],
                })
              }
            >
              + table
            </button>
          </div>
          <p className="note">
            A counter supports an indivisible guarded add; a table supports a unique insert. Those two
            primitives are the difference between every broken pattern and every safe one.
          </p>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// lock service
// ---------------------------------------------------------------------------

/** Capacity, TTL and fencing for a lock node. */
export function LockEditor({ nodeId }: { nodeId: string }) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === nodeId))
  const edit = useStudio((s) => s.edit)
  const workflow = useStudio((s) => s.design.workflow)
  const leaseSteps = (workflow?.handlers ?? []).flatMap((h) => h.steps.filter((op) => op.op === "acquireLease" && op.lock === nodeId))
  if (!node?.lock) return null
  const lock = node.lock
  const patch = (fn: (l: typeof lock) => void) =>
    edit((d) => {
      const n = d.nodes.find((x) => x.id === nodeId)
      if (n?.lock) fn(n.lock)
    })

  return (
    <>
      <div className="section">leases</div>
      <Toggle
        label={lock.fencingTokens ? "issues fencing tokens" : "no fencing tokens"}
        hint={
          lock.fencingTokens
            ? "the datastore can refuse a holder whose lease expired"
            : "an expired holder and the current one look the same to the datastore"
        }
        on={lock.fencingTokens}
        onChange={(v) => patch((l) => { l.fencingTokens = v })}
      />
      <Field label="default ttl" hint="ms">
        <NumberInput value={lock.defaultTtlMs} min={1} step={500} onChange={(v) => patch((l) => { l.defaultTtlMs = Math.max(1, v) })} />
      </Field>
      <p className="note">
        Too short and a healthy holder loses its lease mid-work, so two workers proceed believing they
        are alone. Too long and a dead holder's key stays locked for the whole interval.
        {leaseSteps.length > 0 && (
          <>
            {" "}
            {leaseSteps.length} step{leaseSteps.length === 1 ? "" : "s"} acquire a lease here
            {leaseSteps.some((op) => op.op === "acquireLease" && !op.fencing) && (
              <b className="warn-text"> without asking for a fencing token</b>
            )}
            .
          </>
        )}
      </p>
      <div className="section">capacity</div>
      <Field label="concurrency" hint="leases served at once">
        <NumberInput
          value={lock.concurrency}
          min={1}
          max={MAX_CONCURRENCY}
          onChange={(v) => patch((l) => { l.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(v))) })}
        />
      </Field>
      <p className="note">
        A lock service is a serialisation point by construction. Under load it is the component that
        does no useful work and still sets the throughput ceiling.
      </p>
    </>
  )
}

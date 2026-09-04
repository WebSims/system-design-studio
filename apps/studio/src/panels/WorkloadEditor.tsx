import { useEffect, useRef } from "react"
import { isPlaceholderWorkload, isTimeVarying, type ArrivalProcess, type Study } from "@sds/schema"
import { useStudio } from "../store"
import { useStudyStore } from "../study/store"
import { PlusIcon, TrashIcon } from "../ui/icons"
import { Field, FieldRow, IconButton, NullableNumberInput, NumberInput, Select } from "./controls"
import { DensitySection } from "./DensitySection"

/**
 * The one place the workload is edited.
 *
 * WHY HERE AND NOT ON THE CLIENT NODE
 *
 * `syncCandidateToStudy` overwrites every client's arrival, the run length and the SLO from the
 * project before each run, so a rate typed on a client node was shown on the canvas and then
 * ignored by the runner: the card said 100 req/s and the run used 50. The project owns the
 * workload because every version is judged against the same one; this editor writes the project
 * and the store re-syncs the versions at once, so what the canvas shows is what will run.
 */

const rateOf = (a: ArrivalProcess): number =>
  a.kind === "poisson" || a.kind === "deterministic" || a.kind === "steps"
    ? a.ratePerSec
    : a.kind === "ramp"
      ? a.toRatePerSec
      : a.baseRatePerSec

export const describeArrival = (a: ArrivalProcess): string => {
  switch (a.kind) {
    case "poisson":
      return `poisson \u00b7 ${a.ratePerSec} req/s`
    case "deterministic":
      return `paced \u00b7 ${a.ratePerSec} req/s`
    case "ramp":
      return `ramp \u00b7 ${a.fromRatePerSec} \u2192 ${a.toRatePerSec} req/s`
    case "spike":
      return `spike \u00b7 ${a.baseRatePerSec} req/s, ${a.peakRatePerSec} at ${a.atSec} s`
    case "steps":
      return `steps \u00b7 ${a.ratePerSec} req/s, ${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`
  }
}

/** Switch the shape while keeping the rate a person already typed. */
const retarget = (a: ArrivalProcess, kind: ArrivalProcess["kind"], durationSec: number): ArrivalProcess => {
  const current = rateOf(a)
  switch (kind) {
    case "poisson":
    case "deterministic":
      return { kind, ratePerSec: current }
    case "ramp":
      return { kind, fromRatePerSec: Math.max(1, current * 0.1), toRatePerSec: current * 2 }
    case "spike":
      return {
        kind,
        baseRatePerSec: current,
        peakRatePerSec: current * 3,
        atSec: Math.round(durationSec * 0.3),
        durationSec: Math.max(5, Math.round(durationSec * 0.1)),
      }
    case "steps":
      return { kind, ratePerSec: current, steps: [{ atSec: Math.round(durationSec * 0.5), ratePerSec: current * 2 }] }
  }
}

/**
 * The arrival profile, controlled.
 *
 * The first two shapes are stationary and the rest are not, and the difference changes what the
 * tool can honestly report. A design under a ramp has no steady state, so a single p99 over the
 * whole run averages across regimes that never coexisted. The result panel says so and points at
 * the time series instead.
 */
export const ArrivalFields = ({
  arrival: a,
  durationSec,
  onChange,
}: {
  arrival: ArrivalProcess
  durationSec: number
  onChange(next: ArrivalProcess): void
}) => {
  const timeVarying = isTimeVarying(a)
  const patch = (fn: (draft: ArrivalProcess) => void) => {
    const draft = structuredClone(a)
    fn(draft)
    onChange(draft)
  }

  return (
    <>
      <Field label="profile">
        <Select
          value={a.kind}
          options={[
            { value: "poisson" as const, label: "poisson (independent users)" },
            { value: "deterministic" as const, label: "deterministic (paced)" },
            { value: "ramp" as const, label: "ramp (find the limit)" },
            { value: "spike" as const, label: "spike (burst + recovery)" },
            { value: "steps" as const, label: "steps" },
          ]}
          onChange={(kind) => onChange(retarget(a, kind, durationSec))}
        />
      </Field>

      {(a.kind === "poisson" || a.kind === "deterministic") && (
        <>
          <Field label="rate" hint="req/s">
            <NumberInput
              value={a.ratePerSec}
              min={0.1}
              step={10}
              onChange={(v) =>
                patch((d) => {
                  if (d.kind === "poisson" || d.kind === "deterministic") d.ratePerSec = Math.max(0.1, v)
                })
              }
            />
          </Field>
          <p className="note">
            Poisson arrivals are burstier than a fixed rate at the same average, and burstiness alone lengthens
            queues. A deterministic source is the best-case workload, not a neutral one.
          </p>
        </>
      )}

      {a.kind === "ramp" && (
        <>
          <FieldRow>
            <Field label="from" hint="req/s">
              <NumberInput
                value={a.fromRatePerSec}
                min={0}
                step={10}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "ramp") d.fromRatePerSec = Math.max(0, v)
                  })
                }
              />
            </Field>
            <Field label="to" hint="req/s">
              <NumberInput
                value={a.toRatePerSec}
                min={0.1}
                step={10}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "ramp") d.toRatePerSec = Math.max(0.1, v)
                  })
                }
              />
            </Field>
          </FieldRow>
          <p className="note">
            A load test in one run: the offered rate rises steadily and the first SLO breach marks the limit. It
            reads slightly <b>high</b> against a steady-state search, because queues take time to fill and the
            system is always catching up with a load that has already moved on &mdash; the same bias a live load
            test has. Set warm-up to 0; there is no steady state for it to reach.
          </p>
        </>
      )}

      {a.kind === "spike" && (
        <>
          <FieldRow>
            <Field label="base" hint="req/s">
              <NumberInput
                value={a.baseRatePerSec}
                min={0.1}
                step={10}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "spike") d.baseRatePerSec = Math.max(0.1, v)
                  })
                }
              />
            </Field>
            <Field label="peak" hint="req/s">
              <NumberInput
                value={a.peakRatePerSec}
                min={0.1}
                step={10}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "spike") d.peakRatePerSec = Math.max(0.1, v)
                  })
                }
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="starts at" hint="s">
              <NumberInput
                value={a.atSec}
                min={0}
                step={10}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "spike") d.atSec = Math.max(0, v)
                  })
                }
              />
            </Field>
            <Field label="lasts" hint="s">
              <NumberInput
                value={a.durationSec}
                min={1}
                step={5}
                onChange={(v) =>
                  patch((d) => {
                    if (d.kind === "spike") d.durationSec = Math.max(1, v)
                  })
                }
              />
            </Field>
          </FieldRow>
          <p className="note">
            Leave room after the burst: <b>recovery is usually the more interesting half</b>. A queue built during
            a spike keeps hurting requests that arrive after it has passed, so a design can survive the spike
            itself and still spend minutes catching up.
            {a.atSec + a.durationSec >= durationSec && (
              <>
                {" "}
                <b className="warn-text">This spike runs to the end of the run, so recovery is never observed.</b>
              </>
            )}
          </p>
        </>
      )}

      {a.kind === "steps" && (
        <>
          <Field label="initial rate" hint="req/s">
            <NumberInput
              value={a.ratePerSec}
              min={0.1}
              step={10}
              onChange={(v) =>
                patch((d) => {
                  if (d.kind === "steps") d.ratePerSec = Math.max(0.1, v)
                })
              }
            />
          </Field>
          {a.steps.map((step, i) => (
            <div className="class-editor" key={i}>
              <div className="class-editor-head">
                <strong>step {i + 1}</strong>
                <IconButton
                  label={`Remove workload step ${i + 1}`}
                  tone="danger"
                  size="sm"
                  onClick={() => patch((d) => { if (d.kind === "steps") d.steps.splice(i, 1) })}
                >
                  <TrashIcon size={14} />
                </IconButton>
              </div>
              <div className="class-editor-row">
                <Field label="starts at" hint="s">
                  <NumberInput
                    value={step.atSec}
                    min={0}
                    step={10}
                    onChange={(v) =>
                      patch((d) => {
                        const st = d.kind === "steps" ? d.steps[i] : undefined
                        if (st) st.atSec = Math.max(0, v)
                      })
                    }
                  />
                </Field>
                <Field label="rate" hint="req/s">
                  <NumberInput
                    value={step.ratePerSec}
                    min={0.1}
                    step={10}
                    onChange={(v) =>
                      patch((d) => {
                        const st = d.kind === "steps" ? d.steps[i] : undefined
                        if (st) st.ratePerSec = Math.max(0.1, v)
                      })
                    }
                  />
                </Field>
              </div>
            </div>
          ))}
          <button
            className="btn small with-icon"
            onClick={() =>
              patch((d) => {
                if (d.kind === "steps") d.steps.push({ atSec: Math.round(durationSec * 0.5), ratePerSec: d.ratePerSec * 2 })
              })
            }
          >
            <PlusIcon size={13} />
            add step
          </button>
        </>
      )}

      {timeVarying && (
        <p className="note warn">
          With load varying over the run there is no steady state, so a single p99 averages across regimes that
          never coexisted. Read the time series and the first-breach figure instead.
        </p>
      )}
    </>
  )
}

/**
 * One line, always visible: what arrives, and whether anyone has said so yet.
 *
 * The placeholder badge is the fix for the 50 req/s trap. A fresh project runs at a rate nobody
 * chose, and the first run locks it in for every version. Saying "placeholder" next to the number
 * until a person or the agent sets it is the cheapest way to make that visible before it matters.
 */
export const WorkloadRow = ({ study }: { study: Study }) => {
  const updateContract = useStudyStore((s) => s.updateContract)
  const open = useStudyStore((s) => s.workloadEditOpen)
  const setOpen = useStudyStore((s) => s.setWorkloadEditOpen)
  const touched = useStudyStore(
    (s) => s.agentAttention?.scope === "study" && s.agentAttention.changedPaths.some((path) => path.startsWith("workload"))
  )
  const rowRef = useRef<HTMLElement>(null)
  const placeholder = isPlaceholderWorkload(study.workload)

  useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: "nearest" })
  }, [open])

  return (
    <section ref={rowRef} className={`section workload-row ${touched ? "agent-touched" : ""}`} aria-label="Workload">
      <header className="section-head">
        <h2>workload</h2>
        <span className="workload-summary tnum">{describeArrival(study.workload.arrival)}</span>
        {placeholder && (
          <span className="badge badge-warn" title="Nobody has set the arrival yet. The first run locks this rate in for every version.">
            placeholder
          </span>
        )}
        <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "done" : "set"}
        </button>
      </header>
      {open && (
        <div className="workload-fields">
          <ArrivalFields
            arrival={study.workload.arrival}
            durationSec={study.workload.durationSec}
            onChange={(arrival) => updateContract({ workload: { arrival } })}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Request classes, on the project.
 *
 * The dimension that makes "3% of traffic hits the expensive endpoint" expressible. With no
 * classes declared, a single implicit class carries everything.
 */
const ClassFields = ({ study }: { study: Study }) => {
  const updateContract = useStudyStore((s) => s.updateContract)
  const edit = useStudio((s) => s.edit)
  const classes = study.workload.classes
  const totalWeight = classes.reduce((sum, c) => sum + c.weight, 0)

  const setClasses = (next: typeof classes) => {
    updateContract({ workload: { classes: next } })
    // The sync keeps a version's own classes when the project declares none, so an emptied list
    // has to be cleared on the drawing too, or the last class would linger.
    if (next.length === 0) edit((d) => void (d.classes = []))
  }
  const replace = (i: number, patch: Partial<(typeof classes)[number]>) =>
    setClasses(classes.map((c, k) => (k === i ? { ...c, ...patch } : c)))

  return (
    <>
      <p className="muted advanced-sub">request classes</p>
      {classes.length === 0 ? (
        <p className="note">All traffic shares one route. Add classes for separate paths, such as reads and writes.</p>
      ) : (
        classes.map((c, i) => (
          <div className="class-editor" key={c.id}>
            <div className="class-editor-head">
              <input className="input" value={c.label} onChange={(e) => replace(i, { label: e.target.value })} />
              <IconButton
                label={`Remove class ${c.label}`}
                tone="danger"
                size="sm"
                onClick={() => {
                  setClasses(classes.filter((_, k) => k !== i))
                  // Connections restricted to a deleted class would become unroutable.
                  edit((d) => {
                    for (const e of d.edges) e.classes = e.classes.filter((x) => x !== c.id)
                  })
                }}
              >
                <TrashIcon size={14} />
              </IconButton>
            </div>
            <div className="class-editor-row">
              <Field label="weight" hint={`${((c.weight / totalWeight) * 100).toFixed(0)}% of traffic`}>
                <NumberInput value={c.weight} min={0.1} step={0.5} onChange={(v) => replace(i, { weight: Math.max(0.1, v) })} />
              </Field>
              <Field label="cost" hint="× service time">
                <NumberInput
                  value={c.serviceMultiplier}
                  min={0.1}
                  step={0.5}
                  onChange={(v) => replace(i, { serviceMultiplier: Math.max(0.1, v) })}
                />
              </Field>
            </div>
          </div>
        ))
      )}
      <button
        className="btn small with-icon"
        onClick={() => {
          const n = classes.length
          setClasses([
            ...classes,
            { id: `class${n + 1}`, label: n === 0 ? "reads" : n === 1 ? "writes" : `class ${n + 1}`, weight: 1, serviceMultiplier: 1 },
          ])
        }}
      >
        <PlusIcon size={13} />
        add class
      </button>
    </>
  )
}

/** "limits 4 · 1 · 100k, run 1200 s, 8 seeds, no SLO": the folded values, so nothing is hidden, only folded. */
export const advancedSummary = (study: Study): string => {
  const b = study.correctness.bounds
  const w = study.workload
  const slo = study.targets.slo
  const states = b.states >= 1000 ? `${Math.round(b.states / 1000)}k` : String(b.states)
  const sloText =
    slo.p99LatencyMs === null && slo.maxErrorRatePct === null
      ? "no SLO"
      : [slo.p99LatencyMs !== null ? `p99 ${slo.p99LatencyMs} ms` : "", slo.maxErrorRatePct !== null ? `errors \u2264 ${slo.maxErrorRatePct}%` : ""]
          .filter(Boolean)
          .join(", ")
  return `limits ${b.actors} \u00b7 ${b.faults} \u00b7 ${states}, run ${w.durationSec} s, ${w.seeds.length} seed${w.seeds.length === 1 ? "" : "s"}, ${sloText}`
}

/**
 * Everything project-level that is not needed every minute, folded.
 *
 * Search limits size every claim the race search makes; run length, warm-up and seeds size every
 * load figure; the SLO is the bar. All of them are the yardstick, so all of them write the project
 * contract and lock with it.
 */
export const AdvancedSettings = ({ study, children }: { study: Study; children?: React.ReactNode }) => {
  const updateContract = useStudyStore((s) => s.updateContract)
  const touched = useStudyStore(
    (s) =>
      s.agentAttention?.scope === "study" &&
      s.agentAttention.changedPaths.some((path) => path.startsWith("correctness.bounds") || path.startsWith("targets"))
  )
  const b = study.correctness.bounds
  const w = study.workload
  const slo = study.targets.slo

  const setBounds = (patch: Partial<typeof b>) => updateContract({ correctness: { ...study.correctness, bounds: { ...b, ...patch } } })
  const setWorkload = (patch: Partial<typeof w>) => updateContract({ workload: patch })
  const setSlo = (patch: Partial<typeof slo>) => updateContract({ targets: { ...study.targets, slo: { ...slo, ...patch } } })

  return (
    <DensitySection
      title="advanced project controls"
      summary={advancedSummary(study)}
      className={`section advanced ${touched ? "agent-touched" : ""}`}
    >

      <p className="muted advanced-sub">search limits</p>
      <label>
        concurrent requests
        <input type="number" min={1} max={6} value={b.actors} onChange={(e) => setBounds({ actors: Number(e.target.value) })} />
      </label>
      <p className="muted">Each extra request multiplies the orderings to explore.</p>
      <label>
        injected faults per run
        <input type="number" min={0} max={4} value={b.faults} onChange={(e) => setBounds({ faults: Number(e.target.value) })} />
      </label>
      <label>
        steps per run
        <input type="number" min={1} max={500} value={b.transitions} onChange={(e) => setBounds({ transitions: Number(e.target.value) })} />
      </label>
      <label>
        state cap
        <input type="number" min={100} step={1000} value={b.states} onChange={(e) => setBounds({ states: Number(e.target.value) })} />
      </label>
      <p className="muted">Hitting a limit makes the answer inconclusive, never "safe".</p>
      {children}

      <p className="muted advanced-sub">run under load</p>
      <FieldRow>
        <Field label="duration" hint="s">
          <NumberInput value={w.durationSec} min={1} step={60} onChange={(v) => setWorkload({ durationSec: Math.max(1, v) })} />
        </Field>
        <Field label="warm-up" hint="s">
          <NumberInput value={w.warmupSec} min={0} step={10} onChange={(v) => setWorkload({ warmupSec: Math.max(0, v) })} />
        </Field>
        <Field label="seeds">
          <NumberInput
            value={w.seeds.length}
            min={1}
            max={64}
            onChange={(v) => setWorkload({ seeds: Array.from({ length: Math.min(64, Math.max(1, Math.round(v))) }, (_, i) => i + 1) })}
          />
        </Field>
      </FieldRow>
      <Field label="trace events retained" hint="0 = metrics only">
        <NumberInput
          value={w.traceLimit}
          min={0}
          step={1000}
          onChange={(v) => setWorkload({ traceLimit: Math.max(0, Math.round(v)) })}
        />
      </Field>
      <p className="note">
        Warm-up removes startup bias. Longer runs improve accuracy near saturation. One seed is an anecdote; every
        version runs the same seeds, so a difference between two is not a difference between two workloads.
      </p>

      <p className="muted advanced-sub">slo</p>
      <FieldRow>
        <Field label="p99 target" hint="ms · blank = none">
          <NullableNumberInput
            value={slo.p99LatencyMs}
            min={0.01}
            step={10}
            placeholder="none"
            onChange={(v) => setSlo({ p99LatencyMs: v })}
          />
        </Field>
        <Field label="max errors" hint="% · blank = none">
          <NullableNumberInput
            value={slo.maxErrorRatePct}
            min={0}
            max={100}
            step={0.1}
            placeholder="none"
            onChange={(v) => setSlo({ maxErrorRatePct: v })}
          />
        </Field>
      </FieldRow>

      <ClassFields study={study} />
    </DensitySection>
  )
}

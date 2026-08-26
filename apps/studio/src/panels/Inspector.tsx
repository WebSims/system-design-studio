import type { Distribution } from "@sds/schema";
import { useStudio } from "../store";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      className="input tnum"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

/**
 * Service-time editor.
 *
 * Parameterised by the numbers an engineer actually has. A lognormal is described
 * by its mean and p99, not by the mu and sigma of the underlying normal -- asking
 * for the latter is asking someone to do algebra to describe their own service.
 * The conversion lives in `lognormalFromMeanP99`.
 */
function DistributionEditor({
  value,
  onChange,
}: {
  value: Distribution;
  onChange: (d: Distribution) => void;
}) {
  return (
    <div className="dist-editor">
      <Field label="distribution">
        <select
          className="input"
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as Distribution["kind"];
            const m = value.kind === "deterministic" ? value.value : "mean" in value ? value.mean : 20;
            switch (kind) {
              case "deterministic":
                return onChange({ kind, value: m });
              case "exponential":
                return onChange({ kind, mean: m });
              case "lognormal":
                return onChange({ kind, mean: m, p99: m * 5 });
              case "uniform":
                return onChange({ kind, min: m * 0.5, max: m * 1.5 });
              case "pareto":
                return onChange({ kind, scale: m * 0.7, alpha: 3 });
            }
          }}
        >
          <option value="deterministic">deterministic</option>
          <option value="exponential">exponential</option>
          <option value="lognormal">lognormal</option>
          <option value="uniform">uniform</option>
          <option value="pareto">pareto</option>
        </select>
      </Field>

      {value.kind === "deterministic" && (
        <Field label="value" hint="ms">
          <NumberInput value={value.value} min={0} onChange={(v) => onChange({ ...value, value: v })} />
        </Field>
      )}
      {value.kind === "exponential" && (
        <Field label="mean" hint="ms">
          <NumberInput value={value.mean} min={0.01} step={0.5} onChange={(v) => onChange({ ...value, mean: Math.max(0.01, v) })} />
        </Field>
      )}
      {value.kind === "lognormal" && (
        <>
          <Field label="mean" hint="ms">
            <NumberInput value={value.mean} min={0.01} step={0.5} onChange={(v) => onChange({ ...value, mean: Math.max(0.01, v) })} />
          </Field>
          <Field label="p99" hint="ms">
            <NumberInput value={value.p99} min={value.mean} step={1} onChange={(v) => onChange({ ...value, p99: Math.max(value.mean, v) })} />
          </Field>
        </>
      )}
      {value.kind === "uniform" && (
        <>
          <Field label="min" hint="ms">
            <NumberInput value={value.min} min={0} onChange={(v) => onChange({ ...value, min: v })} />
          </Field>
          <Field label="max" hint="ms">
            <NumberInput value={value.max} min={value.min} onChange={(v) => onChange({ ...value, max: v })} />
          </Field>
        </>
      )}
      {value.kind === "pareto" && (
        <>
          <Field label="scale" hint="ms">
            <NumberInput value={value.scale} min={0.01} onChange={(v) => onChange({ ...value, scale: Math.max(0.01, v) })} />
          </Field>
          <Field label="alpha" hint="tail index">
            <NumberInput value={value.alpha} min={0.1} step={0.1} onChange={(v) => onChange({ ...value, alpha: Math.max(0.1, v) })} />
          </Field>
        </>
      )}
    </div>
  );
}

export function Inspector() {
  const selection = useStudio((s) => s.selection);
  const design = useStudio((s) => s.design);
  const preview = useStudio((s) => s.preview);
  const edit = useStudio((s) => s.edit);

  if (!selection) {
    return (
      <aside className="rail right">
        <div className="rail-title">inspector</div>
        <div className="empty">
          select a node or connection to edit its behaviour
          <div className="empty-sub">
            drag from a node's right edge to another node's left edge to connect them
          </div>
        </div>
        <ScenarioEditor />
      </aside>
    );
  }

  if (selection.kind === "edge") {
    const edge = design.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    return (
      <aside className="rail right">
        <div className="rail-title">connection</div>
        <div className="section">network latency</div>
        <DistributionEditor
          value={edge.latency}
          onChange={(latency) =>
            edit((d) => {
              const e = d.edges.find((x) => x.id === selection.id);
              if (e) e.latency = latency;
            })
          }
        />
        <div className="section">loss</div>
        <Field label="drop probability" hint="%">
          <NumberInput
            value={Math.round(edge.lossProbability * 1000) / 10}
            min={0}
            max={100}
            step={0.1}
            onChange={(v) =>
              edit((d) => {
                const e = d.edges.find((x) => x.id === selection.id);
                if (e) e.lossProbability = Math.min(1, Math.max(0, v / 100));
              })
            }
          />
        </Field>
        <p className="note">
          Without transport-level retry, which arrives in Phase 3, a dropped message
          is reported as a failure rather than stalling until a timeout. Loss above a
          few percent will therefore understate real latency.
        </p>
        <button
          className="btn danger"
          onClick={() =>
            edit((d) => {
              d.edges = d.edges.filter((x) => x.id !== selection.id);
            })
          }
        >
          delete connection
        </button>
        <ScenarioEditor />
      </aside>
    );
  }

  const node = design.nodes.find((n) => n.id === selection.id);
  if (!node) return null;
  const nodePreview = preview.nodes.find((n) => n.nodeId === node.id);

  return (
    <aside className="rail right">
      <div className="rail-title">{node.kind}</div>

      <Field label="label">
        <input
          className="input"
          value={node.label}
          onChange={(e) =>
            edit((d) => {
              const n = d.nodes.find((x) => x.id === selection.id);
              if (n) n.label = e.target.value;
            })
          }
        />
      </Field>

      {node.kind === "client" && node.client && (
        <>
          <div className="section">arrival process</div>
          <Field
            label="process"
            hint={node.client.arrival.kind === "poisson" ? "independent users" : "perfectly paced"}
          >
            <select
              className="input"
              value={node.client.arrival.kind}
              onChange={(e) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.client) n.client.arrival.kind = e.target.value as "poisson" | "deterministic";
                })
              }
            >
              <option value="poisson">poisson</option>
              <option value="deterministic">deterministic</option>
            </select>
          </Field>
          <Field label="rate" hint="req/s">
            <NumberInput
              value={node.client.arrival.ratePerSec}
              min={0.1}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.client) n.client.arrival.ratePerSec = Math.max(0.1, v);
                })
              }
            />
          </Field>
          <p className="note">
            Poisson arrivals are burstier than a fixed rate at the same average, and
            burstiness alone lengthens queues. A deterministic source is the
            best-case workload, not a neutral one.
          </p>

          <div className="section">client timeout</div>
          <Field label="deadline" hint="ms, 0 = none">
            <NumberInput
              value={node.client.timeoutMs ?? 0}
              min={0}
              step={10}
              onChange={(v) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.client) n.client.timeoutMs = v <= 0 ? null : v;
                })
              }
            />
          </Field>
        </>
      )}

      {node.kind === "server" && node.server && (
        <>
          <div className="section">capacity</div>
          <Field label="concurrency" hint="in service at once">
            <NumberInput
              value={node.server.concurrency}
              min={1}
              onChange={(v) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.server) n.server.concurrency = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>
          <Field label="replicas" hint="identical instances">
            <NumberInput
              value={node.server.replicas}
              min={1}
              onChange={(v) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.server) n.server.replicas = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>

          <div className="section">service time</div>
          <DistributionEditor
            value={node.server.serviceTime}
            onChange={(serviceTime) =>
              edit((d) => {
                const n = d.nodes.find((x) => x.id === selection.id);
                if (n?.server) n.server.serviceTime = serviceTime;
              })
            }
          />
          {nodePreview && (
            <p className="note">
              Variability Cs&sup2; = <b className="tnum">{nodePreview.serviceScv.toFixed(2)}</b>.
              Queueing delay scales with (1 + Cs&sup2;), so at equal mean this service
              queues{" "}
              <b className="tnum">
                {((1 + nodePreview.serviceScv) / 2).toFixed(2)}&times;
              </b>{" "}
              as badly as a deterministic one.
            </p>
          )}

          <div className="section">queue</div>
          <Field label="capacity" hint="0 = unbounded">
            <NumberInput
              value={node.server.queueCapacity ?? 0}
              min={0}
              onChange={(v) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.server) n.server.queueCapacity = v <= 0 ? null : Math.round(v);
                })
              }
            />
          </Field>
          <Field label="when full">
            <select
              className="input"
              value={node.server.admissionPolicy}
              disabled={node.server.queueCapacity === null}
              onChange={(e) =>
                edit((d) => {
                  const n = d.nodes.find((x) => x.id === selection.id);
                  if (n?.server) n.server.admissionPolicy = e.target.value as "shed" | "block";
                })
              }
            >
              <option value="shed">shed (reject)</option>
              <option value="block">block (wait anyway)</option>
            </select>
          </Field>
          <p className="note">
            Shedding trades errors for bounded latency: an overloaded station with a
            bounded queue still has a steady state. Blocking in an open-loop system
            makes the bound advisory, since there is no upstream buffer to push back
            against.
          </p>

          {nodePreview && (
            <div className="model-badge">
              solved as <b>{nodePreview.model}</b>
              {nodePreview.approximate && <span className="approx">approximate</span>}
            </div>
          )}
        </>
      )}

      <ScenarioEditor />
    </aside>
  );
}

function ScenarioEditor() {
  const scenario = useStudio((s) => s.design.scenario);
  const slo = useStudio((s) => s.design.slo);
  const edit = useStudio((s) => s.edit);

  return (
    <>
      <div className="section">scenario</div>
      <Field label="duration" hint="simulated s">
        <NumberInput
          value={scenario.durationSec}
          min={1}
          step={60}
          onChange={(v) =>
            edit((d) => {
              d.scenario.durationSec = Math.max(1, v);
            })
          }
        />
      </Field>
      <Field label="warm-up" hint="discarded s">
        <NumberInput
          value={scenario.warmupSec}
          min={0}
          step={10}
          onChange={(v) =>
            edit((d) => {
              d.scenario.warmupSec = Math.max(0, v);
            })
          }
        />
      </Field>
      <Field label="seed" hint="reproducibility">
        <NumberInput
          value={scenario.seed}
          min={0}
          onChange={(v) =>
            edit((d) => {
              d.scenario.seed = Math.max(0, Math.round(v));
            })
          }
        />
      </Field>
      <p className="note">
        A queueing system starts empty, which is not its steady state, so the warm-up
        window is discarded before measuring. Duration matters more than it looks:
        the samples needed for a given accuracy scale as 1/(1&minus;&rho;)&sup2;, so a
        short run is noisiest at exactly the utilizations worth studying.
      </p>

      <div className="section">slo</div>
      <Field label="p99 target" hint="ms, 0 = none">
        <NumberInput
          value={slo.p99LatencyMs ?? 0}
          min={0}
          step={10}
          onChange={(v) =>
            edit((d) => {
              d.slo.p99LatencyMs = v <= 0 ? null : v;
            })
          }
        />
      </Field>
      <Field label="max errors" hint="%, 0 = none">
        <NumberInput
          value={slo.maxErrorRatePct ?? 0}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.slo.maxErrorRatePct = v <= 0 ? null : v;
            })
          }
        />
      </Field>
    </>
  );
}

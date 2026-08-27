import { citationText } from "@sds/models";
import { isTimeVarying, type ArrivalProcess, type Citation, type Distribution, type RetryableReason } from "@sds/schema";
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

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className={`toggle-row ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span className="toggle-switch">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-body">
        <span>{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </button>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Provenance for a preset's numbers.
 *
 * Rendered wherever a component carries a citation. The legacy engine's constants
 * were a bare table -- a server took 34ms because `PROCMS.server = 34` -- and a
 * reader had no way to tell whether that was measured, remembered, or invented.
 * For output meant to survive a design review, an un-sourced constant is a
 * liability, so the source travels with the number.
 */
function CitationNote({ citation }: { citation: Citation | undefined }) {
  if (!citation) return null;
  return (
    <p className="citation">
      <b>source</b> {citationText(citation)}
      <br />
      <span className="citation-warn">
        A starting point, not a measurement of your system. Paste a figure from your own
        dashboard and it beats anything shipped here.
      </span>
    </p>
  );
}

/**
 * Service-time editor.
 *
 * Parameterised by the numbers an engineer actually has. A lognormal is described
 * by its mean and p99, not by the mu and sigma of the underlying normal -- asking
 * for the latter is asking someone to do algebra to describe their own service.
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
            const m =
              value.kind === "deterministic"
                ? value.value
                : "mean" in value
                  ? value.mean
                  : "scale" in value
                    ? value.scale
                    : 20;
            switch (kind) {
              case "deterministic":
                return onChange({ kind, value: m });
              case "exponential":
                return onChange({ kind, mean: Math.max(0.01, m) });
              case "lognormal":
                return onChange({ kind, mean: Math.max(0.01, m), p99: Math.max(0.02, m * 5) });
              case "uniform":
                return onChange({ kind, min: m * 0.5, max: m * 1.5 });
              case "pareto":
                return onChange({ kind, scale: Math.max(0.01, m * 0.7), alpha: 3 });
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
          <NumberInput value={value.value} min={0} step={0.1} onChange={(v) => onChange({ ...value, value: Math.max(0, v) })} />
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
            <NumberInput value={value.min} min={0} step={0.5} onChange={(v) => onChange({ ...value, min: Math.max(0, v) })} />
          </Field>
          <Field label="max" hint="ms">
            <NumberInput value={value.max} min={value.min} step={0.5} onChange={(v) => onChange({ ...value, max: Math.max(value.min, v) })} />
          </Field>
        </>
      )}
      {value.kind === "pareto" && (
        <>
          <Field label="scale" hint="ms">
            <NumberInput value={value.scale} min={0.01} step={0.5} onChange={(v) => onChange({ ...value, scale: Math.max(0.01, v) })} />
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
        <ClassEditor />
        <ScenarioEditor />
      </aside>
    );
  }

  if (selection.kind === "edge") {
    const edge = design.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    const patch = (fn: (e: NonNullable<typeof edge>) => void) =>
      edit((d) => {
        const e = d.edges.find((x) => x.id === selection.id);
        if (e) fn(e);
      });

    return (
      <aside className="rail right">
        <div className="rail-title">connection</div>

        <div className="section">network latency</div>
        <DistributionEditor value={edge.latency} onChange={(latency) => patch((e) => { e.latency = latency; })} />
        <p className="note">
          <b>One way.</b> A request and its response each cross the wire, so this is applied
          twice per call. Entering a round-trip figure would double-count it.
        </p>

        <div className="section">routing</div>
        <Field label="probability" hint="% of requests">
          <NumberInput
            value={Math.round(edge.probability * 1000) / 10}
            min={0}
            max={100}
            step={1}
            onChange={(v) => patch((e) => { e.probability = Math.min(1, Math.max(0, v / 100)); })}
          />
        </Field>
        <Field label="fan-out" hint="calls per message">
          <NumberInput
            value={edge.fanoutFactor}
            min={1}
            onChange={(v) => patch((e) => { e.fanoutFactor = Math.max(1, Math.round(v)); })}
          />
        </Field>
        {edge.fanoutFactor > 1 && (
          <p className="note warn">
            One call becomes <b className="tnum">{edge.fanoutFactor}</b> downstream calls. In a
            realtime design this is the largest capacity decision there is &mdash; a chat message
            to a room of {edge.fanoutFactor} is one request and {edge.fanoutFactor} deliveries, so
            sizing on message rate understates delivery work by{" "}
            <b className="tnum">{edge.fanoutFactor}&times;</b>. Room size is a product decision
            that rarely appears in a capacity estimate.
          </p>
        )}

        <Field label="lb weight" hint="relative share">
          <NumberInput
            value={edge.weight}
            min={0.1}
            step={0.1}
            onChange={(v) => patch((e) => { e.weight = Math.max(0.1, v); })}
          />
        </Field>
        {design.classes.length > 0 && (
          <>
            <Field label="request classes" hint="none = all">
              <div className="chip-row">
                {design.classes.map((c) => {
                  const on = edge.classes.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      className={`chip ${on ? "on" : ""}`}
                      onClick={() =>
                        patch((e) => {
                          e.classes = on
                            ? e.classes.filter((x) => x !== c.id)
                            : [...e.classes, c.id];
                        })
                      }
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <p className="note">
              Restricting a connection to a class is how "reads go through the cache, writes
              go straight to the database" is expressed.
            </p>
          </>
        )}

        <div className="section">loss</div>
        <Field label="drop probability" hint="% per traversal">
          <NumberInput
            value={Math.round(edge.lossProbability * 1000) / 10}
            min={0}
            max={100}
            step={0.1}
            onChange={(v) => patch((e) => { e.lossProbability = Math.min(1, Math.max(0, v / 100)); })}
          />
        </Field>
        <p className="note">
          Applied per traversal, so a call loses 1&minus;(1&minus;p)&sup2; of requests. Without
          transport-level retry, which arrives in Phase 3, a drop is reported as a failure
          rather than stalling until a timeout.
        </p>

        <PolicyEditor edgeId={selection.id} />

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
        <ClassEditor />
        <ScenarioEditor />
      </aside>
    );
  }

  const node = design.nodes.find((n) => n.id === selection.id);
  if (!node) return null;
  const nodePreview = preview.nodes.find((n) => n.nodeId === node.id);
  const patch = (fn: (n: NonNullable<typeof node>) => void) =>
    edit((d) => {
      const n = d.nodes.find((x) => x.id === selection.id);
      if (n) fn(n);
    });

  return (
    <aside className="rail right">
      <div className="rail-title">{node.kind}</div>

      <Field label="label">
        <input className="input" value={node.label} onChange={(e) => patch((n) => { n.label = e.target.value; })} />
      </Field>

      {node.kind === "client" && node.client && (
        <>
          <ArrivalEditor nodeId={node.id} />

          <div className="section">client timeout</div>
          <Field label="deadline" hint="ms, 0 = none">
            <NumberInput
              value={node.client.timeoutMs ?? 0}
              min={0}
              step={50}
              onChange={(v) => patch((n) => { if (n.client) n.client.timeoutMs = v <= 0 ? null : v; })}
            />
          </Field>

          <ConnectionEditor nodeId={node.id} />
        </>
      )}

      {node.kind === "loadbalancer" && node.loadbalancer && (
        <>
          <div className="section">algorithm</div>
          <Field label="selection">
            <Select
              value={node.loadbalancer.algorithm}
              options={[
                { value: "round-robin" as const, label: "round robin" },
                { value: "random" as const, label: "random (weighted)" },
                { value: "least-connections" as const, label: "least connections" },
                { value: "power-of-two-choices" as const, label: "power of two choices" },
              ]}
              onChange={(v) => patch((n) => { if (n.loadbalancer) n.loadbalancer.algorithm = v; })}
            />
          </Field>
          <p className="note">
            The algorithm matters more than intuition suggests. Random assignment leaves
            maximum load about <b>log n / log log n</b> above average; sampling two backends
            and taking the shorter drops that to <b>log log n</b>. One extra probe buys an
            exponential improvement, and it shows up in the tail rather than the mean.
          </p>

          <div className="section">proxy overhead</div>
          <DistributionEditor
            value={node.loadbalancer.serviceTime}
            onChange={(serviceTime) => patch((n) => { if (n.loadbalancer) n.loadbalancer.serviceTime = serviceTime; })}
          />
          <Field label="concurrency" hint="connections">
            <NumberInput
              value={node.loadbalancer.concurrency}
              min={1}
              step={64}
              onChange={(v) => patch((n) => { if (n.loadbalancer) n.loadbalancer.concurrency = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <div className="section">health checking</div>
          <Toggle
            label={node.loadbalancer.healthCheck.enabled ? "outlier detection on" : "outlier detection off"}
            hint={
              node.loadbalancer.healthCheck.enabled
                ? `ejects above ${(node.loadbalancer.healthCheck.failureThreshold * 100).toFixed(0)}% failures`
                : "a broken backend keeps its full share forever"
            }
            on={node.loadbalancer.healthCheck.enabled}
            onChange={(v) => patch((n) => { if (n.loadbalancer) n.loadbalancer.healthCheck.enabled = v; })}
          />
          {node.loadbalancer.healthCheck.enabled && (
            <>
              <Field label="failure threshold" hint="%">
                <NumberInput
                  value={Math.round(node.loadbalancer.healthCheck.failureThreshold * 1000) / 10}
                  min={1}
                  max={100}
                  step={5}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.loadbalancer) {
                        n.loadbalancer.healthCheck.failureThreshold = Math.min(1, Math.max(0.01, v / 100));
                      }
                    })
                  }
                />
              </Field>
              <Field label="ejection time" hint="ms">
                <NumberInput
                  value={node.loadbalancer.healthCheck.ejectionMs}
                  min={100}
                  step={1000}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.loadbalancer) n.loadbalancer.healthCheck.ejectionMs = Math.max(100, v);
                    })
                  }
                />
              </Field>
              <Field label="max ejected" hint="% of backends">
                <NumberInput
                  value={Math.round(node.loadbalancer.healthCheck.maxEjectedFraction * 1000) / 10}
                  min={0}
                  max={100}
                  step={10}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.loadbalancer) {
                        n.loadbalancer.healthCheck.maxEjectedFraction = Math.min(1, Math.max(0, v / 100));
                      }
                    })
                  }
                />
              </Field>
              <p className="note">
                Passive: health is inferred from real traffic, not a probe endpoint &mdash; which
                is both what proxies actually do and more honest, since a probe frequently
                reports healthy while real requests fail. The ejection cap matters: under a
                shared failure every backend looks unhealthy at once, and ejecting them all
                removes the capacity that was still partly working.
              </p>
            </>
          )}

          <CitationNote citation={node.loadbalancer.citation} />
        </>
      )}

      {node.kind === "server" && node.server && (
        <>
          <div className="section">capacity</div>
          <Field label="concurrency" hint="per replica">
            <NumberInput
              value={node.server.concurrency}
              min={1}
              onChange={(v) => patch((n) => { if (n.server) n.server.concurrency = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <Field label="replicas" hint="identical instances">
            <NumberInput
              value={node.server.replicas}
              min={1}
              onChange={(v) => patch((n) => { if (n.server) n.server.replicas = Math.max(1, Math.round(v)); })}
            />
          </Field>

          <div className="section">own work</div>
          <DistributionEditor
            value={node.server.serviceTime}
            onChange={(serviceTime) => patch((n) => { if (n.server) n.server.serviceTime = serviceTime; })}
          />
          <p className="note">
            This is CPU work only, excluding calls to dependencies. Those are modelled as
            the connections leaving this node.
          </p>
          {nodePreview && (
            <p className="note">
              Variability Cs&sup2; = <b className="tnum">{nodePreview.serviceScv.toFixed(2)}</b>.
              Queueing delay scales with (1 + Cs&sup2;), so at equal mean this service queues{" "}
              <b className="tnum">{((1 + nodePreview.serviceScv) / 2).toFixed(2)}&times;</b> as
              badly as a deterministic one.
            </p>
          )}

          <div className="section">concurrency model</div>
          <Field label="dependency calls">
            <Select
              value={node.server.blocksOnDependencies ? "blocking" : "async"}
              options={[
                { value: "blocking", label: "blocking (thread per request)" },
                { value: "async", label: "non-blocking (async runtime)" },
              ]}
              onChange={(v) => patch((n) => { if (n.server) n.server.blocksOnDependencies = v === "blocking"; })}
            />
          </Field>
          <p className="note">
            {node.server.blocksOnDependencies ? (
              <>
                A worker stays occupied for the whole downstream call. This is how a slow
                dependency exhausts its caller's pool and a local slowdown becomes a
                system-wide outage.
                {nodePreview && nodePreview.effectiveServiceMeanMs > nodePreview.ownServiceMeanMs * 1.2 && (
                  <>
                    {" "}
                    Here a slot is held for{" "}
                    <b className="tnum">{nodePreview.effectiveServiceMeanMs.toFixed(1)}ms</b> against{" "}
                    <b className="tnum">{nodePreview.ownServiceMeanMs.toFixed(1)}ms</b> of own work.
                  </>
                )}
              </>
            ) : (
              <>
                The slot covers only this station's own work, so its capacity is independent of
                dependency latency. A chain of non-blocking stations is a Jackson network and is
                solvable exactly.
              </>
            )}
          </p>

          <Field label="fan-out">
            <Select
              value={node.server.fanout}
              options={[
                { value: "parallel" as const, label: "parallel (fork-join)" },
                { value: "sequential" as const, label: "sequential" },
              ]}
              onChange={(v) => patch((n) => { if (n.server) n.server.fanout = v; })}
            />
          </Field>
          <p className="note">
            Parallel costs the slowest dependency; sequential costs their sum. Only relevant
            when this node calls more than one dependency for a single request class.
          </p>

          <div className="section">failure injection</div>
          <Field label="failure rate" hint="%">
            <NumberInput
              value={Math.round(node.server.failureProbability * 1000) / 10}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch((n) => { if (n.server) n.server.failureProbability = Math.min(1, Math.max(0, v / 100)); })}
            />
          </Field>
          <Field label="at saturation" hint="%, 0 = constant">
            <NumberInput
              value={
                node.server.failureAtSaturation === null
                  ? 0
                  : Math.round(node.server.failureAtSaturation * 1000) / 10
              }
              min={0}
              max={100}
              step={5}
              onChange={(v) =>
                patch((n) => {
                  if (n.server) {
                    n.server.failureAtSaturation = v <= 0 ? null : Math.min(1, v / 100);
                  }
                })
              }
            />
          </Field>
          <p className="note">
            Failures unrelated to load: bugs, bad deploys, a dependency this model does not
            include. Charged <i>after</i> the work is done, because a server that fails still
            consumed the capacity to discover that &mdash; failing for free would make an
            unhealthy dependency look cheap and hide the load a retry storm adds.
          </p>
          <p className={`note ${node.server.failureAtSaturation !== null ? "warn" : ""}`}>
            {node.server.failureAtSaturation === null ? (
              <>
                The rate is <b>constant</b>. Real services fail more when overloaded, and that
                correlation is what gives a cascade positive gain: load raises failures, failures
                raise retries, retries raise load. With a constant rate the loop has no gain and
                the worst outcome is a linear slowdown.
              </>
            ) : (
              <>
                Failure rises from{" "}
                <b className="tnum">{(node.server.failureProbability * 100).toFixed(1)}%</b> when
                idle to{" "}
                <b className="tnum">
                  {(node.server.failureAtSaturation * 100).toFixed(1)}%
                </b>{" "}
                when saturated. This closes the feedback loop &mdash; combine it with unbudgeted
                retries and the design can run away rather than just slow down.
              </>
            )}
          </p>

          <div className="section">queue</div>
          <QueueLimitEditor
            queueCapacity={node.server.queueCapacity}
            admissionPolicy={node.server.admissionPolicy}
            onCapacity={(v) => patch((n) => { if (n.server) n.server.queueCapacity = v; })}
            onPolicy={(v) => patch((n) => { if (n.server) n.server.admissionPolicy = v; })}
          />
          <CitationNote citation={node.server.citation} />
        </>
      )}

      {node.kind === "gateway" && node.gateway && (
        <>
          <div className="section">connections</div>
          <Field label="sockets per instance">
            <NumberInput
              value={node.gateway.connectionCapacity}
              min={1}
              step={1000}
              onChange={(v) =>
                patch((n) => {
                  if (n.gateway) n.gateway.connectionCapacity = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>
          <Field label="instances">
            <NumberInput
              value={node.gateway.replicas}
              min={1}
              onChange={(v) =>
                patch((n) => {
                  if (n.gateway) n.gateway.replicas = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>
          <Field label="memory per socket" hint="KB">
            <NumberInput
              value={node.gateway.memoryPerConnectionKb}
              min={0}
              step={10}
              onChange={(v) =>
                patch((n) => {
                  if (n.gateway) n.gateway.memoryPerConnectionKb = Math.max(0, v);
                })
              }
            />
          </Field>
          <p className="note">
            Total capacity{" "}
            <b className="tnum">
              {(node.gateway.connectionCapacity * node.gateway.replicas).toLocaleString()}
            </b>{" "}
            sockets, about{" "}
            <b className="tnum">
              {(
                (node.gateway.connectionCapacity *
                  node.gateway.replicas *
                  node.gateway.memoryPerConnectionKb) /
                1024
              ).toFixed(0)}{" "}
              MB
            </b>{" "}
            when full. A connection is held for the whole session, so this constrains
            <i> how many users</i> &mdash; nothing to do with throughput. Leave headroom for
            losing an instance: with {node.gateway.replicas} instance
            {node.gateway.replicas === 1 ? "" : "s"}, surviving one failure needs utilization
            below{" "}
            <b className="tnum">
              {node.gateway.replicas > 1
                ? `${((1 - 1 / node.gateway.replicas) * 100).toFixed(0)}%`
                : "n/a"}
            </b>
            .
          </p>

          <div className="section">work pool</div>
          <Field label="slots per instance" hint="event loop">
            <NumberInput
              value={node.gateway.pushConcurrency}
              min={1}
              onChange={(v) =>
                patch((n) => {
                  if (n.gateway) n.gateway.pushConcurrency = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>
          <p className="note">
            Shared between accepting handshakes and pushing messages, because on a real
            gateway they are the same event loop. <b>Keep it small.</b> Push work is CPU-bound
            serialization and socket writes, so the honest figure is single digits per instance
            however many sockets it holds &mdash; and setting it to hundreds is what makes
            fan-out look free.
          </p>

          <div className="section">handshake</div>
          <DistributionEditor
            value={node.gateway.acceptTime}
            onChange={(acceptTime) => patch((n) => { if (n.gateway) n.gateway.acceptTime = acceptTime; })}
          />
          <p className="note">
            Far more expensive than a message: TLS, auth, session setup. That asymmetry is why a
            reconnect storm hurts so much more than an equivalent burst of traffic, and why it
            stalls messages for people who never disconnected.
          </p>

          <div className="section">push</div>
          <DistributionEditor
            value={node.gateway.pushTime}
            onChange={(pushTime) => patch((n) => { if (n.gateway) n.gateway.pushTime = pushTime; })}
          />
          <CitationNote citation={node.gateway.citation} />
        </>
      )}

      {node.kind === "cache" && node.cache && (
        <>
          <div className="section">capacity and keys</div>
          <Field label="entries held" hint="before eviction">
            <NumberInput
              value={node.cache.capacity}
              min={1}
              step={1000}
              onChange={(v) => patch((n) => { if (n.cache) n.cache.capacity = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <Field label="key population">
            <Select
              value={node.cache.keyspace.kind}
              options={[
                { value: "zipf" as const, label: "zipf (derive hit ratio)" },
                { value: "fixed" as const, label: "fixed hit ratio" },
              ]}
              onChange={(v) =>
                patch((n) => {
                  if (!n.cache) return;
                  n.cache.keyspace =
                    v === "zipf"
                      ? { kind: "zipf", keys: 100_000, skew: 0.9 }
                      : { kind: "fixed", hitRatio: 0.8 };
                })
              }
            />
          </Field>
          {node.cache.keyspace.kind === "zipf" ? (
            <>
              <Field label="distinct keys">
                <NumberInput
                  value={node.cache.keyspace.keys}
                  min={1}
                  step={10_000}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.cache?.keyspace.kind === "zipf") {
                        n.cache.keyspace.keys = Math.max(1, Math.round(v));
                      }
                    })
                  }
                />
              </Field>
              <Field label="skew" hint="0 = uniform, ~1 typical">
                <NumberInput
                  value={node.cache.keyspace.skew}
                  min={0}
                  step={0.1}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.cache?.keyspace.kind === "zipf") {
                        n.cache.keyspace.skew = Math.max(0, v);
                      }
                    })
                  }
                />
              </Field>
              <p className="note">
                The hit ratio is an <b>output</b>, not an input: keys are drawn from this
                population and looked up in a real LRU map.
                {nodePreview?.hitRatio !== undefined && (
                  <>
                    {" "}
                    Predicted <b className="tnum">{(nodePreview.hitRatio * 100).toFixed(1)}%</b>{" "}
                    for a perfect cache of this size; LRU lands slightly below.
                  </>
                )}{" "}
                Skew is why caching works at all — without it, a cache holding 10% of the keys
                would serve only 10% of requests.
              </p>
            </>
          ) : (
            <Field label="hit ratio" hint="%">
              <NumberInput
                value={Math.round(node.cache.keyspace.hitRatio * 1000) / 10}
                min={0}
                max={100}
                step={1}
                onChange={(v) =>
                  patch((n) => {
                    if (n.cache?.keyspace.kind === "fixed") {
                      n.cache.keyspace.hitRatio = Math.min(1, Math.max(0, v / 100));
                    }
                  })
                }
              />
            </Field>
          )}

          <Field label="ttl" hint="ms, 0 = none">
            <NumberInput
              value={node.cache.ttlMs ?? 0}
              min={0}
              step={1000}
              onChange={(v) => patch((n) => { if (n.cache) n.cache.ttlMs = v <= 0 ? null : v; })}
            />
          </Field>

          <div className="section">lookup</div>
          <DistributionEditor
            value={node.cache.serviceTime}
            onChange={(serviceTime) => patch((n) => { if (n.cache) n.cache.serviceTime = serviceTime; })}
          />
          <Field label="concurrency" hint="1 = single threaded">
            <NumberInput
              value={node.cache.concurrency}
              min={1}
              onChange={(v) => patch((n) => { if (n.cache) n.cache.concurrency = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <p className="note">
            Read-through: a miss costs a lookup <i>plus</i> the origin call, so a low hit ratio
            makes things worse than no cache, not neutral. The cache does not hold its slot
            during the origin fetch, because in a cache-aside deployment the application
            performs it.
          </p>
          <CitationNote citation={node.cache.citation} />
        </>
      )}

      {node.kind === "database" && node.database && (
        <>
          <div className="section">connections and execution</div>
          <Field label="pool size" hint="connections">
            <NumberInput
              value={node.database.poolSize}
              min={1}
              onChange={(v) => patch((n) => { if (n.database) n.database.poolSize = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <Field label="parallelism" hint="concurrent queries">
            <NumberInput
              value={node.database.parallelism}
              min={1}
              onChange={(v) => patch((n) => { if (n.database) n.database.parallelism = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <p className="note">
            <b>These are different limits.</b> The pool caps connections; parallelism caps what
            the engine actually executes at once (cores, or storage queue depth). Throughput is
            capped at parallelism &divide; service time
            {nodePreview?.database && (
              <>
                {" "}
                = <b className="tnum">{nodePreview.database.maxThroughputPerSec.toFixed(0)}/s</b>
              </>
            )}
            , whatever the pool size. Raising the pool past parallelism moves waiting from pool
            to execution and changes nothing else — which is why "just increase the pool" so
            often does not help.
          </p>

          <div className="section">query time</div>
          <DistributionEditor
            value={node.database.serviceTime}
            onChange={(serviceTime) => patch((n) => { if (n.database) n.database.serviceTime = serviceTime; })}
          />

          <div className="section">failure injection</div>
          <Field label="failure rate" hint="%">
            <NumberInput
              value={Math.round(node.database.failureProbability * 1000) / 10}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch((n) => { if (n.database) n.database.failureProbability = Math.min(1, Math.max(0, v / 100)); })}
            />
          </Field>
          <Field label="at saturation" hint="%, 0 = constant">
            <NumberInput
              value={
                node.database.failureAtSaturation === null
                  ? 0
                  : Math.round(node.database.failureAtSaturation * 1000) / 10
              }
              min={0}
              max={100}
              step={5}
              onChange={(v) =>
                patch((n) => {
                  if (n.database) {
                    n.database.failureAtSaturation = v <= 0 ? null : Math.min(1, v / 100);
                  }
                })
              }
            />
          </Field>
          <p className="note">
            A rate that rises with load closes the feedback loop that turns a slowdown into a
            cascade. Measured from execution occupancy excluding the query itself, so a nearly
            idle database is not charged for being busy with one request.
          </p>

          <div className="section">pool queue</div>
          <QueueLimitEditor
            queueCapacity={node.database.queueCapacity}
            admissionPolicy={node.database.admissionPolicy}
            onCapacity={(v) => patch((n) => { if (n.database) n.database.queueCapacity = v; })}
            onPolicy={(v) => patch((n) => { if (n.database) n.database.admissionPolicy = v; })}
          />
          <CitationNote citation={node.database.citation} />
        </>
      )}

      {node.kind === "queue" && node.queue && (
        <>
          <div className="section">consumers</div>
          <Field label="consumers" hint="drain concurrency">
            <NumberInput
              value={node.queue.consumers}
              min={1}
              onChange={(v) => patch((n) => { if (n.queue) n.queue.consumers = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <div className="section">consumer work</div>
          <DistributionEditor
            value={node.queue.consumerServiceTime}
            onChange={(d) => patch((n) => { if (n.queue) n.queue.consumerServiceTime = d; })}
          />
          {nodePreview?.queue && (
            <p className={`note ${nodePreview.queue.backlogStable ? "" : "warn"}`}>
              Drains at most <b className="tnum">{nodePreview.queue.drainCapacityPerSec.toFixed(0)}/s</b>{" "}
              against <b className="tnum">{nodePreview.arrivalRatePerSec.toFixed(0)}/s</b> arriving
              {nodePreview.queue.backlogStable
                ? "."
                : " — the backlog will grow without bound, and no request percentile will show it."}
            </p>
          )}

          <div className="section">publish</div>
          <DistributionEditor
            value={node.queue.publishTime}
            onChange={(d) => patch((n) => { if (n.queue) n.queue.publishTime = d; })}
          />
          <p className="note">
            <b>Publishing returns immediately.</b> Only this publish time enters request
            latency; the consumer's work does not, because nobody is waiting for it. That is
            what a queue is for, and it is also why an unbounded backlog is dangerous rather
            than self-limiting.
          </p>

          <div className="section">bound</div>
          <Field label="max depth" hint="0 = unbounded">
            <NumberInput
              value={node.queue.maxDepth ?? 0}
              min={0}
              step={100}
              onChange={(v) => patch((n) => { if (n.queue) n.queue.maxDepth = v <= 0 ? null : Math.round(v); })}
            />
          </Field>
          <p className="note">
            A bound converts an invisible backlog into visible publish failures. That trade is
            usually worth making: you find out.
          </p>
          <CitationNote citation={node.queue.citation} />
        </>
      )}

      {nodePreview && (
        <div className="model-badge">
          solved as <b>{nodePreview.model}</b>
          {nodePreview.approximate && <span className="approx">approximate</span>}
          {nodePreview.caveat && <div className="model-caveat">{nodePreview.caveat}</div>}
        </div>
      )}

      <button
        className="btn danger"
        onClick={() =>
          edit((d) => {
            d.nodes = d.nodes.filter((x) => x.id !== selection.id);
            d.edges = d.edges.filter((e) => e.from !== selection.id && e.to !== selection.id);
          })
        }
      >
        delete node
      </button>

      <ClassEditor />
      <ScenarioEditor />
    </aside>
  );
}

/**
 * The arrival profile.
 *
 * The first two shapes are stationary and the rest are not, and the difference
 * changes what the tool can honestly report. A design under a ramp has no steady
 * state, so a single p99 over the whole run averages across regimes that never
 * coexisted -- part measured at 50/s and part at 800/s. The result panel says so and
 * points at the time series instead.
 *
 * They earn their place because they answer questions a steady-state run cannot: how
 * far a design gets before it breaks, whether it survives a burst, and how long it
 * takes to recover afterwards.
 */
function ArrivalEditor({ nodeId }: { nodeId: string }) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === nodeId));
  const durationSec = useStudio((s) => s.design.scenario.durationSec);
  const edit = useStudio((s) => s.edit);
  if (!node?.client) return null;
  const a = node.client.arrival;

  const patch = (fn: (n: NonNullable<typeof node>) => void) =>
    edit((d) => {
      const n = d.nodes.find((x) => x.id === nodeId);
      if (n) fn(n);
    });

  const setKind = (kind: ArrivalProcess["kind"]) =>
    patch((n) => {
      if (!n.client) return;
      const current =
        a.kind === "poisson" || a.kind === "deterministic"
          ? a.ratePerSec
          : a.kind === "ramp"
            ? a.toRatePerSec
            : a.kind === "spike"
              ? a.baseRatePerSec
              : a.ratePerSec;
      switch (kind) {
        case "poisson":
        case "deterministic":
          n.client.arrival = { kind, ratePerSec: current };
          break;
        case "ramp":
          n.client.arrival = {
            kind,
            fromRatePerSec: Math.max(1, current * 0.1),
            toRatePerSec: current * 2,
          };
          break;
        case "spike":
          n.client.arrival = {
            kind,
            baseRatePerSec: current,
            peakRatePerSec: current * 3,
            atSec: Math.round(durationSec * 0.3),
            durationSec: Math.max(5, Math.round(durationSec * 0.1)),
          };
          break;
        case "steps":
          n.client.arrival = {
            kind,
            ratePerSec: current,
            steps: [{ atSec: Math.round(durationSec * 0.5), ratePerSec: current * 2 }],
          };
          break;
      }
    });

  const timeVarying = isTimeVarying(a);

  return (
    <>
      <div className="section">
        arrival process
        {timeVarying && <span className="section-tag">time-varying</span>}
      </div>
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
          onChange={setKind}
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
                patch((n) => {
                  if (n.client && (n.client.arrival.kind === "poisson" || n.client.arrival.kind === "deterministic")) {
                    n.client.arrival.ratePerSec = Math.max(0.1, v);
                  }
                })
              }
            />
          </Field>
          <p className="note">
            Poisson arrivals are burstier than a fixed rate at the same average, and burstiness
            alone lengthens queues. A deterministic source is the best-case workload, not a
            neutral one.
          </p>
        </>
      )}

      {a.kind === "ramp" && (
        <>
          <Field label="from" hint="req/s">
            <NumberInput
              value={a.fromRatePerSec}
              min={0}
              step={10}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.arrival.kind === "ramp") n.client.arrival.fromRatePerSec = Math.max(0, v);
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
                patch((n) => {
                  if (n.client?.arrival.kind === "ramp") n.client.arrival.toRatePerSec = Math.max(0.1, v);
                })
              }
            />
          </Field>
          <p className="note">
            A load test in one run: the offered rate rises steadily and the first SLO breach marks
            the limit. It reads slightly <b>high</b> against a steady-state search, because queues
            take time to fill and the system is always catching up with a load that has already
            moved on &mdash; the same bias a live load test has. Set warm-up to 0; there is no
            steady state for it to reach.
          </p>
        </>
      )}

      {a.kind === "spike" && (
        <>
          <Field label="base" hint="req/s">
            <NumberInput
              value={a.baseRatePerSec}
              min={0.1}
              step={10}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.arrival.kind === "spike") n.client.arrival.baseRatePerSec = Math.max(0.1, v);
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
                patch((n) => {
                  if (n.client?.arrival.kind === "spike") n.client.arrival.peakRatePerSec = Math.max(0.1, v);
                })
              }
            />
          </Field>
          <Field label="starts at" hint="s">
            <NumberInput
              value={a.atSec}
              min={0}
              step={10}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.arrival.kind === "spike") n.client.arrival.atSec = Math.max(0, v);
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
                patch((n) => {
                  if (n.client?.arrival.kind === "spike") n.client.arrival.durationSec = Math.max(1, v);
                })
              }
            />
          </Field>
          <p className="note">
            Leave room after the burst: <b>recovery is usually the more interesting half</b>. A
            queue built during a spike keeps hurting requests that arrive after it has passed, so a
            design can survive the spike itself and still spend minutes catching up.
            {a.atSec + a.durationSec >= durationSec && (
              <>
                {" "}
                <b className="warn-text">
                  This spike runs to the end of the run, so recovery is never observed.
                </b>
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
                patch((n) => {
                  if (n.client?.arrival.kind === "steps") n.client.arrival.ratePerSec = Math.max(0.1, v);
                })
              }
            />
          </Field>
          {a.steps.map((step, i) => (
            <div className="class-editor-row" key={i}>
              <Field label={`step ${i + 1} at`} hint="s">
                <NumberInput
                  value={step.atSec}
                  min={0}
                  step={10}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.client?.arrival.kind === "steps") {
                        const st = n.client.arrival.steps[i];
                        if (st) st.atSec = Math.max(0, v);
                      }
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
                    patch((n) => {
                      if (n.client?.arrival.kind === "steps") {
                        const st = n.client.arrival.steps[i];
                        if (st) st.ratePerSec = Math.max(0.1, v);
                      }
                    })
                  }
                />
              </Field>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() =>
              patch((n) => {
                if (n.client?.arrival.kind === "steps") {
                  n.client.arrival.steps.push({
                    atSec: Math.round(durationSec * 0.5),
                    ratePerSec: n.client.arrival.ratePerSec * 2,
                  });
                }
              })
            }
          >
            add step
          </button>
        </>
      )}

      {timeVarying && (
        <p className="note warn">
          With load varying over the run there is no steady state, so a single p99 averages across
          regimes that never coexisted. Read the time series and the first-breach figure instead.
        </p>
      )}
    </>
  );
}

const RETRY_REASONS: Array<{ id: RetryableReason; label: string; note: string }> = [
  { id: "error", label: "error", note: "the dependency returned a failure" },
  { id: "timeout", label: "timeout", note: "ambiguous: the work may have completed" },
  {
    id: "shed",
    label: "shed",
    note: "dangerous: it just told you it had no capacity",
  },
  { id: "network", label: "network", note: "the message was dropped in transit" },
];

/**
 * Timeout, retry, circuit breaker and bulkhead for one call.
 *
 * All four live on the edge because that is what they are: the caller's client
 * configuration for one particular dependency. The same service routinely retries
 * its cache aggressively and its payment provider not at all.
 */
function PolicyEditor({ edgeId }: { edgeId: string }) {
  const edge = useStudio((s) => s.design.edges.find((e) => e.id === edgeId));
  const preview = useStudio((s) => s.preview.edges.find((e) => e.edgeId === edgeId));
  const measured = useStudio((s) => (s.runStale ? undefined : s.run?.edges.find((e) => e.edgeId === edgeId)));
  const edit = useStudio((s) => s.edit);
  if (!edge) return null;
  const p = edge.policy;

  const patch = (fn: (e: NonNullable<typeof edge>) => void) =>
    edit((d) => {
      const e = d.edges.find((x) => x.id === edgeId);
      if (e) fn(e);
    });

  return (
    <>
      <div className="section">per-attempt timeout</div>
      <Field label="timeout" hint="ms, 0 = none">
        <NumberInput
          value={p.timeoutMs ?? 0}
          min={0}
          step={50}
          onChange={(v) => patch((e) => { e.policy.timeoutMs = v <= 0 ? null : v; })}
        />
      </Field>
      <p className="note">
        Distinct from the client's end-to-end deadline. A per-attempt timeout is what
        makes retrying possible at all &mdash; without one, a hung attempt consumes the
        whole budget. Setting it too low is its own failure mode: attempts that would
        have succeeded are abandoned, each is replaced by a retry, and the dependency
        does strictly more work.
      </p>

      <div className="section">retry</div>
      <Toggle
        label={p.retry ? "retrying" : "no retries"}
        hint={p.retry ? `up to ${p.retry.maxAttempts} attempts` : "one attempt per call"}
        on={p.retry !== null}
        onChange={(on) =>
          patch((e) => {
            e.policy.retry = on
              ? {
                  maxAttempts: 3,
                  backoff: { kind: "exponential", baseMs: 20, maxMs: 1000, jitter: true },
                  retryOn: ["error", "timeout"],
                  budgetRatio: 0.1,
                }
              : null;
          })
        }
      />

      {p.retry && (
        <>
          <Field label="max attempts" hint="including the first">
            <NumberInput
              value={p.retry.maxAttempts}
              min={1}
              onChange={(v) => patch((e) => { if (e.policy.retry) e.policy.retry.maxAttempts = Math.max(1, Math.round(v)); })}
            />
          </Field>

          <Field label="retry budget" hint="%, 0 = unlimited">
            <NumberInput
              value={p.retry.budgetRatio === null ? 0 : Math.round(p.retry.budgetRatio * 1000) / 10}
              min={0}
              step={5}
              onChange={(v) =>
                patch((e) => {
                  if (e.policy.retry) e.policy.retry.budgetRatio = v <= 0 ? null : v / 100;
                })
              }
            />
          </Field>
          <p className={`note ${p.retry.budgetRatio === null ? "warn" : ""}`}>
            {p.retry.budgetRatio === null ? (
              <>
                <b>No budget.</b> Retries will multiply load on this dependency by up to{" "}
                <b className="tnum">{p.retry.maxAttempts}&times;</b> exactly when it can least
                afford it, and every layer above multiplies again. This is the default almost
                everywhere and it is how a brownout becomes an outage.
              </>
            ) : (
              <>
                Retries may add at most{" "}
                <b className="tnum">{(p.retry.budgetRatio * 100).toFixed(0)}%</b> more calls, so
                amplification is capped near{" "}
                <b className="tnum">{(1 + p.retry.budgetRatio).toFixed(2)}&times;</b> however bad
                things get. The trade is real: fewer retries means fewer recoveries and a higher
                reported error rate.
              </>
            )}
          </p>

          <Field label="retry on">
            <div className="chip-row">
              {RETRY_REASONS.map((r) => {
                const on = p.retry!.retryOn.includes(r.id);
                return (
                  <button
                    key={r.id}
                    className={`chip ${on ? "on" : ""}`}
                    title={r.note}
                    onClick={() =>
                      patch((e) => {
                        if (!e.policy.retry) return;
                        e.policy.retry.retryOn = on
                          ? e.policy.retry.retryOn.filter((x) => x !== r.id)
                          : [...e.policy.retry.retryOn, r.id];
                      })
                    }
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </Field>
          {p.retry.retryOn.includes("shed") && (
            <p className="note warn">
              Retrying a shed request adds load to something that just told you it had no
              capacity. This is the fastest way to turn a partial failure into a total one.
            </p>
          )}

          <Field label="backoff">
            <Select
              value={p.retry.backoff.kind}
              options={[
                { value: "exponential" as const, label: "exponential" },
                { value: "fixed" as const, label: "fixed" },
                { value: "none" as const, label: "none (immediate)" },
              ]}
              onChange={(v) => patch((e) => { if (e.policy.retry) e.policy.retry.backoff.kind = v; })}
            />
          </Field>
          {p.retry.backoff.kind !== "none" && (
            <>
              <Field label="base delay" hint="ms">
                <NumberInput
                  value={p.retry.backoff.baseMs}
                  min={0}
                  step={10}
                  onChange={(v) => patch((e) => { if (e.policy.retry) e.policy.retry.backoff.baseMs = Math.max(0, v); })}
                />
              </Field>
              <Toggle
                label={p.retry.backoff.jitter ? "jittered" : "no jitter"}
                hint={p.retry.backoff.jitter ? "randomised over [0, delay]" : "every client retries in lockstep"}
                on={p.retry.backoff.jitter}
                onChange={(v) => patch((e) => { if (e.policy.retry) e.policy.retry.backoff.jitter = v; })}
              />
              {!p.retry.backoff.jitter && (
                <p className="note warn">
                  Without jitter, every client that failed at the same instant retries at the
                  same instant, so the recovering dependency is hit by a synchronised wave and
                  fails again. Jitter costs nothing.
                </p>
              )}
            </>
          )}
        </>
      )}

      <div className="section">circuit breaker</div>
      <Toggle
        label={p.circuitBreaker.enabled ? "breaker on" : "breaker off"}
        hint={p.circuitBreaker.enabled ? `opens above ${(p.circuitBreaker.failureThreshold * 100).toFixed(0)}% failures` : "calls always attempted"}
        on={p.circuitBreaker.enabled}
        onChange={(v) => patch((e) => { e.policy.circuitBreaker.enabled = v; })}
      />
      {p.circuitBreaker.enabled && (
        <>
          <Field label="failure threshold" hint="%">
            <NumberInput
              value={Math.round(p.circuitBreaker.failureThreshold * 1000) / 10}
              min={1}
              max={100}
              step={5}
              onChange={(v) => patch((e) => { e.policy.circuitBreaker.failureThreshold = Math.min(1, Math.max(0.01, v / 100)); })}
            />
          </Field>
          <Field label="stay open" hint="ms">
            <NumberInput
              value={p.circuitBreaker.openMs}
              min={100}
              step={500}
              onChange={(v) => patch((e) => { e.policy.circuitBreaker.openMs = Math.max(100, v); })}
            />
          </Field>
          <p className="note">
            A breaker protects the <b>caller</b>, not the dependency. A blocking caller with a
            failing dependency ties up a worker per request for the whole timeout; failing fast
            returns those workers immediately. It is also blunt: a dependency failing 60% of the
            time still succeeds 40% of the time, and a 50% threshold takes it almost entirely out
            of service.
          </p>
        </>
      )}

      <div className="section">bulkhead</div>
      <Toggle
        label={p.bulkhead.enabled ? "bulkhead on" : "bulkhead off"}
        hint={p.bulkhead.enabled ? `${p.bulkhead.maxConcurrent} concurrent calls` : "unbounded concurrent calls"}
        on={p.bulkhead.enabled}
        onChange={(v) => patch((e) => { e.policy.bulkhead.enabled = v; })}
      />
      {p.bulkhead.enabled && (
        <>
          <Field label="max concurrent">
            <NumberInput
              value={p.bulkhead.maxConcurrent}
              min={1}
              onChange={(v) => patch((e) => { e.policy.bulkhead.maxConcurrent = Math.max(1, Math.round(v)); })}
            />
          </Field>
          <Field label="queue" hint="0 = reject at once">
            <NumberInput
              value={p.bulkhead.queueCapacity}
              min={0}
              onChange={(v) => patch((e) => { e.policy.bulkhead.queueCapacity = Math.max(0, Math.round(v)); })}
            />
          </Field>
          <p className="note">
            Confines a slow dependency's damage to the traffic that needs it, instead of letting
            it consume every worker the caller has. This is the direct fix for a blocking caller.
          </p>
        </>
      )}

      {(preview || measured) && (
        <>
          <div className="section">predicted / measured</div>
          {preview && (
            <div className="station-detail tnum">
              predicted amplification <b>{preview.amplification.toFixed(2)}&times;</b> at{" "}
              {(preview.attemptFailureProbability * 100).toFixed(1)}% attempt failure
              {preview.budgetBinding && " · budget binding"}
            </div>
          )}
          {measured && measured.hasPolicy && (
            <div className="station-detail tnum">
              measured <b>{measured.amplification.toFixed(2)}&times;</b> ·{" "}
              {measured.retries.toLocaleString()} retries
              {measured.budgetRejections > 0 && ` · ${measured.budgetRejections.toLocaleString()} budget-capped`}
              {measured.breakerTrips > 0 &&
                ` · breaker tripped ${measured.breakerTrips}\u00d7, open ${(measured.breakerOpenFraction * 100).toFixed(0)}%`}
              {measured.bulkheadRejections > 0 && ` · ${measured.bulkheadRejections.toLocaleString()} bulkhead-rejected`}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * A population of long-lived connections.
 *
 * Everything else in the model is a request that arrives and leaves. A connection is
 * held for an entire session, which makes the binding constraint a socket count rather
 * than a throughput, and the failure a refusal rather than a delay.
 */
function ConnectionEditor({ nodeId }: { nodeId: string }) {
  const node = useStudio((s) => s.design.nodes.find((n) => n.id === nodeId));
  const durationSec = useStudio((s) => s.design.scenario.durationSec);
  const capacity = useStudio((s) =>
    s.design.nodes.reduce(
      (sum, n) => sum + (n.gateway ? n.gateway.connectionCapacity * n.gateway.replicas : 0),
      0
    )
  );
  const measured = useStudio((s) => (s.runStale ? undefined : s.run?.connectionsHeld));
  const edit = useStudio((s) => s.edit);
  if (!node?.client) return null;
  const pop = node.client.connections;

  const patch = (fn: (n: NonNullable<typeof node>) => void) =>
    edit((d) => {
      const n = d.nodes.find((x) => x.id === nodeId);
      if (n) fn(n);
    });

  return (
    <>
      <div className="section">connections</div>
      <Toggle
        label={pop ? `${pop.count.toLocaleString()} concurrent connections` : "no connections"}
        hint={pop ? "held for the whole session" : "stateless requests only"}
        on={pop !== null}
        onChange={(on) =>
          patch((n) => {
            if (!n.client) return;
            n.client.connections = on
              ? {
                  count: 10_000,
                  establishOverSec: 30,
                  sessionDuration: { kind: "exponential", mean: 600_000 },
                  disruption: null,
                }
              : null;
          })
        }
      />

      {pop && (
        <>
          <Field label="count" hint="concurrent">
            <NumberInput
              value={pop.count}
              min={1}
              step={1000}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.connections) n.client.connections.count = Math.max(1, Math.round(v));
                })
              }
            />
          </Field>
          <Field label="establish over" hint="s">
            <NumberInput
              value={pop.establishOverSec}
              min={0.001}
              step={10}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.connections) {
                    n.client.connections.establishOverSec = Math.max(0.001, v);
                  }
                })
              }
            />
          </Field>

          <p className={`note ${capacity > 0 && pop.count > capacity ? "warn" : ""}`}>
            {capacity > 0 ? (
              <>
                Gateway capacity is <b className="tnum">{capacity.toLocaleString()}</b> sockets.
                {pop.count > capacity ? (
                  <>
                    {" "}
                    <b>
                      {(pop.count - capacity).toLocaleString()} of these will be refused
                    </b>{" "}
                    &mdash; a hard failure, not a slow response.
                  </>
                ) : (
                  ` These fit, at ${((pop.count / capacity) * 100).toFixed(0)}% of it.`
                )}
              </>
            ) : (
              <>Wire this client to a gateway; only a gateway can hold a connection.</>
            )}
            {measured !== undefined && (
              <>
                {" "}
                Measured: <b className="tnum">{Math.round(measured).toLocaleString()}</b> held.
              </>
            )}
          </p>

          <Field label="session length" hint="ms mean, 0 = never ends">
            <NumberInput
              value={
                pop.sessionDuration === null
                  ? 0
                  : pop.sessionDuration.kind === "exponential"
                    ? pop.sessionDuration.mean
                    : 0
              }
              min={0}
              step={60_000}
              onChange={(v) =>
                patch((n) => {
                  if (n.client?.connections) {
                    n.client.connections.sessionDuration =
                      v <= 0 ? null : { kind: "exponential", mean: v };
                  }
                })
              }
            />
          </Field>
          <p className="note">
            {pop.sessionDuration === null ? (
              <>
                Connections never drop, so no handshakes are paid after start-up. Real sessions do
                end &mdash; tab closed, network changed, phone slept &mdash; and each ending is a
                handshake for someone to pay for, so this understates accept work.
              </>
            ) : (
              <>
                Churn costs{" "}
                <b className="tnum">
                  {(
                    pop.count /
                    (pop.sessionDuration.kind === "exponential"
                      ? pop.sessionDuration.mean / 1000
                      : 1)
                  ).toFixed(1)}
                </b>{" "}
                handshakes per second, forever &mdash; Little&rsquo;s Law applied to sockets. It is
                easy to leave out of a capacity estimate, and it is the load a reconnect storm
                multiplies.
              </>
            )}
          </p>

          <div className="section">disruption</div>
          <Toggle
            label={pop.disruption ? "loses connections partway" : "no disruption"}
            hint={
              pop.disruption
                ? `${(pop.disruption.fraction * 100).toFixed(0)}% drop at ${pop.disruption.atSec}s`
                : "connections are never forcibly dropped"
            }
            on={pop.disruption !== null}
            onChange={(on) =>
              patch((n) => {
                if (!n.client?.connections) return;
                n.client.connections.disruption = on
                  ? {
                      atSec: Math.round(durationSec * 0.5),
                      fraction: 0.25,
                      reconnectOverSec: 0,
                    }
                  : null;
              })
            }
          />
          {pop.disruption && (
            <>
              <Field label="at" hint="s">
                <NumberInput
                  value={pop.disruption.atSec}
                  min={0}
                  step={10}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.client?.connections?.disruption) {
                        n.client.connections.disruption.atSec = Math.max(0, v);
                      }
                    })
                  }
                />
              </Field>
              <Field label="fraction dropped" hint="%">
                <NumberInput
                  value={Math.round(pop.disruption.fraction * 1000) / 10}
                  min={0}
                  max={100}
                  step={5}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.client?.connections?.disruption) {
                        n.client.connections.disruption.fraction = Math.min(1, Math.max(0, v / 100));
                      }
                    })
                  }
                />
              </Field>
              <Field label="reconnect over" hint="s, 0 = all at once">
                <NumberInput
                  value={pop.disruption.reconnectOverSec}
                  min={0}
                  step={5}
                  onChange={(v) =>
                    patch((n) => {
                      if (n.client?.connections?.disruption) {
                        n.client.connections.disruption.reconnectOverSec = Math.max(0, v);
                      }
                    })
                  }
                />
              </Field>
              <p className="note warn">
                The failure realtime systems actually have. When an instance dies its connections
                come back at once, handshakes cost far more than messages, and both draw on the
                same work pool &mdash; so people who never disconnected see their messages stall.
                Spreading the reconnects costs nothing and is the mitigation.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}

function QueueLimitEditor({
  queueCapacity,
  admissionPolicy,
  onCapacity,
  onPolicy,
}: {
  queueCapacity: number | null;
  admissionPolicy: "shed" | "block";
  onCapacity: (v: number | null) => void;
  onPolicy: (v: "shed" | "block") => void;
}) {
  return (
    <>
      <Field label="capacity" hint="0 = unbounded">
        <NumberInput
          value={queueCapacity ?? 0}
          min={0}
          step={10}
          onChange={(v) => onCapacity(v <= 0 ? null : Math.round(v))}
        />
      </Field>
      <Field label="when full">
        <Select
          value={admissionPolicy}
          disabled={queueCapacity === null}
          options={[
            { value: "shed" as const, label: "shed (reject)" },
            { value: "block" as const, label: "block (wait anyway)" },
          ]}
          onChange={onPolicy}
        />
      </Field>
      <p className="note">
        Shedding trades errors for bounded latency: an overloaded station with a bounded queue
        still has a steady state. Blocking in an open-loop system makes the bound advisory,
        since there is no upstream buffer to push back against.
      </p>
    </>
  );
}

/**
 * Request classes.
 *
 * The dimension that makes "3% of traffic hits the expensive endpoint" expressible.
 * With no classes declared, a single implicit class carries everything.
 */
function ClassEditor() {
  const classes = useStudio((s) => s.design.classes);
  const edit = useStudio((s) => s.edit);
  const totalWeight = classes.reduce((s, c) => s + c.weight, 0);

  return (
    <>
      <div className="section">request classes</div>
      {classes.length === 0 ? (
        <p className="note">
          One implicit class carries all traffic. Add classes to split a workload into a fast
          path and a slow one, then restrict connections to a class so each follows its own
          route.
        </p>
      ) : (
        classes.map((c, i) => (
          <div className="class-editor" key={c.id}>
            <div className="class-editor-head">
              <input
                className="input"
                value={c.label}
                onChange={(e) =>
                  edit((d) => {
                    const cls = d.classes[i];
                    if (cls) cls.label = e.target.value;
                  })
                }
              />
              <button
                className="btn small danger"
                onClick={() =>
                  edit((d) => {
                    const removed = d.classes[i]?.id;
                    d.classes = d.classes.filter((_, k) => k !== i);
                    // Connections restricted to a deleted class would become
                    // unroutable, so the restriction is dropped with it.
                    if (removed) {
                      for (const e of d.edges) e.classes = e.classes.filter((x) => x !== removed);
                    }
                  })
                }
              >
                remove
              </button>
            </div>
            <div className="class-editor-row">
              <Field label="weight" hint={`${((c.weight / totalWeight) * 100).toFixed(0)}% of traffic`}>
                <NumberInput
                  value={c.weight}
                  min={0.1}
                  step={0.5}
                  onChange={(v) =>
                    edit((d) => {
                      const cls = d.classes[i];
                      if (cls) cls.weight = Math.max(0.1, v);
                    })
                  }
                />
              </Field>
              <Field label="cost multiplier" hint="× service time">
                <NumberInput
                  value={c.serviceMultiplier}
                  min={0.1}
                  step={0.5}
                  onChange={(v) =>
                    edit((d) => {
                      const cls = d.classes[i];
                      if (cls) cls.serviceMultiplier = Math.max(0.1, v);
                    })
                  }
                />
              </Field>
            </div>
          </div>
        ))
      )}
      <button
        className="btn small"
        onClick={() =>
          edit((d) => {
            const n = d.classes.length;
            d.classes.push({
              id: `class${n + 1}`,
              label: n === 0 ? "reads" : n === 1 ? "writes" : `class ${n + 1}`,
              weight: 1,
              serviceMultiplier: 1,
            });
          })
        }
      >
        add class
      </button>
    </>
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
          onChange={(v) => edit((d) => { d.scenario.durationSec = Math.max(1, v); })}
        />
      </Field>
      <Field label="warm-up" hint="discarded s">
        <NumberInput
          value={scenario.warmupSec}
          min={0}
          step={10}
          onChange={(v) => edit((d) => { d.scenario.warmupSec = Math.max(0, v); })}
        />
      </Field>
      <Field label="seed" hint="reproducibility">
        <NumberInput
          value={scenario.seed}
          min={0}
          onChange={(v) => edit((d) => { d.scenario.seed = Math.max(0, Math.round(v)); })}
        />
      </Field>
      <p className="note">
        A queueing system starts empty, which is not its steady state, so the warm-up window is
        discarded before measuring. Duration matters more than it looks: samples needed for a
        given accuracy scale as 1/(1&minus;&rho;)&sup2;, so a short run is noisiest at exactly
        the utilizations worth studying.
      </p>

      <div className="section">slo</div>
      <Field label="p99 target" hint="ms, 0 = none">
        <NumberInput
          value={slo.p99LatencyMs ?? 0}
          min={0}
          step={10}
          onChange={(v) => edit((d) => { d.slo.p99LatencyMs = v <= 0 ? null : v; })}
        />
      </Field>
      <Field label="max errors" hint="%, 0 = none">
        <NumberInput
          value={slo.maxErrorRatePct ?? 0}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) => edit((d) => { d.slo.maxErrorRatePct = v <= 0 ? null : v; })}
        />
      </Field>
    </>
  );
}

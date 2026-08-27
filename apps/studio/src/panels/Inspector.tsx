import { citationText } from "@sds/models";
import type { Citation, Distribution } from "@sds/schema";
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
          <div className="section">arrival process</div>
          <Field label="process" hint={node.client.arrival.kind === "poisson" ? "independent users" : "perfectly paced"}>
            <Select
              value={node.client.arrival.kind}
              options={[
                { value: "poisson" as const, label: "poisson" },
                { value: "deterministic" as const, label: "deterministic" },
              ]}
              onChange={(v) => patch((n) => { if (n.client) n.client.arrival.kind = v; })}
            />
          </Field>
          <Field label="rate" hint="req/s">
            <NumberInput
              value={node.client.arrival.ratePerSec}
              min={0.1}
              step={10}
              onChange={(v) => patch((n) => { if (n.client) n.client.arrival.ratePerSec = Math.max(0.1, v); })}
            />
          </Field>
          <p className="note">
            Poisson arrivals are burstier than a fixed rate at the same average, and
            burstiness alone lengthens queues. A deterministic source is the best-case
            workload, not a neutral one.
          </p>

          <div className="section">client timeout</div>
          <Field label="deadline" hint="ms, 0 = none">
            <NumberInput
              value={node.client.timeoutMs ?? 0}
              min={0}
              step={50}
              onChange={(v) => patch((n) => { if (n.client) n.client.timeoutMs = v <= 0 ? null : v; })}
            />
          </Field>
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

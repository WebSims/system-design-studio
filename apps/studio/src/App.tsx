import { useCallback, useRef } from "react";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { Inspector } from "./panels/Inspector";
import { ResultsRail } from "./panels/ResultsRail";
import { nextNodeId } from "./ids";
import { useStudio } from "./store";

function Topbar() {
  const design = useStudio((s) => s.design);
  const edit = useStudio((s) => s.edit);
  const reset = useStudio((s) => s.resetDesign);
  const exportDesign = useStudio((s) => s.exportDesign);
  const importDesign = useStudio((s) => s.importDesign);
  const fileRef = useRef<HTMLInputElement>(null);

  const addServer = useCallback(() => {
    edit((d) => {
      const id = nextNodeId("server", d.nodes.map((n) => n.id));
      const maxX = d.nodes.reduce((m, n) => Math.max(m, n.x), 0);
      d.nodes.push({
        id,
        kind: "server",
        label: "service",
        x: maxX + 320,
        y: 220,
        server: {
          concurrency: 4,
          queueCapacity: null,
          serviceTime: { kind: "exponential", mean: 20 },
          admissionPolicy: "block",
          queueDiscipline: "fifo",
          replicas: 1,
        },
      });
    });
  }, [edit]);

  const download = useCallback(() => {
    const blob = new Blob([exportDesign()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${design.name.replace(/\s+/g, "-")}.sds.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportDesign, design.name]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark" />
        <div>
          <div className="brand-name">
            system design <b>studio</b>
          </div>
          <div className="brand-sub">validated queueing simulator</div>
        </div>
      </div>

      <div className="tb-group">
        <button className="btn" onClick={addServer}>
          add service
        </button>
        <button className="btn" onClick={reset}>
          reset
        </button>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group">
        <span className="tb-meta tnum">
          {design.nodes.length} nodes · {design.edges.length} links
        </span>
        <button className="btn" onClick={download}>
          export
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              importDesign(await file.text());
            } catch (err) {
              alert(err instanceof Error ? err.message : String(err));
            }
            e.target.value = "";
          }}
        />
      </div>
    </header>
  );
}

export function App() {
  return (
    <div className="shell">
      <Topbar />
      <ResultsRail />
      <FlowCanvas />
      <Inspector />
    </div>
  );
}

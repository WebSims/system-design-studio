import { useCallback, useRef, useState } from "react";
import { PRESETS, EXAMPLES } from "@sds/models";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { Inspector } from "./panels/Inspector";
import { ResultsRail } from "./panels/ResultsRail";
import { nextNodeId } from "./ids";
import { useStudio } from "./store";

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

function Topbar() {
  const design = useStudio((s) => s.design);
  const exportDesign = useStudio((s) => s.exportDesign);
  const importDesign = useStudio((s) => s.importDesign);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<"palette" | "examples" | null>(null);

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
    <header className="topbar" onClick={() => setMenu(null)}>
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
        <div className="menu-anchor">
          <button
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === "palette" ? null : "palette");
            }}
          >
            add component
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
            examples
          </button>
          {menu === "examples" && <ExampleMenu onClose={() => setMenu(null)} />}
        </div>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group">
        <span className="tb-meta tnum">
          {design.nodes.length} nodes &middot; {design.edges.length} links
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

import { Panel, useReactFlow, useStore } from "@xyflow/react";
import { geometrySelectionCount, selectionCount } from "./editing";
import { useStudio } from "../store";

function CommandButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const title = shortcut ? `${label} · ${shortcut}` : label;
  return (
    <button
      type="button"
      className="canvas-command nodrag nopan"
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Compact architecture editing commands, usable by mouse or their keyboard equivalents. */
export function CanvasEditingToolbar() {
  const selection = useStudio((state) => state.canvasSelection);
  const past = useStudio((state) => state.historyPast.length);
  const future = useStudio((state) => state.historyFuture.length);
  const clipboard = useStudio((state) => state.clipboard);
  const undo = useStudio((state) => state.undo);
  const redo = useStudio((state) => state.redo);
  const copy = useStudio((state) => state.copySelection);
  const paste = useStudio((state) => state.pasteSelection);
  const duplicate = useStudio((state) => state.duplicateSelection);
  const remove = useStudio((state) => state.deleteSelection);
  const align = useStudio((state) => state.alignSelection);
  const distribute = useStudio((state) => state.distributeSelection);
  const insert = useStudio((state) => state.insertCanvasObject);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { getViewport } = useReactFlow();
  const selected = selectionCount(selection);
  const geometry = geometrySelectionCount(selection);

  const insertAtCenter = (kind: "frame" | "text") => {
    const viewport = getViewport();
    const objectWidth = kind === "frame" ? 600 : 260;
    const objectHeight = kind === "frame" ? 320 : 96;
    insert(
      kind,
      (width / 2 - viewport.x) / viewport.zoom - objectWidth / 2,
      (height / 2 - viewport.y) / viewport.zoom - objectHeight / 2
    );
  };

  return (
    <Panel position="bottom-center" className="canvas-editing-toolbar" aria-label="Canvas editing">
      <div className="canvas-command-group" role="group" aria-label="History">
        <CommandButton label="Undo" shortcut="⌘Z" disabled={past === 0} onClick={undo}>↶</CommandButton>
        <CommandButton label="Redo" shortcut="⇧⌘Z" disabled={future === 0} onClick={redo}>↷</CommandButton>
      </div>
      <span className="canvas-command-separator" aria-hidden="true" />
      <div className="canvas-command-group" role="group" aria-label="Canvas notes">
        <CommandButton label="Add frame" onClick={() => insertAtCenter("frame")}>Frame</CommandButton>
        <CommandButton label="Add text note" onClick={() => insertAtCenter("text")}>Text</CommandButton>
      </div>
      <span className="canvas-command-separator" aria-hidden="true" />
      <div className="canvas-command-group" role="group" aria-label="Selection actions">
        <span className="canvas-selection-count" aria-live="polite">{selected || "no"} selected</span>
        <CommandButton label="Copy" shortcut="⌘C" disabled={selected === 0} onClick={copy}>Copy</CommandButton>
        <CommandButton label="Paste" shortcut="⌘V" disabled={!clipboard} onClick={paste}>Paste</CommandButton>
        <CommandButton label="Duplicate" shortcut="⌘D" disabled={selected === 0} onClick={duplicate}>Duplicate</CommandButton>
        <CommandButton label="Delete selection" shortcut="Delete" disabled={selected === 0} onClick={remove}>Delete</CommandButton>
      </div>
      {geometry >= 2 && (
        <>
          <span className="canvas-command-separator" aria-hidden="true" />
          <div className="canvas-command-group" role="group" aria-label="Arrange selection">
            <CommandButton label="Align left" onClick={() => align("left")}>Align L</CommandButton>
            <CommandButton label="Align top" onClick={() => align("top")}>Align T</CommandButton>
            <CommandButton label="Distribute horizontally" disabled={geometry < 3} onClick={() => distribute("horizontal")}>Space H</CommandButton>
            <CommandButton label="Distribute vertically" disabled={geometry < 3} onClick={() => distribute("vertical")}>Space V</CommandButton>
          </div>
        </>
      )}
    </Panel>
  );
}

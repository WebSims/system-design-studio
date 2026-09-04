import type { NodeProps } from "@xyflow/react";
import type { CanvasObject } from "@sds/schema";

export const canvasFlowId = (id: string): string => `canvas:${id}`;
export const canvasObjectId = (flowId: string): string | null =>
  flowId.startsWith("canvas:") ? flowId.slice("canvas:".length) : null;

interface CanvasObjectData {
  object: CanvasObject;
}

/** Persisted presentation objects. They have no handles and never enter the engine. */
export function CanvasObjectNode({ selected, data }: NodeProps) {
  const { object } = data as unknown as CanvasObjectData;
  if (object.kind === "frame") {
    return (
      <div className={`canvas-frame tone-${object.tone} ${selected ? "selected" : ""}`}>
        <span className="canvas-frame-title">{object.title || "Untitled frame"}</span>
        {object.tone !== "neutral" && <span className="canvas-tone-label">{object.tone}</span>}
        {selected && <span className="canvas-selection-badge">selected</span>}
      </div>
    );
  }
  return (
    <div
      className={`canvas-text tone-${object.tone} ${selected ? "selected" : ""}`}
      style={{ fontSize: object.fontSize }}
    >
      <span>{object.text || "Empty note"}</span>
      {object.tone !== "neutral" && <span className="canvas-tone-label">{object.tone}</span>}
      {selected && <span className="canvas-selection-badge">selected</span>}
    </div>
  );
}

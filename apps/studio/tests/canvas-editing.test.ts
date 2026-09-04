import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultDesign, pizzaStudy } from "@sds/models";
import { CandidateSchema, blankStudy } from "@sds/schema";
import {
  applyCanvasSelectionDeltas,
  alignWorkspaceSelection,
  copyWorkspaceSelection,
  deleteWorkspaceSelection,
  distributeWorkspaceSelection,
  pasteWorkspaceSelection,
  type CanvasWorkspace,
} from "../src/canvas/editing";
import { NODE_WIDTH } from "../src/canvas/geometry";
import {
  createCandidate,
  editActiveCanvasObjects,
  promoteCandidate,
} from "../src/study/mutations";
import { useStudio } from "../src/store";
import { useStudyStore } from "../src/study/store";

const note = {
  id: "note-1",
  kind: "text" as const,
  x: 300,
  y: 100,
  width: 220,
  height: 80,
  text: "The write path",
  fontSize: 16,
  tone: "info" as const,
};

const workspace = (): CanvasWorkspace => ({ design: defaultDesign(), objects: [note] });

describe("architecture canvas operations", () => {
  it("folds controlled node and edge selection callbacks into one canvas selection", () => {
    const nodeSelected = applyCanvasSelectionDeltas(
      { nodeIds: [], edgeIds: ["edge-old"], objectIds: [] },
      [{ group: "nodeIds", id: "api", selected: true }]
    );
    expect(nodeSelected).toEqual({
      selection: { nodeIds: ["api"], edgeIds: ["edge-old"], objectIds: [] },
      primary: { kind: "node", id: "api" },
    });

    const edgeReconciled = applyCanvasSelectionDeltas(nodeSelected.selection, [
      { group: "edgeIds", id: "edge-old", selected: false },
      { group: "edgeIds", id: "edge-new", selected: true },
    ]);
    expect(edgeReconciled).toEqual({
      selection: { nodeIds: ["api"], edgeIds: ["edge-new"], objectIds: [] },
      primary: { kind: "edge", id: "edge-new" },
    });
  });

  it("copies a connected selection with fresh IDs and no evidence channel", () => {
    const copied = copyWorkspaceSelection(workspace(), {
      nodeIds: ["client", "api"],
      edgeIds: [],
      objectIds: ["note-1"],
    });
    expect(copied).not.toBeNull();
    expect(copied!.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect("evidence" in copied!).toBe(false);

    const pasted = pasteWorkspaceSelection(workspace(), copied!);
    expect(pasted.selection.nodeIds).toHaveLength(2);
    expect(pasted.selection.edgeIds).toHaveLength(1);
    expect(pasted.selection.objectIds).toHaveLength(1);
    expect(pasted.selection.nodeIds).not.toContain("client");
    const edge = pasted.workspace.design.edges.at(-1)!;
    expect(pasted.selection.nodeIds).toContain(edge.from);
    expect(pasted.selection.nodeIds).toContain(edge.to);
  });

  it("batch deletion removes incident links in the same transaction", () => {
    const deleted = deleteWorkspaceSelection(workspace(), {
      nodeIds: ["api"],
      edgeIds: [],
      objectIds: ["note-1"],
    });
    expect(deleted.design.nodes.map((node) => node.id)).toEqual(["client"]);
    expect(deleted.design.edges).toEqual([]);
    expect(deleted.objects).toEqual([]);
  });

  it("aligns and distributes mixed components and presentation objects", () => {
    const base = workspace();
    base.objects.push({ ...note, id: "note-2", x: 900, y: 500 });
    const selection = {
      nodeIds: ["client", "api"],
      edgeIds: [],
      objectIds: ["note-1", "note-2"],
    };
    const aligned = alignWorkspaceSelection(base, selection, "top");
    expect([
      ...aligned.design.nodes.map((node) => node.y),
      ...aligned.objects.map((object) => object.y),
    ]).toEqual([100, 100, 100, 100]);

    const distributed = distributeWorkspaceSelection(aligned, selection, "horizontal");
    const centers = [
      ...distributed.design.nodes.map((node) => node.x + NODE_WIDTH / 2),
      ...distributed.objects.map((object) => object.x + object.width / 2),
    ].sort((a, b) => a - b);
    expect(centers[1]! - centers[0]!).toBeCloseTo(centers[2]! - centers[1]!, 0);
    expect(centers[2]! - centers[1]!).toBeCloseTo(centers[3]! - centers[2]!, 0);
  });
});

describe("canvas persistence boundaries", () => {
  it("parses frames and text on candidates, never inside the executable design", () => {
    const candidate = CandidateSchema.parse({
      ...pizzaStudy().candidates[0]!,
      canvasObjects: [
        note,
        {
          id: "frame-1",
          kind: "frame",
          x: 0,
          y: 0,
          width: 800,
          height: 500,
          title: "API boundary",
        },
      ],
    });
    expect(candidate.canvasObjects).toHaveLength(2);
    expect("canvasObjects" in candidate.design).toBe(false);
  });

  it("presentation edits preserve architecture revision and approval", () => {
    let study = blankStudy({ id: "canvas-study", now: 1 });
    ({ study } = createCandidate(study, {
      label: "candidate",
      design: defaultDesign(),
      origin: "human",
    }));
    study = promoteCandidate(study, study.candidates[0]!.id, 2);
    const before = study.candidates[0]!;
    const edited = editActiveCanvasObjects(study, () => [note]);
    expect(edited.candidates[0]!.revision).toBe(before.revision);
    expect(edited.approval).toEqual(study.approval);
    expect(edited.evaluations).toEqual(study.evaluations);
  });

  it("copies presentation objects with a version while keeping them outside the design", () => {
    let study = blankStudy({ id: "canvas-copy-study", now: 1 });
    ({ study } = createCandidate(study, {
      label: "source",
      design: defaultDesign(),
      origin: "human",
    }));
    study = editActiveCanvasObjects(study, () => [note]);
    const { candidate } = createCandidate(study, {
      label: "copy",
      copyFrom: study.activeCandidateId!,
      origin: "human",
    });
    expect(candidate.canvasObjects).toEqual([note]);
    expect(candidate.canvasObjects).not.toBe(study.candidates[0]!.canvasObjects);
    expect("canvasObjects" in candidate.design).toBe(false);
  });
});

describe("transaction history", () => {
  beforeEach(() => {
    useStudyStore.getState().loadStudyDocument(pizzaStudy());
    useStudio.setState({ historyPast: [], historyFuture: [], clipboard: null, pasteCount: 0 });
  });

  it("undoes and redoes one batch without touching evidence or evaluations", () => {
    const beforeCandidate = useStudyStore.getState().activeCandidate()!;
    const evidence = structuredClone(beforeCandidate.evidence);
    const evaluations = structuredClone(useStudyStore.getState().study.evaluations);
    const count = beforeCandidate.design.nodes.length;
    useStudio.getState().select({ kind: "node", id: beforeCandidate.design.nodes[0]!.id });
    useStudio.getState().duplicateSelection();
    expect(useStudio.getState().design.nodes).toHaveLength(count + 1);
    expect(useStudio.getState().historyPast).toHaveLength(1);

    useStudio.getState().undo();
    expect(useStudio.getState().design.nodes).toHaveLength(count);
    useStudio.getState().redo();
    expect(useStudio.getState().design.nodes).toHaveLength(count + 1);
    expect(useStudyStore.getState().activeCandidate()!.evidence).toEqual(evidence);
    expect(useStudyStore.getState().study.evaluations).toEqual(evaluations);
  });

  it("makes repeated controlled-selection callbacks a no-op", () => {
    const selected = { nodeIds: ["client"], edgeIds: [], objectIds: [] };
    useStudio.getState().selectMany(selected);
    const settled = useStudio.getState();
    useStudio.getState().selectMany({ ...selected, nodeIds: [...selected.nodeIds] });
    expect(useStudio.getState()).toBe(settled);
  });

  it("keeps a connection selected while its settings are edited", () => {
    const edge = useStudio.getState().design.edges[0]!;
    useStudio.getState().select({ kind: "edge", id: edge.id });

    useStudio.getState().edit((design) => {
      design.edges.find((candidate) => candidate.id === edge.id)!.weight = 0.75;
    });

    expect(useStudio.getState().selection).toEqual({ kind: "edge", id: edge.id });
    expect(useStudio.getState().canvasSelection).toEqual({
      nodeIds: [],
      edgeIds: [edge.id],
      objectIds: [],
    });
  });
});

describe("canvas UI contract", () => {
  it("supports exact drops, coalesced drags, rectangle selection and keyboard workflows", () => {
    const source = readFileSync(new URL("../src/canvas/FlowCanvas.tsx", import.meta.url), "utf8");
    expect(source).toContain("screenToFlowPosition");
    expect(source).toContain("selectionOnDrag");
    expect(source).toContain("SelectionMode.Partial");
    expect(source).toContain("onEdgesChange={onEdgesChange}");
    expect(source).toContain("applyCanvasSelectionDeltas");
    expect(source).toContain("dragPositionsRef");
    expect(source).toContain("onNodeDragStop");
    expect(source).toContain('key === "z"');
    expect(source).toContain('key === "c"');
    expect(source).toContain('key === "v"');
    expect(source).toContain('key === "d"');
  });

  it("offers only architecture notes and frames, not general whiteboard tools", () => {
    const source = readFileSync(new URL("../src/canvas/CanvasEditingToolbar.tsx", import.meta.url), "utf8");
    expect(source).toContain("Add frame");
    expect(source).toContain("Add text note");
    expect(source).not.toMatch(/freehand|image upload/i);
  });

  it("gives connections a single generous interaction target", () => {
    const source = readFileSync(new URL("../src/canvas/PipeEdge.tsx", import.meta.url), "utf8");
    expect(source).toContain("interactionWidth={0}");
    expect(source).toContain("Math.max(interactionWidth ?? 0, 32)");
  });
});

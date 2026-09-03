import { describe, expect, it } from "vitest";
import type { SdsNode } from "@sds/schema";
import {
  LAYOUT_ORIGIN,
  LAYOUT_STEP,
  layeredPositions,
  layoutIssue,
  nextNodePosition,
  overlappingNodePair,
} from "../src/canvas/layout";

const node = (id: string, kind = "server"): { id: string; kind: string } => ({ id, kind });
const link = (from: string, to: string) => ({ from, to });

const boxes = (positions: Map<string, { x: number; y: number }>): SdsNode[] =>
  [...positions.entries()].map(([id, { x, y }]) => ({ id, kind: "server", label: id, x, y }) as SdsNode);

describe("layered layout", () => {
  it("puts callers left and one column per dependency depth", () => {
    const positions = layeredPositions(
      [node("browser", "client"), node("api"), node("pg", "database"), node("redis", "cache")],
      [link("browser", "api"), link("api", "pg"), link("api", "redis")]
    );
    expect(positions.get("browser")!.x).toBe(LAYOUT_ORIGIN.x);
    expect(positions.get("api")!.x).toBe(LAYOUT_ORIGIN.x + LAYOUT_STEP.x);
    expect(positions.get("pg")!.x).toBe(LAYOUT_ORIGIN.x + 2 * LAYOUT_STEP.x);
    expect(positions.get("redis")!.x).toBe(positions.get("pg")!.x);
    // Two stores behind one service: same column, separate rows, spacing honoured.
    expect(Math.abs(positions.get("pg")!.y - positions.get("redis")!.y)).toBe(LAYOUT_STEP.y);
    expect(overlappingNodePair(boxes(positions))).toBeNull();
  });

  it("levels a shared dependency with the middle of its callers", () => {
    const positions = layeredPositions(
      [node("browser", "client"), node("api"), node("worker"), node("pg", "database")],
      [link("browser", "api"), link("browser", "worker"), link("api", "pg"), link("worker", "pg")]
    );
    const api = positions.get("api")!;
    const worker = positions.get("worker")!;
    const pg = positions.get("pg")!;
    expect(api.x).toBe(worker.x);
    expect(pg.x).toBeGreaterThan(api.x);
    expect(pg.y).toBe(Math.round((api.y + worker.y) / 2));
  });

  it("uses the longest caller chain, so a store reached directly and via a service sits after both", () => {
    const positions = layeredPositions(
      [node("browser", "client"), node("api"), node("pg", "database")],
      [link("browser", "api"), link("browser", "pg"), link("api", "pg")]
    );
    expect(positions.get("pg")!.x).toBe(LAYOUT_ORIGIN.x + 2 * LAYOUT_STEP.x);
  });

  it("keeps clients leftmost whatever points at them, terminates on cycles, and never overlaps", () => {
    const positions = layeredPositions(
      [node("a"), node("b"), node("browser", "client"), node("lonely")],
      [link("a", "b"), link("b", "a"), link("b", "browser")]
    );
    expect(positions.get("browser")!.x).toBe(LAYOUT_ORIGIN.x);
    expect(positions.size).toBe(4);
    expect(overlappingNodePair(boxes(positions))).toBeNull();
  });

  it("is deterministic and ignores links to unknown nodes", () => {
    const first = layeredPositions([node("a"), node("b")], [link("a", "ghost"), link("a", "b")]);
    const second = layeredPositions([node("a"), node("b")], [link("a", "ghost"), link("a", "b")]);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get("b")!.x).toBeGreaterThan(first.get("a")!.x);
  });
});

describe("layout contract", () => {
  it("names both nodes, their coordinates and both ways out when boxes overlap", () => {
    const issue = layoutIssue(boxes(new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 40 }]])));
    expect(issue?.code).toBe("node-overlap");
    expect(issue?.nodeIds).toEqual(["a", "b"]);
    expect(issue?.message).toContain('"a" at (0, 0)');
    expect(issue?.message).toContain("auto-layout");
    expect(layoutIssue(boxes(new Map([["a", { x: 0, y: 0 }], ["b", { x: 400, y: 0 }]])))).toBeNull();
  });

  it("gives palette nodes the first free grid slot", () => {
    const first = nextNodePosition([]);
    expect(first).toEqual({ x: LAYOUT_ORIGIN.x, y: LAYOUT_ORIGIN.y });
    const second = nextNodePosition([first]);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBe(first.y);
  });
});

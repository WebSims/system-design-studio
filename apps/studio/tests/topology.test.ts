import { describe, expect, it } from "vitest";
import { pizzaStudy } from "@sds/models";
import type { Design, SdsEdge } from "@sds/schema";
import {
  authoredReachability,
  compareDesignTopology,
  reachableDestinations,
  shortestDirectedRoute,
} from "../src/topology";

const original = pizzaStudy().candidates[0]!.design;

function cloneDesign(): Design {
  return structuredClone(original);
}

function edge(id: string, from: string, to: string): SdsEdge {
  return {
    ...structuredClone(original.edges[0]!),
    id,
    from,
    to,
  };
}

describe("authored topology exploration", () => {
  it("walks downstream through cycles once and keeps every authored link in the reached subgraph", () => {
    const design = cloneDesign();
    design.edges.push(edge("e-db-lb", "db", "lb"));

    const result = authoredReachability(design, "lb", "downstream");

    expect(result?.nodeIds).toEqual(["lb", "api", "db"]);
    expect(result?.edgeIds).toEqual(["e-lb-api", "e-api-db", "e-db-lb"]);
    expect(result?.depths).toEqual({ lb: 0, api: 1, db: 2 });
    expect(result?.maxDepth).toBe(2);
  });

  it("walks incoming edges for upstream reach", () => {
    const result = authoredReachability(original, "api", "upstream");

    expect(result?.nodeIds).toEqual(["api", "lb", "crowd"]);
    expect(result?.edgeIds).toEqual(["e-crowd-lb", "e-lb-api"]);
  });

  it("chooses a deterministic shortest route and refuses unreachable or zero-hop routes", () => {
    const design = cloneDesign();
    design.edges = [
      edge("e-crowd-lb", "crowd", "lb"),
      edge("e-lb-db", "lb", "db"),
      edge("e-crowd-api", "crowd", "api"),
      edge("e-api-db", "api", "db"),
    ];

    expect(shortestDirectedRoute(design, "crowd", "db")).toMatchObject({
      nodeIds: ["crowd", "lb", "db"],
      edgeIds: ["e-crowd-lb", "e-lb-db"],
      hops: 2,
    });
    expect(shortestDirectedRoute(design, "db", "crowd")).toBeNull();
    expect(shortestDirectedRoute(design, "crowd", "crowd")).toBeNull();
  });

  it("reports minimum hop counts for route destination choices", () => {
    expect(reachableDestinations(original, "crowd")).toEqual([
      { id: "lb", hops: 1 },
      { id: "api", hops: 2 },
      { id: "db", hops: 3 },
    ]);
  });
});

describe("exact-ID architecture delta", () => {
  it("separates settings, movement and topology changes", () => {
    const head = cloneDesign();
    const api = head.nodes.find((node) => node.id === "api")!;
    api.label = "claims API";
    api.x += 80;
    head.nodes.push({ ...structuredClone(api), id: "worker", label: "worker", x: api.x + 220 });
    head.edges = head.edges.filter((candidate) => candidate.id !== "e-api-db");
    head.edges.push(edge("e-api-worker", "api", "worker"));

    const delta = compareDesignTopology(original, head);

    expect(delta.comparable).toBe(true);
    expect(delta.summary).toEqual({
      nodesAdded: 1,
      nodesRemoved: 0,
      nodesChanged: 1,
      nodesMoved: 1,
      edgesAdded: 1,
      edgesRemoved: 1,
      edgesChanged: 0,
    });
    expect(delta.nodes.find((change) => change.id === "api")).toMatchObject({
      status: "changed",
      changedFields: ["label"],
      moved: true,
    });
  });

  it("marks regenerated component identities as non-comparable", () => {
    const head = cloneDesign();
    const renamed = new Map(head.nodes.map((node) => [node.id, `copy-${node.id}`]));
    head.nodes = head.nodes.map((node) => ({ ...node, id: renamed.get(node.id)! }));
    head.edges = head.edges.map((candidate) => ({
      ...candidate,
      id: `copy-${candidate.id}`,
      from: renamed.get(candidate.from)!,
      to: renamed.get(candidate.to)!,
    }));

    const delta = compareDesignTopology(original, head);

    expect(delta.comparable).toBe(false);
    expect(delta.sharedNodeIds).toEqual([]);
    expect(delta.summary.nodesAdded).toBe(original.nodes.length);
    expect(delta.summary.nodesRemoved).toBe(original.nodes.length);
  });
});

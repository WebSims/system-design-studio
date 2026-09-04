import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankStudy } from "@sds/schema";
import {
  clampToolboxPosition,
  DEFAULT_TOOLBOX_PREFS,
  parseToolboxPrefs,
  readToolboxPrefs,
  TOOLBOX_MARGIN,
  writeToolboxPrefs,
} from "../src/canvas/toolboxPrefs";
import { isRetiredDevelopmentStudyId, loadStudy, readUiPref, summariseStored, writeUiPref } from "../src/persist";
import { createCandidate } from "../src/study/mutations";

describe("retired development projects", () => {
  it("retires only the stable id used by the old bundled demo", () => {
    expect(isRetiredDevelopmentStudyId("limited-free-pizza")).toBe(true);
    expect(isRetiredDevelopmentStudyId("study-limited-free-pizza-review")).toBe(false);
    expect(isRetiredDevelopmentStudyId("my-pizza-service")).toBe(false);
    expect(isRetiredDevelopmentStudyId("study-user-project")).toBe(false);
  });

  it("refuses to reopen the retired demo before touching browser storage", async () => {
    await expect(loadStudy("limited-free-pizza")).resolves.toEqual({ status: "missing" });
  });
});

describe("the project list row", () => {
  it("carries the problem and whether any version is agent-drawn", () => {
    const human = blankStudy({ id: "s-human", name: "invoicing", problem: "each invoice once" });
    expect(summariseStored(human)).toMatchObject({
      id: "s-human",
      name: "invoicing",
      problem: "each invoice once",
      candidateCount: 0,
      hasAgentVersions: false,
    });

    const drawn = createCandidate(human, { label: "as-is", intent: "drawn", origin: "agent" }).study;
    expect(summariseStored(drawn)).toMatchObject({ candidateCount: 1, hasAgentVersions: true });
  });
});

describe("interface preferences", () => {
  const backing = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };

  beforeEach(() => {
    backing.clear();
    vi.stubGlobal("localStorage", fakeStorage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a value and validates it on the way back", () => {
    writeUiPref("probe", { dock: "top-right", collapsed: true });
    expect(readUiPref("probe", { dock: "top-left", collapsed: false }, (raw) => (typeof raw === "object" ? (raw as { dock: string; collapsed: boolean }) : null))).toEqual({
      dock: "top-right",
      collapsed: true,
    });
    expect(backing.has("sds.ui.probe")).toBe(true);
  });

  it("falls back when the stored value is missing, malformed or rejected", () => {
    expect(readUiPref("absent", 7, (raw) => (typeof raw === "number" ? raw : null))).toBe(7);
    backing.set("sds.ui.garbage", "{not json");
    expect(readUiPref("garbage", 7, (raw) => (typeof raw === "number" ? raw : null))).toBe(7);
    backing.set("sds.ui.wrong", JSON.stringify("a string"));
    expect(readUiPref("wrong", 7, (raw) => (typeof raw === "number" ? raw : null))).toBe(7);
  });

  it("stores the canvas toolbox state and refuses a position it cannot place", () => {
    writeToolboxPrefs({ x: 320, y: 48, collapsed: true, minimap: false });
    expect(readToolboxPrefs()).toEqual({ x: 320, y: 48, collapsed: true, minimap: false });

    // A value from before the pane moved freely names a dock, not an offset; it falls back.
    backing.set("sds.ui.canvas-toolbox", JSON.stringify({ dock: "bottom-right", collapsed: true }));
    expect(readToolboxPrefs()).toEqual(DEFAULT_TOOLBOX_PREFS);

    expect(parseToolboxPrefs({ x: 40, y: 20 })).toEqual({ x: 40, y: 20, collapsed: false, minimap: true });
    expect(parseToolboxPrefs({ x: -4, y: 20 })).toBeNull();
    expect(parseToolboxPrefs({ x: Number.NaN, y: 20 })).toBeNull();
    expect(parseToolboxPrefs(null)).toBeNull();
  });

  it("keeps the pane inside the canvas, a margin from every edge", () => {
    const pane = { width: 300, height: 120 };
    const canvas = { width: 1000, height: 600 };
    expect(clampToolboxPosition({ x: 200, y: 100 }, pane, canvas)).toEqual({ x: 200, y: 100 });
    expect(clampToolboxPosition({ x: -50, y: -50 }, pane, canvas)).toEqual({ x: TOOLBOX_MARGIN, y: TOOLBOX_MARGIN });
    expect(clampToolboxPosition({ x: 5000, y: 5000 }, pane, canvas)).toEqual({
      x: canvas.width - pane.width - TOOLBOX_MARGIN,
      y: canvas.height - pane.height - TOOLBOX_MARGIN,
    });
    // A pane wider than the canvas pins to the margin rather than going negative.
    expect(clampToolboxPosition({ x: 100, y: 10 }, { width: 2000, height: 120 }, canvas)).toEqual({ x: TOOLBOX_MARGIN, y: TOOLBOX_MARGIN });
  });
});

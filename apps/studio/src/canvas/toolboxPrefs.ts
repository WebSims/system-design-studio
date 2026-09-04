import { readUiPref, writeUiPref } from "../persist"

/**
 * Where the canvas toolbox sits and how it is folded, as data.
 *
 * The pane sits anywhere on the canvas; `x` and `y` are its offset from the canvas's top-left
 * corner in CSS pixels. Positions are always clamped against the canvas box before they are
 * applied or stored, so the pane can never be lost off-screen, and a stale value from a larger
 * window is pulled back inside on the next render.
 */
export interface ToolboxPosition {
  x: number
  y: number
}

export interface ToolboxPrefs extends ToolboxPosition {
  collapsed: boolean
  minimap: boolean
}

export interface BoxSize {
  width: number
  height: number
}

/** Space kept between the pane and the canvas edge. */
export const TOOLBOX_MARGIN = 14

export const DEFAULT_TOOLBOX_PREFS: ToolboxPrefs = { x: TOOLBOX_MARGIN, y: TOOLBOX_MARGIN, collapsed: false, minimap: true }
export const TOOLBOX_PREF_KEY = "canvas-toolbox"

const isOffset = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

/** A stale or hand-edited value falls back to the default rather than reaching the interface. */
export const parseToolboxPrefs = (raw: unknown): ToolboxPrefs | null => {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!isOffset(record.x) || !isOffset(record.y)) return null
  return {
    x: record.x,
    y: record.y,
    collapsed: record.collapsed === true,
    minimap: record.minimap !== false,
  }
}

export const readToolboxPrefs = (): ToolboxPrefs => readUiPref(TOOLBOX_PREF_KEY, DEFAULT_TOOLBOX_PREFS, parseToolboxPrefs)
export const writeToolboxPrefs = (prefs: ToolboxPrefs): void => writeUiPref(TOOLBOX_PREF_KEY, prefs)

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high))

/**
 * The nearest position that keeps the whole pane inside the canvas, a margin from the edge.
 * A pane wider than the canvas pins to the margin rather than going negative.
 */
export const clampToolboxPosition = (position: ToolboxPosition, pane: BoxSize, canvas: BoxSize): ToolboxPosition => ({
  x: Math.round(clamp(position.x, TOOLBOX_MARGIN, canvas.width - pane.width - TOOLBOX_MARGIN)),
  y: Math.round(clamp(position.y, TOOLBOX_MARGIN, canvas.height - pane.height - TOOLBOX_MARGIN)),
})

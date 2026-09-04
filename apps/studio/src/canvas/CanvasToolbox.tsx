import { Panel } from "@xyflow/react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons"
import {
  clampToolboxPosition,
  readToolboxPrefs,
  writeToolboxPrefs,
  type ToolboxPosition,
  type ToolboxPrefs,
} from "./toolboxPrefs"

/**
 * One floating pane for every canvas tool.
 *
 * WHY ONE PANE
 *
 * The canvas used to carry a topology explorer in one corner and a Link button that appeared once
 * two nodes existed in another; neither could be moved out of the way of the thing a person was
 * looking at. This pane holds both on one row, goes wherever it is dragged by its header, collapses
 * to a pill, and remembers all of that across reloads. Zoom stays in React Flow's own controls at
 * the bottom-left and the minimap folds in place at the bottom-right, so the pane is only about
 * the drawing's structure.
 *
 * The position is clamped to the canvas on every drag step, on collapse, and whenever the canvas
 * is resized, so the pane can never be lost off-screen.
 */

export const useCanvasToolboxPrefs = (): [ToolboxPrefs, (patch: Partial<ToolboxPrefs>) => void] => {
  const [prefs, setPrefs] = useState<ToolboxPrefs>(readToolboxPrefs)
  const update = useCallback((patch: Partial<ToolboxPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writeToolboxPrefs(next)
      return next
    })
  }, [])
  return [prefs, update]
}

interface CanvasToolboxProps {
  prefs: ToolboxPrefs
  onPrefs(patch: Partial<ToolboxPrefs>): void
  /** The topology rows (Find, Route, Upstream, Downstream, Link). */
  children: ReactNode
  /** Shown on the collapsed pill so a link in progress is never invisible. */
  linking: boolean
}

interface DragStart {
  pointerId: number
  pointerX: number
  pointerY: number
  paneX: number
  paneY: number
}

const canvasOf = (element: HTMLElement): HTMLElement | null => element.closest<HTMLElement>(".canvas-wrap")

export const CanvasToolbox = ({ prefs, onPrefs, children, linking }: CanvasToolboxProps) => {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const dragStart = useRef<DragStart | null>(null)
  const [dragging, setDragging] = useState(false)
  /** The position painted right now; equals the stored one except mid-drag. */
  const [position, setPosition] = useState<ToolboxPosition>({ x: prefs.x, y: prefs.y })

  useEffect(() => {
    if (dragStart.current) return
    setPosition({ x: prefs.x, y: prefs.y })
  }, [prefs.x, prefs.y])

  /** Pull the pane back inside the canvas after a resize, a collapse or a stale stored value. */
  const keepInside = useCallback(
    (candidate: ToolboxPosition): ToolboxPosition => {
      const pane = paneRef.current
      const canvas = pane ? canvasOf(pane) : null
      // An unlaid-out canvas has no size yet; clamping against it would pin the pane to the corner.
      if (!pane || !canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return candidate
      return clampToolboxPosition(
        candidate,
        { width: pane.offsetWidth, height: pane.offsetHeight },
        { width: canvas.clientWidth, height: canvas.clientHeight }
      )
    },
    []
  )

  useLayoutEffect(() => {
    if (dragStart.current) return
    const inside = keepInside({ x: prefs.x, y: prefs.y })
    if (inside.x !== prefs.x || inside.y !== prefs.y) onPrefs(inside)
  }, [prefs.x, prefs.y, prefs.collapsed, keepInside, onPrefs])

  useEffect(() => {
    const pane = paneRef.current
    const canvas = pane ? canvasOf(pane) : null
    if (!canvas || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (dragStart.current) return
      const inside = keepInside({ x: prefs.x, y: prefs.y })
      if (inside.x !== prefs.x || inside.y !== prefs.y) onPrefs(inside)
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [prefs.x, prefs.y, keepInside, onPrefs])

  const onHeadDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    // Buttons in the header keep their click; everything else is a handle.
    if ((event.target as HTMLElement).closest("button")) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      paneX: position.x,
      paneY: position.y,
    }
    setDragging(true)
  }

  const onHeadMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    setPosition(
      keepInside({
        x: start.paneX + event.clientX - start.pointerX,
        y: start.paneY + event.clientY - start.pointerY,
      })
    )
  }

  const onHeadUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    dragStart.current = null
    setDragging(false)
    const settled = keepInside({
      x: start.paneX + event.clientX - start.pointerX,
      y: start.paneY + event.clientY - start.pointerY,
    })
    setPosition(settled)
    if (settled.x !== prefs.x || settled.y !== prefs.y) onPrefs(settled)
  }

  return (
    <Panel
      position="top-left"
      className={`canvas-toolbox ${prefs.collapsed ? "collapsed" : ""} ${dragging ? "dragging" : ""}`}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      aria-label="Canvas tools"
    >
      <div ref={paneRef} className="toolbox-pane">
        <header
          className="toolbox-head nodrag nopan"
          title="Drag to move the tools"
          onPointerDown={onHeadDown}
          onPointerMove={onHeadMove}
          onPointerUp={onHeadUp}
          onPointerCancel={onHeadUp}
        >
          <span className="toolbox-grip" aria-hidden="true">
            {"\u2059"}
          </span>
          <span className="toolbox-title">Tools</span>
          {linking && prefs.collapsed && <span className="toolbox-pill-note">linking…</span>}
          <button
            type="button"
            className="toolbox-btn nodrag nopan"
            aria-expanded={!prefs.collapsed}
            aria-label={prefs.collapsed ? "Expand the tools" : "Collapse the tools"}
            title={prefs.collapsed ? "Expand (or press /)" : "Collapse to a pill"}
            onClick={() => onPrefs({ collapsed: !prefs.collapsed })}
          >
            {prefs.collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} className="flip" />}
          </button>
        </header>

        {!prefs.collapsed && <div className="toolbox-body">{children}</div>}
      </div>
    </Panel>
  )
}

interface LinkActionProps {
  linking: boolean
  linkFrom: string | null
  linkFromLabel: string | null
  linkableTargets: number
  nodeCount: number
  onToggleLinking(): void
}

/** The Link action and its in-progress hint; sits at the end of the topology row. */
export const LinkAction = ({ linking, linkFrom, linkFromLabel, linkableTargets, nodeCount, onToggleLinking }: LinkActionProps) => {
  const linkDisabled = nodeCount < 2 || linkableTargets === 0
  const linkTitle = linkDisabled
    ? nodeCount < 2
      ? "Add a second component to link them."
      : "Every component here is a client; clients receive no links."
    : "Make a link by clicking two components in turn. You can also drag from a component's right handle to another's left."

  return (
    <>
      <button
        type="button"
        className={`topology-action nodrag nopan ${linking ? "active" : ""}`}
        onClick={onToggleLinking}
        aria-pressed={linking}
        disabled={linkDisabled}
        title={linkTitle}
      >
        {linking ? "Linking\u2026" : "Link"}
      </button>
      {linking && (
        <span className="link-hint">
          {linkFrom ? `now click the component ${linkFromLabel ?? "it"} calls` : "click the component that makes the call"}
          <span className="muted">{" \u00b7 Esc to cancel"}</span>
        </span>
      )}
    </>
  )
}

interface MinimapChromeProps {
  shown: boolean
  onToggle(): void
}

/**
 * A minimise button over the minimap's corner, and the small pill that brings it back.
 * Lives in the same corner as the minimap so the map folds and unfolds in place.
 */
export const MinimapChrome = ({ shown, onToggle }: MinimapChromeProps) => (
  <Panel position="bottom-right" className={`minimap-chrome ${shown ? "over-map" : "folded"}`}>
    <button
      type="button"
      className="toolbox-btn minimap-fold nodrag nopan"
      aria-pressed={shown}
      aria-label={shown ? "Minimise the minimap" : "Show the minimap"}
      title={shown ? "Minimise the minimap" : "Show the minimap"}
      onClick={onToggle}
    >
      {shown ? <ChevronDownIcon size={12} /> : <span className="minimap-fold-label">map</span>}
    </button>
  </Panel>
)

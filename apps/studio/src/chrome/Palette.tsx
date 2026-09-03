import { useEffect, useRef, useState } from "react"
import type { ComponentPreset } from "@sds/models"
import { KindIcon, SearchIcon } from "../ui/icons"
import { filterGroups } from "./presetGroups"
import { useAddPreset } from "./useAddPreset"

/** The coloured square that identifies a component kind wherever it appears. */
export const KindTile = ({ preset, size = 16 }: { preset: ComponentPreset; size?: number }) => (
  <span className={`kind-tile kind-${preset.kind}`} aria-hidden="true">
    <KindIcon kind={preset.kind} presetId={preset.id} size={size} />
  </span>
)

/**
 * The component palette.
 *
 * Sectioned by the question the component answers, filterable by name, kind or blurb, and each card
 * carries the glyph the node will wear on the canvas so the menu and the drawing read the same. The
 * blurb says when the component is the wrong choice, which is the more useful half.
 */
export const Palette = ({ onClose }: { onClose: () => void }) => {
  const add = useAddPreset()
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const groups = filterGroups(query)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const pick = (presetId: string) => {
    add(presetId)
    onClose()
  }

  return (
    <div className="palette component-palette" role="dialog" aria-label="Add component" onClick={(e) => e.stopPropagation()}>
      <div className="palette-head">
        <span className="palette-title">add component</span>
        <label className="palette-search">
          <SearchIcon size={13} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Filter by name or kind"
            aria-label="Filter components"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {groups.length === 0 && <p className="palette-empty muted">Nothing matches &ldquo;{query.trim()}&rdquo;.</p>}

      {groups.map((group) => (
        <section key={group.id} className="palette-group" aria-label={group.label}>
          <h3 className="palette-group-head">
            {group.label}
            {group.hint && <span className="palette-group-hint">{group.hint}</span>}
          </h3>
          <div className="palette-grid">
            {group.presets.map((preset) => (
              <button key={preset.id} className="palette-card" title={preset.blurb} onClick={() => pick(preset.id)}>
                <KindTile preset={preset} />
                <span className="palette-body">
                  <span className="palette-label">{preset.label}</span>
                  <span className="palette-blurb">{preset.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

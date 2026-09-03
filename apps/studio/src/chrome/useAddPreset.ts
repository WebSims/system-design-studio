import { useCallback } from "react"
import { PRESET_BY_ID } from "@sds/models"
import { nextNodeId } from "../ids"
import { useStudio } from "../store"

/**
 * Drop a preset onto the canvas, to the right of everything already there, and select it.
 *
 * Every preset is assembled from the cited benchmark library, so the new node starts at a defensible
 * number with visible provenance rather than at a placeholder. Shared by the palette menu and the
 * quick-insert strip so both doors lead to the same room.
 */
export const useAddPreset = () => {
  const edit = useStudio((s) => s.edit)
  const select = useStudio((s) => s.select)

  return useCallback(
    (presetId: string) => {
      const preset = PRESET_BY_ID[presetId]
      if (!preset) return
      edit((d) => {
        const id = nextNodeId(preset.kind, d.nodes.map((n) => n.id))
        const maxX = d.nodes.reduce((m, n) => Math.max(m, n.x), 0)
        d.nodes.push(preset.build(id, maxX + 300, 240))
      })
      // Select the new node so the inspector opens on it immediately.
      setTimeout(() => {
        const nodes = useStudio.getState().design.nodes
        const last = nodes[nodes.length - 1]
        if (last) select({ kind: "node", id: last.id })
      }, 0)
    },
    [edit, select]
  )
}

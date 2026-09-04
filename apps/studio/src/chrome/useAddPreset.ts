import { useCallback } from "react"
import { PRESET_BY_ID } from "@sds/models"
import { nextNodeId } from "../ids"
import { useStudio } from "../store"
import { nextNodePosition } from "../canvas/layout"

/**
 * Add a preset at an exact drop coordinate, or in the next free grid slot, and select it.
 *
 * Every preset is assembled from the cited benchmark library, so the new node starts at a defensible
 * number with visible provenance rather than at a placeholder. Shared by the palette menu and the
 * quick-insert strip so both doors lead to the same room.
 */
export const useAddPreset = () => {
  const edit = useStudio((s) => s.edit)
  const select = useStudio((s) => s.select)

  return useCallback(
    (presetId: string, position?: { x: number; y: number }) => {
      const preset = PRESET_BY_ID[presetId]
      if (!preset) return
      let addedId: string | null = null
      edit((d) => {
        const id = nextNodeId(preset.kind, d.nodes.map((n) => n.id))
        const { x, y } = position ?? nextNodePosition(d.nodes)
        d.nodes.push(preset.build(id, x, y))
        addedId = id
      })
      // Select the new node so the inspector opens on it immediately.
      if (addedId) select({ kind: "node", id: addedId })
    },
    [edit, select]
  )
}

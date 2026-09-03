import { PRESETS, type ComponentPreset } from "@sds/models"

/**
 * How the palette is sectioned.
 *
 * Grouped by the question a designer is answering, not by schema kind: "where does traffic come
 * from", "what does the work", "where does the data live", "who keeps order". A preset the groups
 * do not name still shows, under "other", so adding a preset never hides it.
 */
export interface PresetGroup {
  id: string
  label: string
  hint: string
  presets: ComponentPreset[]
}

const GROUP_SPEC: Array<Omit<PresetGroup, "presets"> & { presetIds: string[] }> = [
  { id: "traffic", label: "Traffic", hint: "where requests enter and how they are spread", presetIds: ["client", "gateway", "loadbalancer"] },
  { id: "compute", label: "Compute", hint: "what does the work", presetIds: ["app-server", "external-api"] },
  { id: "data", label: "Data", hint: "where state lives", presetIds: ["redis-cache", "postgres", "object-store"] },
  { id: "coordination", label: "Coordination", hint: "who keeps order between requests", presetIds: ["queue", "lock"] },
]

const byId = new Map(PRESETS.map((preset) => [preset.id, preset]))

const named = new Set(GROUP_SPEC.flatMap((group) => group.presetIds))
const unnamed = PRESETS.filter((preset) => !named.has(preset.id))

export const PRESET_GROUPS: PresetGroup[] = [
  ...GROUP_SPEC.map(({ presetIds, ...group }) => ({
    ...group,
    presets: presetIds.flatMap((id) => {
      const preset = byId.get(id)
      return preset ? [preset] : []
    }),
  })),
  ...(unnamed.length > 0 ? [{ id: "other", label: "Other", hint: "", presets: unnamed }] : []),
].filter((group) => group.presets.length > 0)

/** Presets in palette order: grouped, so the quick-insert strip and the menu agree. */
export const ORDERED_PRESETS: ComponentPreset[] = PRESET_GROUPS.flatMap((group) => group.presets)

const matches = (preset: ComponentPreset, needle: string) =>
  preset.label.toLowerCase().includes(needle) ||
  preset.kind.toLowerCase().includes(needle) ||
  preset.blurb.toLowerCase().includes(needle)

export const filterGroups = (query: string): PresetGroup[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return PRESET_GROUPS
  return PRESET_GROUPS.map((group) => ({
    ...group,
    presets: group.presets.filter((preset) => matches(preset, needle)),
  })).filter((group) => group.presets.length > 0)
}

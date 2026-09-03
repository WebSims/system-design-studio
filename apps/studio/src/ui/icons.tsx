import type { ReactNode, SVGProps } from "react"
import type { NodeKind } from "@sds/schema"

/**
 * Inline stroke icons, 24-unit grid, drawn with `currentColor`.
 *
 * No icon dependency: the studio ships a handful of glyphs and every one of them is here. A glyph
 * is decorative by default (`aria-hidden`); the control it sits in carries the accessible name.
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number }
export type IconComponent = (props: IconProps) => JSX.Element

const makeIcon = (paths: ReactNode): IconComponent => {
  const Glyph = ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths}
    </svg>
  )
  return Glyph
}

/* ---------- actions ---------- */

export const PlusIcon = makeIcon(<path d="M12 5v14M5 12h14" />)
export const ChevronDownIcon = makeIcon(<path d="m6 9 6 6 6-6" />)
export const CloseIcon = makeIcon(<path d="M18 6 6 18M6 6l12 12" />)
export const CheckIcon = makeIcon(<path d="M20 6 9 17l-5-5" />)
export const SearchIcon = makeIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
)
export const PlayIcon = makeIcon(<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />)
export const PauseIcon = makeIcon(
  <>
    <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  </>
)
export const StopIcon = makeIcon(<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />)
export const DownloadIcon = makeIcon(<path d="M12 3v12M7 10l5 5 5-5M4 20h16" />)
export const UploadIcon = makeIcon(<path d="M12 15V3M7 8l5-5 5 5M4 20h16" />)
export const BotIcon = makeIcon(
  <>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 17h6" />
    <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
  </>
)
export const CompareIcon = makeIcon(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7.5M11 18H8a2 2 0 0 1-2-2V8.5" />
    <path d="m14.5 4.5 1.5 1.5-1.5 1.5M9.5 16.5 8 18l1.5 1.5" />
  </>
)
export const BranchIcon = makeIcon(
  <>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="7" r="2.5" />
    <path d="M6 8.5v7M18 9.5a7 7 0 0 1-7 6.5H8.5" />
  </>
)
export const GaugeIcon = makeIcon(
  <>
    <path d="M4 16.5a8.5 8.5 0 1 1 16 0" />
    <path d="m12 14 4-4.5" />
    <circle cx="12" cy="14" r="1.25" fill="currentColor" stroke="none" />
  </>
)

/* ---------- component kinds ---------- */

const ClientIcon = makeIcon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>
)
const LoadBalancerIcon = makeIcon(
  <>
    <path d="M3 12h5" />
    <path d="M8 12c4 0 4-5 8-5h5M8 12c4 0 4 5 8 5h5" />
    <path d="m18.5 4.5 2.5 2.5-2.5 2.5M18.5 14.5l2.5 2.5-2.5 2.5" />
  </>
)
const ServerIcon = makeIcon(
  <>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" strokeWidth={2.5} />
  </>
)
const CacheIcon = makeIcon(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />)
const DatabaseIcon = makeIcon(
  <>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </>
)
const QueueIcon = makeIcon(
  <>
    <rect x="2.5" y="8" width="5" height="8" rx="1" />
    <rect x="9.5" y="8" width="5" height="8" rx="1" />
    <rect x="16.5" y="8" width="5" height="8" rx="1" />
  </>
)
const GatewayIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4" />
    <path d="M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2" />
  </>
)
const LockIcon = makeIcon(
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>
)
const ObjectStoreIcon = makeIcon(
  <>
    <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5M12 13v8" />
  </>
)
const ExternalApiIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>
)

/** One glyph per schema kind. Exhaustive, so a new kind fails to compile rather than renders blank. */
export const KIND_ICONS: Record<NodeKind, IconComponent> = {
  client: ClientIcon,
  loadbalancer: LoadBalancerIcon,
  server: ServerIcon,
  cache: CacheIcon,
  database: DatabaseIcon,
  queue: QueueIcon,
  gateway: GatewayIcon,
  lock: LockIcon,
}

/**
 * Presets that share a schema kind but mean something different on a drawing. An object store and a
 * third-party API are both `server` to the engine; to a reader they are a bucket and a globe.
 */
const PRESET_ICONS: Record<string, IconComponent> = {
  "object-store": ObjectStoreIcon,
  "external-api": ExternalApiIcon,
}

export const iconForKind = (kind: NodeKind, presetId?: string): IconComponent =>
  (presetId && PRESET_ICONS[presetId]) || KIND_ICONS[kind]

export const KindIcon = ({ kind, presetId, ...rest }: IconProps & { kind: NodeKind; presetId?: string }) => {
  const Glyph = iconForKind(kind, presetId)
  return <Glyph {...rest} />
}

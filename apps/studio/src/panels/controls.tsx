/**
 * Form primitives shared by the inspector panels.
 *
 * Small on purpose: a label, a clamped number, a toggle, a select. Anything richer lives
 * next to the thing it edits.
 */

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** Two (or three) short fields side by side, for numbers that are read as a pair. */
export const FieldRow = ({ children }: { children: React.ReactNode }) => <div className="field-row">{children}</div>

/**
 * A glyph-only button. The label is mandatory and becomes both the accessible name and the
 * tooltip, so an icon never ships without a word behind it.
 */
export const IconButton = ({
  label,
  tone,
  size = "md",
  className,
  disabled,
  onClick,
  children,
}: {
  label: string
  tone?: "danger" | "quiet"
  size?: "sm" | "md"
  className?: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) => (
  <button
    type="button"
    className={["icon-btn", `icon-btn-${size}`, tone ?? "", className ?? ""].filter(Boolean).join(" ")}
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
)

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <input
      type="number"
      className="input tnum"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!Number.isFinite(v)) return
        /**
         * Clamp here rather than at each call site.
         *
         * `min` and `max` on a number input are advisory: the browser will happily let
         * you type past them, and every call site was clamping the lower bound by hand
         * and none the upper. Typing a concurrency of 1e9 froze the studio outright,
         * because the closed-form solvers are linear in the server count and the live
         * preview evaluates them on every keystroke.
         */
        const lo = min ?? -Infinity
        const hi = max ?? Infinity
        onChange(Math.min(hi, Math.max(lo, v)))
      }}
    />
  )
}

export function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint?: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button className={`toggle-row ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span className="toggle-switch">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-body">
        <span>{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </button>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

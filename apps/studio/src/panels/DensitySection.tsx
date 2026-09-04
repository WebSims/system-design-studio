import { useState, type ReactNode } from "react";
import { useStudyStore } from "../study/store";

interface DensitySectionProps {
  title: string;
  summary: string;
  children: ReactNode;
  className?: string;
}

/**
 * One model, two levels of disclosure.
 *
 * Guided mode keeps the summary in view and lets a person opt into the full controls. Expert mode
 * renders those same controls expanded, so changing density never changes or resets model data.
 */
export function DensitySection({ title, summary, children, className = "" }: DensitySectionProps) {
  const density = useStudyStore((state) => state.uiDensity);
  const [openByMode, setOpenByMode] = useState({ guided: false, expert: true });
  const expert = density === "expert";
  const open = expert ? openByMode.expert : openByMode.guided;
  const classes = `density-section ${expert ? "density-section-expanded" : "density-section-collapsible"} ${className}`.trim();

  return (
    <details
      className={classes}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpenByMode((current) =>
          current[density] === nextOpen ? current : { ...current, [density]: nextOpen }
        );
      }}
    >
      <summary
        title={open ? "Hide advanced controls" : "Show advanced controls"}
      >
        <span>
          <span className="density-section-title">{title}</span>
          <span className="density-section-summary">{summary}</span>
        </span>
        <span className="density-section-state">{expert ? "Expert" : "Advanced"}</span>
      </summary>
      <div className="density-section-body">{children}</div>
    </details>
  );
}

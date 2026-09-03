export type EvidenceTone = "observed" | "inferred" | "assumed" | "uncovered";
export type PerformanceInputState = "calibrated" | "estimated" | "unknown";

/**
 * Keep the three materially different states separate on the canvas.
 *
 * A positive value with explicit placeholder provenance is an estimate, not an unknown. A schema
 * sentinel or an uncited value is unknown, not zero. Only a freehand model or a repository target
 * backed by accepted measurement evidence may present the number without qualification.
 */
export function performanceInputState(input: {
  repositoryLinked: boolean;
  calibrated: boolean;
  hasPerformanceEvidence: boolean;
  usable: boolean;
}): PerformanceInputState {
  if (!input.usable) return "unknown";
  if (!input.repositoryLinked || input.calibrated) return "calibrated";
  return input.hasPerformanceEvidence ? "estimated" : "unknown";
}

export function latencyLabel(latencyMs: number, state: PerformanceInputState): string {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0 || state === "unknown") return "?ms";
  return `${state === "estimated" ? "≈" : ""}${latencyMs}ms`;
}

/**
 * What an idle repository-linked card says about the model inputs it is showing.
 *
 * "Estimated" hid the important distinction: a solver preview based on placeholder inputs looked
 * like one based on cited configuration. Architecture evidence already carries that distinction,
 * so put it beside the numbers. A completed simulation is labelled separately as measured.
 */
export function modelInputLabel(repositoryLinked: boolean, tone: EvidenceTone | undefined): string {
  if (!repositoryLinked) return "model preview";
  switch (tone) {
    case "assumed":
      return "assumed inputs";
    case "inferred":
      return "inferred inputs";
    case "uncovered":
      return "unverified inputs";
    default:
      return "model preview";
  }
}

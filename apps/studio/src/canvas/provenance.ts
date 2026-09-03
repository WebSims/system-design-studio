export type EvidenceTone = "observed" | "inferred" | "assumed" | "uncovered";

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

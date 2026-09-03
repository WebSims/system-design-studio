/**
 * The single MVP handoff from a person to the coding agent sharing this page through WebMCP.
 *
 * This is visible user text, not a hidden system prompt. Repository inspection remains the
 * agent's job; the registered site tools only carry the evidence-backed model into the page.
 */
export const CODEBASE_PROMPT =
  "Use the System Design Studio tools available on this page to create a system design from this codebase. " +
  "Inspect the repository before drawing anything: identify entry points, services, background jobs, data stores, queues, caches, external APIs, configuration, and deployment boundaries. " +
  "Create a clean Studio design workspace with studio_create_study, read the modelling vocabulary with studio_get_catalog, and use studio_update_study to record the workload, SLOs, business outcomes, and correctness invariants that the code or documentation supports. " +
  "Then call studio_import_architecture with the current branch, commit, dirty state, and inspected scope. Cite a source path, symbol, and line range for every observed component and connection; label deductions inferred and unknown production behaviour assumed. " +
  "Show the as-is architecture on the canvas, summarise evidence gaps and likely production risks, and stop. Do not redesign the system or edit code until I ask.";

export const CODEBASE_PROMPT_ROUTE = [
  "inspect the codebase",
  "define the system yardstick",
  "import the as-is design",
  "show evidence gaps",
] as const;

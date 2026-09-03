# Archify review and adaptation

Reviewed: [tt-a1i/archify](https://github.com/tt-a1i/archify) at commit
`06dd052602dd9a369e4d034e24faef0917b5a60c` (2026-09-02).

Archify and System Design Studio both make architecture inspectable, but they optimize
for different jobs. Archify turns a repository into a deterministic communication
artifact: typed JSON intermediate representations are rendered as static HTML/SVG
diagrams and exports. System Design Studio is an executable decision lab: candidates
share a study contract, are searched for races, simulated under the same scenarios,
filtered by evidence and finally promoted by a human.

## Adopted now

### Graph-grounded exploration

The design canvas now has a topology explorer with:

- search by label, stable ID or component kind;
- upstream and downstream reach over authored directed edges;
- shortest authored directed routes with hop counts;
- exact highlighting on the existing React Flow canvas; and
- explicit receipts stating that topology is shown and runtime impact is not inferred.

The analysis is derived from stable IDs and edge direction, never from rendered
geometry. Cycles are safe and path ties are deterministic by document edge order.

### Architecture delta

Compare now includes an exact-ID structural delta between any two candidates. It
separates added, removed, changed and moved nodes from added, removed and changed
edges, and lists the affected IDs. If candidates share no node IDs, the UI declines
to present field-level changes as a reliable comparison.

This is deliberately narrower than semantic architecture diffing. A regenerated ID
cannot safely be guessed to represent the same component.

## Strengths we already had

Several gaps that Archify calls out are already first-class in this app:

- versioned Zod schemas and migrations;
- draft validation before study mutations;
- revision locks that prevent stale engine results from being applied;
- fail-safe project import and persisted-state loading;
- repairable diagnostics with paths and stable entity IDs;
- bounded correctness claims rather than proof language;
- a shared study contract for fair candidate evaluation; and
- human-only promotion and deletion.

These are important because the studio does more than explain a system: it produces
evidence that can influence a design decision.

## Useful gaps, deliberately deferred

### Repository evidence and provenance

Archify's strongest idea is traceability from a visual claim back to source evidence.
For this studio, repository ingestion should not be added as a loose prompt feature.
It needs a versioned evidence schema containing repository, revision, source path,
symbol or line anchor, extraction method and freshness. Claims without a pinned
revision would become stale silently.

### Guided views

Archify can present a large model through curated views. A later studio iteration
could save named focus sets, routes and comparison lenses inside the project schema.
That should come after a migration design so saved views remain durable.

### Shareable deep links

The studio currently stores projects in IndexedDB. A URL can identify a project,
candidate and view, but it cannot make the underlying local project available on
another machine. Real sharing therefore needs an export payload or hosted storage,
plus schema-version and integrity checks.

### Visual exports

SVG/PNG/PDF exports are useful for reviews, but an export must include candidate ID,
study revision, bounds and currentness. A screenshot without those receipts would
strip away the truth boundary that makes the studio trustworthy.

## Not adopted

- Archify's five separate diagram IRs: the studio needs one executable design model,
  not parallel descriptive models that can drift.
- Preset visual brands: useful for documentation, but lower value than evidence,
  accessibility and comparison semantics here.
- Decorative diagram motion: reach and route highlighting communicates state without
  making a static architecture feel live or causal.
- Hosted-share behavior without a storage and privacy model.

## Verification

The topology algorithms have unit coverage for cycles, reverse reach, deterministic
shortest routes, hop counts, exact-ID deltas and regenerated-ID refusal. Browser
checks cover search, reach highlighting, route highlighting and the comparison delta.

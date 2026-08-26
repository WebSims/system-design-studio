/**
 * Id generation for new graph elements.
 *
 * Ids are content-independent and collision-checked against the existing set
 * rather than derived from a global counter. A global counter is what the legacy
 * code used (`data.jsx:124`), and it resets on reload, so an id could collide with
 * one already persisted in localStorage.
 */
function unique(prefix: string, taken: string[]): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

export const nextNodeId = (kind: string, taken: string[]): string => unique(kind, taken);
export const protocolFreeEdgeId = (taken: string[]): string => unique("e", taken);

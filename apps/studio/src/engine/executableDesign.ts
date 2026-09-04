import type { Design } from "@sds/schema";

/** Geometry is presentation state; every other design field affects session input or output. */
export function executableDesignFingerprint(design: Design): string {
  return JSON.stringify({
    ...design,
    nodes: design.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  });
}

export function executableDesignChanged(before: Design, after: Design): boolean {
  return executableDesignFingerprint(before) !== executableDesignFingerprint(after);
}

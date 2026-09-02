import type { Design, ResourceAccounting, SdsNode } from "@sds/schema";
import type { RunResult } from "@sds/core";

/**
 * Physical resource accounting.
 *
 * NO PRICES. NOT NOW, NOT LATER, NOT BEHIND A SETTING.
 *
 * A price is a claim about a vendor's rate card on a particular day in a particular region
 * under a particular commitment, and this tool has no way to check any of that. Multiplying a
 * made-up hourly rate by a simulated hour would produce the most confident-looking and least
 * defensible number in the product, and it would be the one people quoted. So the accounting
 * stops at units that are properties of the design rather than of a contract, and the
 * multiplication is left to whoever has seen their own bill.
 *
 * UNKNOWN IS NOT ZERO, AND THIS IS THE WHOLE FILE
 *
 * A node with no measured resource profile contributes UNKNOWN to every axis it touches, and
 * unknown poisons the axis for the entire candidate. The alternative -- treating a missing
 * value as zero -- makes the design nobody has measured look free, so it wins the comparison
 * on cost while contributing no information at all. That is not a rounding error; it is a
 * systematic bias in favour of ignorance, and it would show up precisely on the candidates a
 * user had just invented and had no numbers for.
 *
 * The cost of the honest behaviour is that a study with one unmeasured node cannot be ranked
 * on that axis. That is inconvenient and it is correct, and the report names the nodes to go
 * and measure.
 */

export interface ResourceInput {
  design: Design;
  /** A representative run, for the traffic-dependent axes. */
  run: RunResult | null;
}

const AXES = ["cpuUnits", "memoryMb", "storageMb", "connectionSlots", "networkBytes"] as const;
export type ResourceAxis = (typeof AXES)[number];

/**
 * How many instances of a node exist.
 *
 * Replicas where the component has them, one otherwise. A resource profile describes ONE
 * instance -- that is what makes it a citable figure -- so a four-replica service costs four
 * times its profile, and a candidate that scaled out to meet the SLO pays for it here rather
 * than winning on latency for free.
 */
function instancesOf(node: SdsNode): number {
  switch (node.kind) {
    case "server":
      return node.server?.replicas ?? 1;
    case "gateway":
      return node.gateway?.replicas ?? 1;
    default:
      return 1;
  }
}

/**
 * Which nodes are charged for at all.
 *
 * Clients are not: they are the workload, not the system. Charging for them would add a
 * constant to every candidate and make the axis less discriminating while looking more
 * thorough.
 */
function isCharged(node: SdsNode): boolean {
  return node.kind !== "client";
}

export function accountResources(input: ResourceInput): ResourceAccounting {
  const totals: Record<ResourceAxis, number> = {
    cpuUnits: 0,
    memoryMb: 0,
    storageMb: 0,
    connectionSlots: 0,
    networkBytes: 0,
  };
  const unknown = new Set<ResourceAxis>();
  const unmeasured: string[] = [];

  // Network is per-request, so it needs a request count. Without a run there is no count,
  // and the axis is unknown rather than zero -- the same rule as a missing profile.
  const requests = input.run ? input.run.throughputPerSec * input.run.observedSec : null;

  for (const node of input.design.nodes) {
    if (!isCharged(node)) continue;
    const profile = node.resources;
    const instances = instancesOf(node);

    if (!profile) {
      unmeasured.push(node.label || node.id);
      for (const axis of AXES) unknown.add(axis);
      continue;
    }

    if (profile.cpuUnits === null) unknown.add("cpuUnits");
    else totals.cpuUnits += profile.cpuUnits * instances;

    if (profile.memoryMb === null) unknown.add("memoryMb");
    else totals.memoryMb += profile.memoryMb * instances;

    // Storage is the one axis where absent legitimately means "none".
    //
    // A load balancer holds nothing durable, and demanding a measurement of zero from every
    // stateless component would put every candidate's storage axis into unknown and make the
    // axis useless. So a stateless kind with no storage figure contributes zero, and a
    // DATASTORE with no storage figure contributes unknown -- because a database whose
    // footprint nobody measured is a real gap.
    if (profile.storageMb === null) {
      if (node.kind === "database" || node.kind === "queue") unknown.add("storageMb");
    } else totals.storageMb += profile.storageMb * instances;

    if (profile.connectionSlots === null) {
      // Only meaningful where something is being connected TO. A stateless service with no
      // figure is not a gap.
      if (node.kind === "database" || node.kind === "lock") unknown.add("connectionSlots");
    } else totals.connectionSlots += profile.connectionSlots * instances;

    if (profile.networkBytesPerRequest === null) unknown.add("networkBytes");
    else if (requests === null) unknown.add("networkBytes");
    else totals.networkBytes += profile.networkBytesPerRequest * requests;
  }

  return {
    cpuUnits: unknown.has("cpuUnits") ? null : totals.cpuUnits,
    memoryMb: unknown.has("memoryMb") ? null : totals.memoryMb,
    storageMb: unknown.has("storageMb") ? null : totals.storageMb,
    connectionSlots: unknown.has("connectionSlots") ? null : totals.connectionSlots,
    networkBytes: unknown.has("networkBytes") ? null : totals.networkBytes,
    unknownAxes: [...unknown].sort(),
    unmeasuredNodes: unmeasured.sort(),
  };
}

/**
 * A one-line explanation of what is missing, for the report.
 *
 * Written as an instruction rather than a complaint: a reader who sees "three axes are
 * unknown" learns nothing actionable, and one who sees "measure the claims store and the
 * lease service" knows what to do next.
 */
export function resourceGapNote(r: ResourceAccounting): string | null {
  if (r.unknownAxes.length === 0) return null;
  if (r.unmeasuredNodes.length > 0) {
    return (
      `${r.unknownAxes.join(", ")} could not be totalled because ${r.unmeasuredNodes.join(", ")} ` +
      `${r.unmeasuredNodes.length === 1 ? "has" : "have"} no measured resource profile. ` +
      `These axes are excluded from the comparison rather than assumed to be zero.`
    );
  }
  return (
    `${r.unknownAxes.join(", ")} could not be totalled because at least one component leaves ` +
    `${r.unknownAxes.length === 1 ? "it" : "them"} unstated. Excluded from the comparison rather than assumed to be zero.`
  );
}

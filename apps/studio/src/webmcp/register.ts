import type { ToolDefinition, ToolHost } from "./tools";
import { buildTools } from "./tools";
import { enforceAgentToolPolicy } from "../agent/policy";

/**
 * Registration against `document.modelContext`, with feature detection.
 *
 * WHAT "FEATURE-DETECTED" HAS TO MEAN HERE
 *
 * Not just "is the object there". WebMCP is a moving target and the shape it lands in will not be
 * the shape it has today, so the check is for the specific method being called and for it being
 * callable -- and a failure to register is reported as a state the UI renders, not swallowed.
 * A studio that silently failed to expose its tools would look identical to one whose agent was
 * ignoring them.
 *
 * FULL MANUAL FUNCTIONALITY WITHOUT IT
 *
 * Nothing in the application depends on this module. It is called once at startup, and if it
 * returns `unsupported` the studio behaves exactly as it does now: every tool here is an adapter
 * over a command the manual UI already issues, so there is nothing an agent can do that a person
 * cannot.
 */

export type RegistrationState =
  | { status: "registered"; tools: string[] }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

/** The subset of the proposed API this module uses. Declared rather than assumed. */
interface ModelContextLike {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: Record<string, unknown>;
    execute(input: unknown, ctx?: { signal?: AbortSignal }): Promise<unknown>;
  }): void | { unregister?: () => void };
  unregisterTool?(name: string): void;
}

export interface RegisterOptions {
  host: ToolHost;
  /** Injected for tests. Defaults to the real `document`. */
  target?: { modelContext?: unknown } | undefined;
}

export interface Registration {
  state: RegistrationState;
  tools: ToolDefinition[];
  unregister(): void;
}

export function registerWebmcpTools(opts: RegisterOptions): Registration {
  const tools = enforceAgentToolPolicy(buildTools(opts.host));
  const target = opts.target ?? (typeof document === "undefined" ? undefined : document);

  if (!target) {
    return {
      state: { status: "unsupported", reason: "no document: not running in a page" },
      tools,
      unregister: () => {},
    };
  }

  const mc = (target as { modelContext?: unknown }).modelContext as ModelContextLike | undefined;
  if (!mc || typeof mc.registerTool !== "function") {
    return {
      state: {
        status: "unsupported",
        reason:
          "this browser does not expose document.modelContext.registerTool, so no agent tools are available. Everything in the studio remains usable by hand.",
      },
      tools,
      unregister: () => {},
    };
  }

  const disposers: Array<() => void> = [];
  const registered: string[] = [];

  try {
    for (const tool of tools) {
      const handle = mc.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        // The abort signal is forwarded rather than ignored. A correctness search can run for
        // tens of seconds and an agent that changed its mind must be able to stop it; the
        // evaluation runs in a worker and the host terminates it.
        execute: (input, ctx) => tool.execute(input, { ...(ctx?.signal ? { signal: ctx.signal } : {}) }),
      });
      registered.push(tool.name);
      if (handle && typeof handle.unregister === "function") {
        disposers.push(() => handle.unregister!());
      } else if (typeof mc.unregisterTool === "function") {
        disposers.push(() => mc.unregisterTool!(tool.name));
      }
    }
  } catch (err) {
    // Partial registration is worse than none: an agent would see some tools and infer the rest
    // do not exist, then work around their absence. So the successful ones are rolled back.
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A disposer that throws during rollback cannot be helped, and reporting it would bury
        // the original failure.
      }
    }
    return {
      state: {
        status: "failed",
        reason: `registering "${registered[registered.length - 1] ?? "?"}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      tools,
      unregister: () => {},
    };
  }

  return {
    state: { status: "registered", tools: registered },
    tools,
    unregister: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Ignored for the same reason as above.
        }
      }
    },
  };
}

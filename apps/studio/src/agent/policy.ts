import type { ToolDefinition } from "../webmcp/tools";

/**
 * Decisions an agent may inform but never make.
 *
 * The tool catalogue intentionally contains none of these. This second, provider-independent
 * check is a tripwire for future changes: if somebody later adds an authority-bearing tool to the
 * catalogue, every provider fails closed instead of silently inheriting it.
 */
const HUMAN_ONLY_TOOL_MARKERS = [
  "approve",
  "promote",
  "delete",
  "verify_issue",
  "dismiss_issue",
  "accept_risk",
] as const;

export class AgentToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolPolicyError";
  }
}

export function enforceAgentToolPolicy(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!/^studio_[a-z0-9_]+$/.test(tool.name)) {
      throw new AgentToolPolicyError(`agent tool name is outside the Studio namespace: ${tool.name}`);
    }
    if (seen.has(tool.name)) throw new AgentToolPolicyError(`duplicate agent tool: ${tool.name}`);
    seen.add(tool.name);

    const marker = HUMAN_ONLY_TOOL_MARKERS.find((item) => tool.name.includes(item));
    if (marker) {
      throw new AgentToolPolicyError(
        `agent tool "${tool.name}" crosses the human-only ${marker.replace(/_/g, " ")} boundary`
      );
    }
  }
  return [...tools];
}

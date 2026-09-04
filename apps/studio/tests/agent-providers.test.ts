import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_AGENT_PROVIDER_ID,
  EXTERNAL_AGENT_PROVIDER_ID,
  OPENAI_RESPONSES_URL,
  createAgentProviders,
  redactProviderSecret,
} from "../src/agent/providers";
import { AgentToolPolicyError, enforceAgentToolPolicy } from "../src/agent/policy";
import type { ToolDefinition } from "../src/webmcp/tools";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const tool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "studio_get_study",
  description: "Read the current study.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: vi.fn(async () => ({ content: { studyId: "study-1", revision: 7 } })),
  ...overrides,
});

const embeddedFrom = (
  tools: readonly ToolDefinition[],
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: { maxRounds?: number; maxToolCalls?: number } = {}
) => {
  const providers = createAgentProviders(tools, { fetch: fetcher, ...options });
  return providers.find((provider) => provider.id === EMBEDDED_AGENT_PROVIDER_ID)!;
};

describe("agent provider contract", () => {
  it("keeps the external WebMCP handoff primary and derives both providers from one guarded tool contract", async () => {
    const copied: string[] = [];
    const providers = createAgentProviders([tool()], { copyText: async (value) => void copied.push(value) });
    const external = providers[0];
    const embedded = providers[1];

    expect(external.id).toBe(EXTERNAL_AGENT_PROVIDER_ID);
    expect(external.primary).toBe(true);
    expect(embedded.id).toBe(EMBEDDED_AGENT_PROVIDER_ID);
    expect(embedded.primary).toBe(false);
    expect(embedded.toolNames.every((name) => external.toolNames.includes(name))).toBe(true);

    await expect(external.run({ prompt: "inspect this design" })).resolves.toMatchObject({ kind: "handoff" });
    expect(copied).toEqual(["inspect this design"]);
  });

  it("keeps repository-evidence authorship on the external agent that can inspect source", () => {
    const evidenceTools = [
      tool({ name: "studio_import_architecture" }),
      tool({ name: "studio_attach_code_evidence" }),
      tool({ name: "studio_upsert_source_inventory" }),
      tool({ name: "studio_get_grounding_report" }),
    ];
    const [external, embedded] = createAgentProviders(evidenceTools, { copyText: async () => {} });
    expect(external.toolNames).toEqual(evidenceTools.map((item) => item.name));
    expect(embedded.toolNames).toEqual(["studio_get_grounding_report"]);
  });

  it("fails closed if a provider is ever offered human-only authority", () => {
    for (const name of [
      "studio_approve_candidate",
      "studio_promote_candidate",
      "studio_delete_candidate",
      "studio_verify_issue",
      "studio_dismiss_issue",
      "studio_accept_risk",
    ]) {
      expect(() => enforceAgentToolPolicy([tool({ name })])).toThrow(AgentToolPolicyError);
    }
  });

  it("rejects duplicate and non-Studio tools", () => {
    const valid = tool();
    expect(() => enforceAgentToolPolicy([valid, valid])).toThrow(/duplicate/);
    expect(() => enforceAgentToolPolicy([tool({ name: "shell" })])).toThrow(/namespace/);
  });
});

describe("in-browser OpenAI provider", () => {
  it("runs the Responses function loop through the guarded Studio tool", async () => {
    const guardedTool = tool();
    const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url, init });
      return requests.length === 1
        ? response({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-1",
                name: "studio_get_study",
                arguments: "{}",
              },
            ],
          })
        : response({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "The current study is revision 7." }],
              },
            ],
          });
    });
    const provider = embeddedFrom([guardedTool], fetcher);

    await expect(
      provider.run({ prompt: "What is open?", credential: { apiKey: "sk-test-secret-123456", model: "gpt-test" } })
    ).resolves.toEqual({
      kind: "executed",
      text: "The current study is revision 7.",
      rounds: 2,
      toolCalls: 1,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests[0]!.url).toBe(OPENAI_RESPONSES_URL);
    const firstInit = requests[0]!.init!;
    expect(new Headers(firstInit.headers).get("Authorization")).toBe("Bearer sk-test-secret-123456");
    expect(firstInit.cache).toBe("no-store");
    expect(firstInit.credentials).toBe("omit");
    const firstBody = String(firstInit.body);
    expect(firstBody).not.toContain("sk-test-secret-123456");
    expect(JSON.parse(firstBody)).toMatchObject({
      model: "gpt-test",
      store: false,
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "studio_get_study", strict: false }],
    });
    expect(guardedTool.execute).toHaveBeenCalledWith({}, {});

    const secondBody = JSON.parse(String(requests[1]!.init!.body)) as { input: unknown[] };
    expect(secondBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ content: { studyId: "study-1", revision: 7 } }),
    });
  });

  it("does not retain, serialize or send the key in the request body", async () => {
    const secret = "sk-session-only-987654";
    let sentBody = "";
    const provider = embeddedFrom([tool()], async (_url, init) => {
      sentBody = String(init?.body);
      return response({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: `server echoed ${secret}` }] }],
      });
    });

    const result = await provider.run({ prompt: "hello", credential: { apiKey: secret, model: "gpt-test" } });
    expect(sentBody).not.toContain(secret);
    expect(result.text).toBe("server echoed [redacted]");
    expect(JSON.stringify(provider)).not.toContain(secret);
  });

  it("redacts secrets from API and transport failures", async () => {
    const secret = "sk-private-value-123456";
    const apiProvider = embeddedFrom([tool()], async () =>
      response({ status: "failed", error: { message: `credential ${secret} was refused` }, output: [] }, 401)
    );
    await expect(
      apiProvider.run({ prompt: "hello", credential: { apiKey: secret, model: "gpt-test" } })
    ).rejects.toThrow("credential [redacted] was refused");

    const transportProvider = embeddedFrom([tool()], async () => {
      throw new Error(`network accidentally included ${secret}`);
    });
    await expect(
      transportProvider.run({ prompt: "hello", credential: { apiKey: secret, model: "gpt-test" } })
    ).rejects.toThrow("network accidentally included [redacted]");
  });

  it("does not execute hallucinated tools and returns the refusal to the model", async () => {
    const guardedTool = tool();
    const bodies: string[] = [];
    const provider = embeddedFrom([guardedTool], async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? response({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-danger",
                name: "studio_approve_candidate",
                arguments: "{}",
              },
            ],
          })
        : response({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "I cannot approve it." }] }],
          });
    });

    const result = await provider.run({
      prompt: "approve it",
      credential: { apiKey: "sk-test-secret-123456", model: "gpt-test" },
    });
    expect(guardedTool.execute).not.toHaveBeenCalled();
    expect(bodies[1]).toContain("tool is not available: studio_approve_candidate");
    expect(result.text).toBe("I cannot approve it.");
  });

  it("redacts a credential echoed into tool arguments before tools or later request bodies see it", async () => {
    const secret = "sk-echoed-secret-123456";
    const guardedTool = tool();
    const bodies: string[] = [];
    const provider = embeddedFrom([guardedTool], async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? response({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-tainted",
                name: guardedTool.name,
                arguments: JSON.stringify({ note: `do not leak ${secret}` }),
              },
            ],
          })
        : response({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "The tainted call was refused." }] }],
          });
    });

    await provider.run({ prompt: "hello", credential: { apiKey: secret, model: "gpt-test" } });
    expect(guardedTool.execute).not.toHaveBeenCalled();
    expect(bodies[1]).not.toContain(secret);
    expect(bodies[1]).toContain("tool arguments contained a credential and were refused");
  });

  it("preserves revision refusals as tool results instead of bypassing them", async () => {
    const revisionGuard = tool({
      name: "studio_apply_architecture_patch",
      execute: vi.fn(async () => ({
        content: { error: "version has revision 8, not 7; re-read before replacing it" },
        isError: true,
      })),
    });
    const bodies: string[] = [];
    const provider = embeddedFrom([revisionGuard], async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? response({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-stale",
                name: revisionGuard.name,
                arguments: JSON.stringify({ candidateId: "c1", expectedRevision: 7, operations: [] }),
              },
            ],
          })
        : response({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "I need to re-read." }] }],
          });
    });

    await provider.run({
      prompt: "change it",
      credential: { apiKey: "sk-test-secret-123456", model: "gpt-test" },
    });
    expect(bodies[1]).toContain("version has revision 8, not 7");
    expect(revisionGuard.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds autonomous tool loops", async () => {
    let id = 0;
    const provider = embeddedFrom(
      [tool()],
      async () =>
        response({
          status: "completed",
          output: [
            { type: "function_call", call_id: `call-${id++}`, name: "studio_get_study", arguments: "{}" },
          ],
        }),
      { maxRounds: 2 }
    );
    await expect(
      provider.run({ prompt: "loop", credential: { apiKey: "sk-test-secret-123456", model: "gpt-test" } })
    ).rejects.toThrow("2-round safety limit");
  });

  it("redacts API-key-shaped strings independently of an exact invocation secret", () => {
    expect(redactProviderSecret("bad sk-another-secret-12345 value", "different")).toBe("bad [redacted] value");
  });
});

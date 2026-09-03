import { z } from "zod";

/**
 * JSON Schema generation from the Zod schemas that do the runtime validation.
 *
 * WHY GENERATE RATHER THAN HAND-WRITE
 *
 * Because a WebMCP tool has two descriptions of its input and they must agree: the JSON Schema
 * the agent reads to decide what to send, and the validator that decides whether to accept it. A
 * hand-written schema drifts from its validator in one direction -- the schema stays permissive
 * while the validator tightens -- and the symptom is an agent that follows the documentation and
 * gets rejected, repeatedly, with no way to discover why.
 *
 * So both come from one Zod schema, and `schemas.test.ts` snapshots the generated output. The
 * snapshot is not there to pin the shape for its own sake; it is there so that widening a
 * validator without regenerating shows up as a failing test rather than as a confused agent.
 *
 * WHY NOT A LIBRARY
 *
 * `zod-to-json-schema` exists and does more than this. It also brings a dependency into the
 * critical path of the agent interface for a conversion this codebase needs over about a dozen
 * flat object schemas. The subset handled here is exactly the subset the tool inputs use, and
 * anything outside it throws rather than degrading -- so an unsupported construct is caught when
 * the schema is written rather than shipped as a silently wrong description.
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

export class UnsupportedSchema extends Error {
  constructor(kind: string) {
    super(
      `cannot convert a Zod ${kind} to JSON Schema. Either express the input differently or extend ` +
        `the converter -- do NOT hand-write the JSON Schema, because it would then be free to drift ` +
        `from the validator that rejects the agent's input.`
    );
    this.name = "UnsupportedSchema";
  }
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, 0);
}

/** Depth cap. A tool input deep enough to hit it is a tool input an agent will not get right. */
const MAX_DEPTH = 12;

function convert(schema: z.ZodTypeAny, depth: number): JsonSchema {
  if (depth > MAX_DEPTH) throw new UnsupportedSchema("schema nested too deeply");

  const def = schema._def as { typeName: string } & Record<string, unknown>;
  const described = (out: JsonSchema): JsonSchema => {
    const description = (schema._def as { description?: string }).description;
    return description ? { ...out, description } : out;
  };

  switch (def.typeName) {
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const check of (def.checks ?? []) as Array<{ kind: string; value?: number }>) {
        if (check.kind === "min" && check.value !== undefined) out.minLength = check.value;
        if (check.kind === "max" && check.value !== undefined) out.maxLength = check.value;
      }
      return described(out);
    }

    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const check of (def.checks ?? []) as Array<{ kind: string; value?: number }>) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min" && check.value !== undefined) out.minimum = check.value;
        if (check.kind === "max" && check.value !== undefined) out.maximum = check.value;
      }
      return described(out);
    }

    case "ZodBoolean":
      return described({ type: "boolean" });

    case "ZodLiteral":
      return described({ const: def.value });

    case "ZodEnum":
      return described({ type: "string", enum: [...(def.values as string[])] });

    case "ZodArray": {
      const out: JsonSchema = {
        type: "array",
        items: convert(def.type as z.ZodTypeAny, depth + 1),
      };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return described(out);
    }

    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [name, value] of Object.entries(shape)) {
        properties[name] = convert(value, depth + 1);
        if (!isOptionalish(value)) required.push(name);
      }
      const out: JsonSchema = {
        type: "object",
        properties,
        // Closed by default. An agent that sends an extra field has misunderstood something, and
        // silently accepting it means the misunderstanding survives into the next call.
        additionalProperties: false,
      };
      if (required.length > 0) out.required = required;
      return described(out);
    }

    case "ZodRecord":
      return described({
        type: "object",
        additionalProperties: convert(def.valueType as z.ZodTypeAny, depth + 1),
      });

    case "ZodOptional":
    case "ZodNullable": {
      const inner = convert(def.innerType as z.ZodTypeAny, depth + 1);
      if (def.typeName === "ZodOptional") return inner;
      // Nullable widens the type rather than wrapping it, because an agent reading
      // `{"type": ["string", "null"]}` understands it and an agent reading a oneOf with a null
      // branch frequently does not.
      const types = Array.isArray(inner.type) ? inner.type : inner.type ? [inner.type] : [];
      return { ...inner, type: [...types, "null"] };
    }

    case "ZodDefault": {
      const inner = convert(def.innerType as z.ZodTypeAny, depth + 1);
      return { ...inner, default: (def.defaultValue as () => unknown)() };
    }

    case "ZodEffects":
      // Refinements keep the same structural JSON shape. Runtime-only cross-field rules still
      // come back through the validator's exact error messages.
      return convert(def.schema as z.ZodTypeAny, depth + 1);

    case "ZodUnion":
      return described({
        anyOf: (def.options as z.ZodTypeAny[]).map((o) => convert(o, depth + 1)),
      });

    case "ZodDiscriminatedUnion":
      return described({
        anyOf: [...(def.options as Map<string, z.ZodTypeAny> | z.ZodTypeAny[])].map((entry) =>
          convert(Array.isArray(entry) ? (entry[1] as z.ZodTypeAny) : (entry as z.ZodTypeAny), depth + 1)
        ),
      });

    case "ZodAny":
    case "ZodUnknown":
      // Deliberately permissive, and used for exactly one thing: a complete design document.
      //
      // The design schema is several hundred fields across eight component kinds and five
      // distributions. Inlining it into a tool description would produce tens of kilobytes of
      // JSON Schema that no agent reads carefully, and the agent's real feedback loop is
      // `studio_validate_draft`, which returns the actual validator's actual messages. A large
      // schema nobody reads is worse than a small one plus a validator that explains itself.
      return described({});

    case "ZodLazy":
      return convert((def.getter as () => z.ZodTypeAny)(), depth + 1);

    case "ZodTuple":
      return described({
        type: "array",
        items: convert((def.items as z.ZodTypeAny[])[0] ?? z.unknown(), depth + 1),
        minItems: (def.items as z.ZodTypeAny[]).length,
        maxItems: (def.items as z.ZodTypeAny[]).length,
      });

    default:
      throw new UnsupportedSchema(def.typeName);
  }
}

function isOptionalish(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName: string }).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

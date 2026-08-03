// ─────────────────────────────────────────────────────────────────────────
// ANTHROPIC STRUCTURED-OUTPUT SCHEMA ADAPTER (TASK E2)
//
// §1b flagged this as the largest hidden piece of work, so it is scoped here
// explicitly rather than discovered mid-implementation.
//
// ── WHY THIS IS PROVENANCE-CRITICAL, NOT PLUMBING ───────────────────────
// Stage B's schema carries the nested `evidence` array — `dossier_path`,
// `source_filename`, `snippet`, `implied_value`. The ENTIRE provenance state
// machine (§3) derives from those four fields: empty evidence means
// `needs_user_input`, several filenames with one value means corroboration,
// several with different values means `conflicting_sources`.
//
// If a constraint the schema relies on cannot be expressed and this adapter
// DROPS it silently, the model is free to return a shape §3 then
// misinterprets — and answers get mislabelled with confident-looking
// provenance. That is precisely the failure class §3 exists to prevent.
//
// THEREFORE: this adapter TRANSFORMS what it can and THROWS on what it
// cannot. It never drops. An unsupported keyword is a build-time failure with
// a JSON pointer to the offending node, not a runtime surprise.
//
// ── KEYWORD SUPPORT, per the structured-outputs docs (fetched 2026-07-29) ──
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// SUPPORTED: object · array · string · integer · number · boolean · null ·
//   enum (string/number/bool/null) · const · anyOf · allOf · string `format`
//   (date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid) ·
//   `minItems` ONLY when 0 or 1 · required · properties · items ·
//   additionalProperties ONLY when false.
// NOT SUPPORTED: recursive schemas · numeric constraints (minimum, maximum,
//   exclusiveMinimum, exclusiveMaximum, multipleOf) · string constraints
//   (minLength, maxLength, pattern) · array constraints beyond minItems 0/1
//   (maxItems, uniqueItems) · external $ref · additionalProperties set to
//   anything other than false.
//
// ── GEMINI'S CASING SPLIT MUST NOT LEAK HERE ────────────────────────────
// Anthropic takes standard lowercase JSON Schema. `upperCaseSchemaTypes()` is
// a proto3 concern belonging to Gemini's generateContent path ONLY (§1) and is
// never applied on this path. This adapter also REJECTS uppercase type names,
// so a leak fails loudly instead of silently producing an invalid schema.
// ─────────────────────────────────────────────────────────────────────────

export class SchemaAdaptationError extends Error {
  readonly pointer: string;
  readonly keyword: string;

  constructor(pointer: string, keyword: string, detail: string) {
    super(
      `Anthropic structured output cannot express "${keyword}" at ${pointer}: ${detail} ` +
        "The schema was NOT silently altered — fix the schema or the adapter.",
    );
    this.name = "SchemaAdaptationError";
    this.pointer = pointer;
    this.keyword = keyword;
  }
}

const SUPPORTED_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

// Keywords we pass through untouched.
const PASSTHROUGH = new Set(["type", "description", "title", "properties", "items", "required", "enum", "const"]);

// Keywords that are structurally supported but need recursion.
const COMBINATORS = new Set(["anyOf", "allOf"]);

// Keywords Anthropic's subset cannot express. Each throws with its reason
// rather than being dropped.
const REJECTED: Record<string, string> = {
  minimum: "numeric constraints are not supported by constrained decoding",
  maximum: "numeric constraints are not supported by constrained decoding",
  exclusiveMinimum: "numeric constraints are not supported by constrained decoding",
  exclusiveMaximum: "numeric constraints are not supported by constrained decoding",
  multipleOf: "numeric constraints are not supported by constrained decoding",
  minLength: "string length constraints are not supported",
  maxLength: "string length constraints are not supported",
  pattern: "regex patterns are not supported",
  maxItems: "array maxItems is not supported",
  uniqueItems: "array uniqueItems is not supported",
  $ref: "external $ref is not supported (and recursive schemas are rejected outright)",
  $defs: "schema definitions imply $ref, which is not supported",
  definitions: "schema definitions imply $ref, which is not supported",
  oneOf: "oneOf is not in the supported combinator set (anyOf / allOf only)",
  not: "not is not in the supported combinator set",
  patternProperties: "patternProperties is not supported",
  propertyNames: "propertyNames is not supported",
  if: "conditional subschemas are not supported",
  then: "conditional subschemas are not supported",
  else: "conditional subschemas are not supported",
  dependentSchemas: "conditional subschemas are not supported",
  dependentRequired: "conditional subschemas are not supported",
};

export interface AdaptOptions {
  /**
   * Whether to add `additionalProperties: false` to every object.
   *
   * This is REQUIRED by Anthropic and is the one transformation that adds a
   * constraint rather than preserving one. It is safe: it forbids extra keys
   * the caller never asked for, and every schema in this codebase is a closed
   * shape already.
   */
  addAdditionalProperties?: boolean;
}

interface AdaptState {
  seen: Set<object>;
}

function adaptNode(node: unknown, pointer: string, options: AdaptOptions, state: AdaptState): unknown {
  if (Array.isArray(node)) {
    return node.map((item, index) => adaptNode(item, `${pointer}/${index}`, options, state));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }

  const source = node as Record<string, unknown>;

  // RECURSION CHECK. A cycle would make constrained decoding impossible and
  // would also hang this walk. Detected by identity, before anything else.
  if (state.seen.has(source)) {
    throw new SchemaAdaptationError(pointer, "$recursion", "the schema references itself");
  }
  state.seen.add(source);

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key in REJECTED) {
      // minItems is the one array constraint with a narrow allowance.
      throw new SchemaAdaptationError(pointer, key, REJECTED[key] ?? "unsupported");
    }

    if (key === "minItems") {
      if (value !== 0 && value !== 1) {
        throw new SchemaAdaptationError(
          pointer,
          "minItems",
          `only 0 or 1 is supported, got ${JSON.stringify(value)}`,
        );
      }
      out[key] = value;
      continue;
    }

    if (key === "additionalProperties") {
      if (value !== false) {
        throw new SchemaAdaptationError(
          pointer,
          "additionalProperties",
          `only false is supported, got ${JSON.stringify(value)}`,
        );
      }
      out[key] = false;
      continue;
    }

    if (key === "format") {
      if (typeof value !== "string" || !SUPPORTED_FORMATS.has(value)) {
        throw new SchemaAdaptationError(
          pointer,
          "format",
          `"${String(value)}" is not in the supported format list`,
        );
      }
      out[key] = value;
      continue;
    }

    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      for (const candidate of types) {
        if (typeof candidate !== "string") {
          throw new SchemaAdaptationError(pointer, "type", `expected a string, got ${JSON.stringify(candidate)}`);
        }
        // GUARD AGAINST THE GEMINI CASING LEAK (§1). Gemini's generateContent
        // path uppercases proto3 enums; that must never reach Anthropic.
        if (candidate !== candidate.toLowerCase()) {
          throw new SchemaAdaptationError(
            pointer,
            "type",
            `"${candidate}" is uppercase. That is Gemini's proto3 spelling and must not reach Anthropic, ` +
              "which takes standard lowercase JSON Schema. upperCaseSchemaTypes() has leaked onto this path.",
          );
        }
        if (!SUPPORTED_TYPES.has(candidate)) {
          throw new SchemaAdaptationError(pointer, "type", `"${candidate}" is not a supported type`);
        }
      }
      out[key] = value;
      continue;
    }

    if (COMBINATORS.has(key)) {
      out[key] = adaptNode(value, `${pointer}/${key}`, options, state);
      continue;
    }

    if (key === "properties") {
      const properties = value as Record<string, unknown>;
      const adapted: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(properties)) {
        adapted[name] = adaptNode(sub, `${pointer}/properties/${name}`, options, state);
      }
      out[key] = adapted;
      continue;
    }

    if (key === "items") {
      out[key] = adaptNode(value, `${pointer}/items`, options, state);
      continue;
    }

    if (PASSTHROUGH.has(key)) {
      out[key] = value;
      continue;
    }

    // Unknown keyword. Refuse rather than pass it through and hope: an
    // unrecognised constraint that the server rejects is a 400 we cannot
    // explain, and one it ignores is a silently weakened schema.
    throw new SchemaAdaptationError(pointer, key, "unrecognised keyword — refusing to pass it through blindly");
  }

  // THE ONE ADDITIVE TRANSFORMATION.
  if (options.addAdditionalProperties !== false && out.type === "object" && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }

  state.seen.delete(source);
  return out;
}

/**
 * Adapts a JSON Schema for Anthropic's `output_config.format`.
 *
 * Throws `SchemaAdaptationError` — never returns a weakened schema.
 *
 * NOTE ON `required`: existing `required` arrays are preserved EXACTLY. This
 * adapter deliberately does not invent requirements. Forcing a field to be
 * required changes what the model must emit, and on the Stage B schema that
 * would be a provenance change, not a formatting one (§3 permits an empty
 * `snippet` on choice questions — empty, not absent, so the distinction is
 * live). Whether Anthropic mandates that every property appear in `required`
 * when `additionalProperties:false` is set is NOT confirmed by the docs and is
 * recorded in §1b as an open question for the first live run.
 */
export function adaptSchemaForAnthropic(schema: unknown, options: AdaptOptions = {}): unknown {
  return adaptNode(schema, "#", options, { seen: new Set() });
}

/**
 * Non-throwing probe, for tests and for a settings-time capability check.
 */
export function checkSchemaSupport(schema: unknown): { ok: true } | { ok: false; error: SchemaAdaptationError } {
  try {
    adaptSchemaForAnthropic(schema);
    return { ok: true };
  } catch (error) {
    if (error instanceof SchemaAdaptationError) {
      return { ok: false, error };
    }
    throw error;
  }
}

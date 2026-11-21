/**
 * A small OpenAPI 3.1 response validator (#182) — only the keywords this spec
 * uses: $ref, allOf, type (incl. arrays), enum, required, properties,
 * additionalProperties: false, items, min/maxLength, maxItems, pattern.
 * Anything else is ignored rather than guessed at.
 */

export function resolveRef(spec, ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], spec);
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(type, value) {
  const actual = typeOf(value);
  return type === actual || (type === 'number' && actual === 'integer');
}

/** Every property a schema allows, following $ref and allOf. */
function allowedProperties(spec, schema, into = new Set()) {
  if (schema.$ref) return allowedProperties(spec, resolveRef(spec, schema.$ref), into);
  for (const key of Object.keys(schema.properties ?? {})) into.add(key);
  for (const part of schema.allOf ?? []) allowedProperties(spec, part, into);
  return into;
}

/** Returns a list of human-readable violations; empty means valid. */
export function validate(spec, schema, value, path = '$', skipExtra = false) {
  if (schema.$ref) return validate(spec, resolveRef(spec, schema.$ref), value, path, skipExtra);
  const errors = [];

  for (const part of schema.allOf ?? []) errors.push(...validate(spec, part, value, path, true));

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(spec, schema.items, item, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(spec, sub, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false && !skipExtra) {
      const allowed = allowedProperties(spec, schema);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}: property "${key}" is not in the schema`);
      }
    }
  }
  return errors;
}

/**
 * Validate a response body against the schema OpenAPI declares for
 * `method path` → `status` → `contentType`. Throws on any violation, and when
 * the spec declares no such response at all.
 */
export function assertConforms(spec, { path, method = 'get', status, contentType = 'application/json', body }) {
  let response = spec.paths?.[path]?.[method]?.responses?.[String(status)];
  if (response?.$ref) response = resolveRef(spec, response.$ref);
  const schema = response?.content?.[contentType]?.schema;
  if (!schema) throw new Error(`openapi.json declares no ${status} ${contentType} response for ${method.toUpperCase()} ${path}`);
  const errors = validate(spec, schema, body);
  if (errors.length > 0) {
    throw new Error(`${method.toUpperCase()} ${path} ${status} does not match openapi.json:\n  ${errors.join('\n  ')}`);
  }
}

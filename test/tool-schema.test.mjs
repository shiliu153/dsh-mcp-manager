// Guard against malformed tool parameter schemas.
//
// WHY THIS TEST EXISTS: the provider validates every tool's `parameters` as
// JSON Schema and rejects the WHOLE request when one is malformed. A single
// `oneOf: ['get', 'set']` (keywords like oneOf/anyOf/allOf take an array of
// *schemas*, never scalars) made every conversation fail with
//   503 invalid function call parameters
//   "工具定义不符合模型要求" / "The tool definition does not meet the model requirements."
// so no tool could ever be called. See docs/records for the e2e evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolDefs } from '../index.js';

/** Keywords whose value must be a non-empty array of schemas. */
const SCHEMA_ARRAY_KEYWORDS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];
/** Keywords whose value must be an array of literals. */
const LITERAL_ARRAY_KEYWORDS = ['enum', 'required'];
/** Keywords whose value must be a single schema. */
const SINGLE_SCHEMA_KEYWORDS = ['items', 'not', 'contains', 'propertyNames'];

function assertValidSchema(schema, where) {
  assert.ok(
    schema && typeof schema === 'object' && !Array.isArray(schema),
    `${where}: expected a schema object, got ${JSON.stringify(schema)}`,
  );

  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_ARRAY_KEYWORDS.includes(key)) {
      assert.ok(
        Array.isArray(value) && value.length > 0,
        `${where}.${key}: must be a non-empty array of schemas, got ${JSON.stringify(value)}`,
      );
      value.forEach((sub, i) => assertValidSchema(sub, `${where}.${key}[${i}]`));
    } else if (LITERAL_ARRAY_KEYWORDS.includes(key)) {
      assert.ok(
        Array.isArray(value),
        `${where}.${key}: must be an array, got ${JSON.stringify(value)}`,
      );
    } else if (SINGLE_SCHEMA_KEYWORDS.includes(key)) {
      assertValidSchema(value, `${where}.${key}`);
    } else if (key === 'properties') {
      assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        `${where}.properties: must be an object`,
      );
      for (const [prop, sub] of Object.entries(value)) {
        assertValidSchema(sub, `${where}.properties.${prop}`);
      }
    } else if (key === 'additionalProperties') {
      // A boolean is legal here; anything else must itself be a schema.
      if (typeof value !== 'boolean') assertValidSchema(value, `${where}.additionalProperties`);
    } else if (key === 'type') {
      const ok = typeof value === 'string'
        || (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string'));
      assert.ok(ok, `${where}.type: must be a string or an array of strings, got ${JSON.stringify(value)}`);
    }
  }
}

test('every tool parameter schema is structurally valid JSON Schema', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  assert.equal(defs.length, 9);
  for (const d of defs) {
    assertValidSchema(d.parameters, d.name);
  }
});

test('mcp_manager_credential constrains op with enum, not oneOf', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const cred = defs.find(d => d.name === 'mcp_manager_credential');
  const op = cred.parameters.properties.op;
  assert.deepEqual(op.enum, ['get', 'set']);
  assert.equal(op.oneOf, undefined, 'oneOf over scalars is invalid JSON Schema and breaks every request');
  assert.equal(op.type, 'string');
});

test('mcp_manager_update declares id/config as strings and confirm as a boolean', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const update = defs.find(d => d.name === 'mcp_manager_update');
  assert.ok(update, 'the update tool must be registered');
  assert.equal(update.parameters.type, 'object');
  assert.equal(update.parameters.properties.id.type, 'string');
  assert.equal(update.parameters.properties.config.type, 'string');
  assert.equal(update.parameters.properties.confirm.type, 'boolean');
  assert.equal(update.parameters.additionalProperties, false);
  assert.equal(update.parameters.required, undefined, 'required-ness is enforced in execute, like the other tools');
});

test('mcp_manager_search declares query/limit/cursor as primitives', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const search = defs.find(d => d.name === 'mcp_manager_search');
  assert.ok(search, 'the search tool must be registered');
  assert.equal(search.parameters.properties.query.type, 'string');
  assert.equal(search.parameters.properties.limit.type, 'number');
  assert.equal(search.parameters.properties.cursor.type, 'string');
  assert.equal(search.parameters.additionalProperties, false);
});

test('mcp_manager_add declares source with enum, never oneOf', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const add = defs.find(d => d.name === 'mcp_manager_add');
  const source = add.parameters.properties.source;
  assert.deepEqual(source.enum, ['auto', 'registry']);
  assert.equal(source.oneOf, undefined, 'oneOf over scalars is invalid JSON Schema and breaks every request');
  assert.equal(source.type, 'string');
});

/**
 * Test support: the vendored contract (`contract/openapi.yaml`) as one plain
 * object with every internal `$ref` inlined, so a fixture can be handed to
 * ajv with a schema and nothing else. The spec is a single file with only
 * internal references, so no bundler is needed to read it.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const SPEC_PATH = fileURLToPath(new URL('../../contract/openapi.yaml', import.meta.url));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRef(value: Json): value is { $ref: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.$ref === 'string'
  );
}

/** `#/a~1b/c~0d` → `['a/b', 'c~d']`, per RFC 6901. */
function pointerOf(ref: string): string[] {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}: only internal refs are`);
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function lookup(root: Json, ref: string): Json {
  let node: Json = root;
  for (const segment of pointerOf(ref)) {
    if (typeof node !== 'object' || node === null || Array.isArray(node) || !(segment in node)) {
      throw new Error(`$ref ${ref} names nothing in the document`);
    }
    node = node[segment] as Json;
  }
  return node;
}

/**
 * A copy of `doc` with every internal `$ref` replaced by its target. A
 * reference already being inlined above the current node is left as the
 * reference, so a recursive schema terminates after one level.
 */
export function dereference(doc: unknown): unknown {
  const root = doc as Json;
  const walk = (node: Json, inlining: ReadonlySet<string>): Json => {
    if (isRef(node)) {
      const ref = node.$ref;
      if (inlining.has(ref)) return node;
      return walk(lookup(root, ref), new Set([...inlining, ref]));
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, inlining));
    if (typeof node === 'object' && node !== null) {
      const out: { [key: string]: Json } = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value, inlining);
      return out;
    }
    return node;
  };
  return walk(root, new Set());
}

export function loadSpec(): unknown {
  return dereference(parse(fs.readFileSync(SPEC_PATH, 'utf8')));
}

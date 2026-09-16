import { describe, expect, it } from 'vitest';
import { dereference, loadSpec } from './spec.js';

describe('dereference', () => {
  it('inlines an internal $ref wherever it appears', () => {
    const doc = {
      components: { schemas: { Id: { type: 'string', minLength: 1 } } },
      paths: {
        '/x': {
          get: { parameters: [{ name: 'id', schema: { $ref: '#/components/schemas/Id' } }] },
        },
      },
    };
    const out = dereference(doc) as typeof doc;
    expect(out.paths['/x']!.get.parameters[0]!.schema).toEqual({ type: 'string', minLength: 1 });
  });

  it('resolves a ref whose target is itself a ref', () => {
    const doc = {
      components: {
        schemas: { A: { $ref: '#/components/schemas/B' }, B: { type: 'integer' } },
      },
      use: { $ref: '#/components/schemas/A' },
    };
    expect((dereference(doc) as { use: unknown }).use).toEqual({ type: 'integer' });
  });

  it('decodes JSON-pointer escapes in the path', () => {
    const doc = {
      components: { 'a/b': { 'c~d': { ok: true } } },
      use: { $ref: '#/components/a~1b/c~0d' },
    };
    expect((dereference(doc) as { use: unknown }).use).toEqual({ ok: true });
  });

  it('throws on a ref that names nothing', () => {
    expect(() => dereference({ use: { $ref: '#/nope' } })).toThrow(/#\/nope/);
  });

  it('leaves a cyclic ref in place rather than looping', () => {
    const doc = {
      components: {
        schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } },
      },
    };
    const out = dereference(doc) as {
      components: {
        schemas: { Node: { properties: { next: { properties?: unknown; $ref?: string } } } };
      };
    };
    const next = out.components.schemas.Node.properties.next;
    // One level is inlined; the level below it stays a reference.
    expect(next.properties).toBeDefined();
    expect((next.properties as { next: { $ref?: string } }).next.$ref).toBe(
      '#/components/schemas/Node',
    );
  });
});

describe('loadSpec', () => {
  it('parses the vendored contract with every internal ref inlined', () => {
    const spec = loadSpec() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, object> };
    };
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.components.schemas)).toContain('Error');
    expect(JSON.stringify(spec.paths)).not.toContain('"$ref"');
    expect(spec.paths['/v1/search/shows']!.get!.operationId).toBe('searchShows');
  });
});

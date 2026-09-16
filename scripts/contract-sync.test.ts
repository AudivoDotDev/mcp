import { describe, expect, it } from 'vitest';
import { SPEC_URL, sync } from './contract-sync.js';

function fetchReturning(status: number, body: string) {
  const seen: string[] = [];
  const fetch = async (url: string) => {
    seen.push(url);
    return { status, text: async () => body };
  };
  return { fetch, seen };
}

describe('contract sync', () => {
  it('fetches the published spec, writes it, then regenerates the types', async () => {
    const { fetch, seen } = fetchReturning(200, 'openapi: 3.1.0\ninfo:\n  title: Audivo\n');
    const written: Array<[string, string]> = [];
    const ran: string[] = [];
    await sync({
      fetch,
      write: (path, body) => void written.push([path, body]),
      run: (script) => void ran.push(script),
    });
    expect(seen).toEqual([SPEC_URL]);
    expect(written).toEqual([
      ['contract/openapi.yaml', 'openapi: 3.1.0\ninfo:\n  title: Audivo\n'],
    ]);
    expect(ran).toEqual(['contract:types']);
  });

  it('writes nothing when the fetch is not a 200', async () => {
    const { fetch } = fetchReturning(503, 'nope');
    const written: unknown[] = [];
    await expect(
      sync({ fetch, write: (p, b) => void written.push([p, b]), run: () => {} }),
    ).rejects.toThrow(/503/);
    expect(written).toEqual([]);
  });

  it('writes nothing when the body is not an OpenAPI document', async () => {
    const { fetch } = fetchReturning(200, '<html>maintenance</html>');
    const written: unknown[] = [];
    await expect(
      sync({ fetch, write: (p, b) => void written.push([p, b]), run: () => {} }),
    ).rejects.toThrow(/not an OpenAPI document/);
    expect(written).toEqual([]);
  });
});

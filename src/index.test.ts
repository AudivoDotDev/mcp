import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';

describe('the package surface', () => {
  it('exports the server factory, the tool table, and the base URL guard', () => {
    expect(typeof pkg.createMcpServer).toBe('function');
    expect(typeof pkg.createHandler).toBe('function');
    expect(typeof pkg.createApiClient).toBe('function');
    expect(typeof pkg.assertApiBaseUrl).toBe('function');
    expect(pkg.TOOLS.map((tool) => tool.name)).toHaveLength(9);
    expect(pkg.SERVER_INFO.name).toBe('audivo');
  });
});

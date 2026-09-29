import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';

describe('the package surface', () => {
  it('exports the server factory, both tool tables, and the base URL guard', () => {
    expect(typeof pkg.createMcpServer).toBe('function');
    expect(typeof pkg.createHandler).toBe('function');
    expect(typeof pkg.createApiClient).toBe('function');
    expect(typeof pkg.assertApiBaseUrl).toBe('function');
    expect(pkg.TOOLS.map((tool) => tool.name)).toHaveLength(10);
    expect(pkg.TOOLS[0]?.name).toBe('transcribe');
    expect(pkg.LOCAL_TOOLS.map((tool) => tool.name)).toEqual(['upload_audio', 'youtube_search']);
    expect(pkg.SERVED_TOOLS).toHaveLength(12);
    // The local list replaces the hosted `transcribe` with its widened twin.
    expect(pkg.SERVED_TOOLS.filter((tool) => tool.name === 'transcribe')).toHaveLength(1);
    expect(pkg.SERVED_TOOLS.find((tool) => tool.name === 'transcribe')).not.toBe(pkg.TOOLS[0]);
    expect(pkg.SERVER_INFO.name).toBe('audivo');
  });
});

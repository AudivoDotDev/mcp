/**
 * One version, stated in four places, held together here: the npm package,
 * the server's own `serverInfo`, the MCP Registry entry, and the package the
 * entry points at. A release that bumps one and forgets another publishes a
 * registry entry naming a version npm does not have.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_INFO } from './server.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  mcpName: string;
  files: string[];
};
const server = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  packages: { identifier: string; version: string; registryType: string }[];
  remotes: { type: string; url: string }[];
};

describe('the release', () => {
  it('states one version everywhere', () => {
    expect(SERVER_INFO.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((entry) => entry.version)).toEqual([pkg.version]);
  });

  it("names the registry entry the way the registry checks it: the package's mcpName", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^io\.github\.AudivoDotDev\//);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name }),
    ]);
  });

  it('lists the hosted server as a remote, at the URL the directories connect to', () => {
    expect(server.remotes).toEqual([
      { type: 'streamable-http', url: 'https://api.audivo.dev/mcp' },
    ]);
  });

  it('ships server.json in the package', () => {
    expect(pkg.files).toContain('server.json');
  });
});

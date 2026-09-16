/**
 * Refreshes `contract/openapi.yaml` from the published spec and regenerates
 * `src/contract/types.ts` from it. Run as `npm run contract:sync`; the drift
 * test then holds the two files together.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPEC_URL = 'https://docs.audivo.dev/openapi.yaml';
export const SPEC_FILE = 'contract/openapi.yaml';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export type SyncDeps = {
  readonly fetch: (url: string) => Promise<{ status: number; text(): Promise<string> }>;
  readonly write: (relativePath: string, body: string) => void;
  readonly run: (script: string) => void;
};

export async function sync(deps: SyncDeps): Promise<void> {
  const response = await deps.fetch(SPEC_URL);
  if (response.status !== 200) {
    throw new Error(`${SPEC_URL} answered ${response.status}; nothing written`);
  }
  const body = await response.text();
  if (!/^openapi:\s*3\./m.test(body.slice(0, 256))) {
    throw new Error(`${SPEC_URL} is not an OpenAPI document; nothing written`);
  }
  deps.write(SPEC_FILE, body);
  deps.run('contract:types');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await sync({
    fetch: (url) => fetch(url),
    write: (relativePath, body) => fs.writeFileSync(path.join(ROOT, relativePath), body),
    run: (script) => execFileSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' }),
  });
}

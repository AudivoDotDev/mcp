/**
 * Fails when `src/contract/types.ts` is not exactly what `npm run
 * contract:types` produces from `contract/openapi.yaml` right now. Regenerates
 * into a scratch file, runs the same two steps the script runs
 * (`openapi-typescript`, then `prettier`, because the committed file is
 * prettier-governed and the generator's raw output is not), and compares
 * byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SPEC = path.join(ROOT, 'contract/openapi.yaml');
const COMMITTED = path.join(ROOT, 'src/contract/types.ts');

function run(bin: string, args: readonly string[]): void {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  execFileSync(path.join(ROOT, 'node_modules', '.bin', `${bin}${suffix}`), args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('src/contract/types.ts', () => {
  it('is what the vendored spec generates (run `npm run contract:types` if this fails)', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audivo-mcp-types-'));
    const scratch = path.join(scratchDir, 'types.ts');
    try {
      run('openapi-typescript', [SPEC, '-o', scratch]);
      // An explicit config and an empty ignore file: the scratch file is
      // outside the repo, where prettier would otherwise use its defaults
      // and might honour a `.gitignore` that matches the temp directory.
      const ignore = path.join(scratchDir, '.prettierignore');
      fs.writeFileSync(ignore, '');
      run('prettier', [
        '--config',
        path.join(ROOT, '.prettierrc'),
        '--ignore-path',
        ignore,
        '--write',
        scratch,
      ]);
      expect(fs.readFileSync(scratch, 'utf8')).toBe(fs.readFileSync(COMMITTED, 'utf8'));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

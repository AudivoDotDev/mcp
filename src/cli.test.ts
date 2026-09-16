import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_ENV,
  CliConfigError,
  DEFAULT_API_BASE_URL,
  configFromEnv,
  serve,
  stdioDeps,
} from './cli.js';
import { BASE_URL, CREDENTIAL, fakeApi } from './testing/fake-api.js';

const KEY = CREDENTIAL.replace(/^Bearer /, '');

describe('configFromEnv', () => {
  it('requires the API key and names the variable', () => {
    expect(() => configFromEnv({})).toThrow(CliConfigError);
    expect(() => configFromEnv({})).toThrow(CLI_ENV.API_KEY);
    expect(() => configFromEnv({ [CLI_ENV.API_KEY]: '   ' })).toThrow(CLI_ENV.API_KEY);
  });

  it('trims the key and carries it as a bearer credential', () => {
    const config = configFromEnv({ [CLI_ENV.API_KEY]: `  ${KEY}\n` });
    expect(config.credential).toBe(`Bearer ${KEY}`);
  });

  it('accepts a value that already carries the bearer scheme, in any case', () => {
    expect(configFromEnv({ [CLI_ENV.API_KEY]: `Bearer ${KEY}` }).credential).toBe(`Bearer ${KEY}`);
    expect(configFromEnv({ [CLI_ENV.API_KEY]: `bearer   ${KEY}` }).credential).toBe(
      `Bearer ${KEY}`,
    );
  });

  it('defaults the base URL to production', () => {
    expect(configFromEnv({ [CLI_ENV.API_KEY]: KEY }).baseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(DEFAULT_API_BASE_URL).toBe('https://api.audivo.dev');
  });

  it('honours an explicit base URL, without its trailing slash', () => {
    const env = { [CLI_ENV.API_KEY]: KEY, [CLI_ENV.API_BASE_URL]: `${BASE_URL}/` };
    expect(configFromEnv(env).baseUrl).toBe(BASE_URL);
  });

  it('refuses a base URL that is not a public https origin, naming the variable and never the key', () => {
    for (const bad of [
      'http://api.audivo.dev',
      'https://127.0.0.1',
      'https://user:pw@api.audivo.dev',
    ]) {
      const env = { [CLI_ENV.API_KEY]: KEY, [CLI_ENV.API_BASE_URL]: bad };
      expect(() => configFromEnv(env), bad).toThrow(CliConfigError);
      try {
        configFromEnv(env);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(CLI_ENV.API_BASE_URL);
        expect(message).not.toContain(KEY);
        expect(message).not.toContain('pw');
      }
    }
  });
});

describe('stdioDeps', () => {
  it('writes log lines to the stderr sink, one JSON document per line', () => {
    const lines: string[] = [];
    const deps = stdioDeps(configFromEnv({ [CLI_ENV.API_KEY]: KEY }), {
      fetch: fakeApi().fetch,
      stderr: (line) => lines.push(line),
    });
    deps.log({ event: 'probe', n: 1 });
    expect(lines).toEqual([JSON.stringify({ event: 'probe', n: 1 })]);
  });
});

describe('serve', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('serves the nine tools over the given transport with the configured key on every call', async () => {
    const api = fakeApi();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serve(
      configFromEnv({ [CLI_ENV.API_KEY]: KEY, [CLI_ENV.API_BASE_URL]: BASE_URL }),
      {
        fetch: api.fetch,
        stderr: () => {},
        transport: serverSide,
      },
    );
    close = () => handle.close();

    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'cancel_group',
        'chart_shows',
        'confirm',
        'group_status',
        'list_episodes',
        'list_groups',
        'quote',
        'read_transcript',
        'search_shows',
      ].sort(),
    );

    const result = await client.callTool({ name: 'list_groups', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(api.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    await client.close();
  });
});

describe('main', () => {
  it('returns 1 with one line naming the variable when the key is missing, and starts nothing', async () => {
    const { main } = await import('./cli.js');
    const lines: string[] = [];
    expect(main({}, (line) => lines.push(line))).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CLI_ENV.API_KEY);
  });
});

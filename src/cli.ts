/**
 * The local server: `npx -y @audivo/mcp`, spoken to over stdio by a client
 * that spawns it (Claude Code, Codex, Cursor, and the rest). Ten tools: the
 * same nine as the hosted server at `https://api.audivo.dev/mcp`, built by
 * the same factory, plus the one tool only a process on the caller's own
 * machine can offer: `upload_audio` reads a file off that disk, so
 * `LOCAL_TOOLS` is registered here and nowhere else. What else differs is
 * where the credential comes from and how long a server instance lives.
 *
 * The hosted server builds a fresh `McpServer` per request so a warm
 * container never holds a credential. A local process is one user with one
 * key, so one instance for the life of the process is correct here: the key
 * is read once from `AUDIVO_API_KEY`, carried as a bearer credential, and
 * forwarded verbatim to the API on every call, exactly as the hosted server
 * forwards the `Authorization` header it was sent.
 *
 * stdout is the protocol channel, so every log line goes to stderr.
 */
import type { Transport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createApiClient, type ApiFetch } from './api-client.js';
import { BaseUrlError, assertApiBaseUrl } from './base-url.js';
import { errorName } from './errors.js';
import { LOCAL_TOOLS } from './local-tools.js';
import { createMcpServer, type McpDeps } from './server.js';
import { TOOLS } from './tools.js';
import { undiciTransport } from './transport.js';
import { undiciUploadTransport } from './upload.js';

/** Every variable the local server reads. */
export const CLI_ENV = {
  API_KEY: 'AUDIVO_API_KEY',
  API_BASE_URL: 'AUDIVO_API_BASE_URL',
} as const;

export const DEFAULT_API_BASE_URL = 'https://api.audivo.dev';

export type Env = Readonly<Record<string, string | undefined>>;

export type CliConfig = {
  /** The API origin, with any path prefix and no trailing slash. */
  readonly baseUrl: string;
  /** The `Authorization` value sent on every call: `Bearer ` and the key. */
  readonly credential: string;
};

/** A configuration the server refuses to start on. The message never contains the key. */
export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

export function configFromEnv(env: Env): CliConfig {
  const rawKey = env[CLI_ENV.API_KEY]?.trim() ?? '';
  if (rawKey === '') {
    throw new CliConfigError(
      `${CLI_ENV.API_KEY} is not set. Create an API key in your Audivo dashboard ` +
        '(https://audivo.dev) and export it before starting the server.',
    );
  }
  // A value pasted with its scheme still works; the scheme is normalised.
  const withScheme = /^bearer\s+(\S+)$/i.exec(rawKey);
  const credential = `Bearer ${withScheme?.[1] ?? rawKey}`;

  const rawBaseUrl = env[CLI_ENV.API_BASE_URL]?.trim();
  let baseUrl: string;
  try {
    baseUrl = assertApiBaseUrl(
      rawBaseUrl === undefined || rawBaseUrl === '' ? DEFAULT_API_BASE_URL : rawBaseUrl,
    );
  } catch (error) {
    if (error instanceof BaseUrlError) {
      throw new CliConfigError(
        `${CLI_ENV.API_BASE_URL} is not a public https origin (${error.code}). ` +
          `Leave it unset to use ${DEFAULT_API_BASE_URL}.`,
      );
    }
    throw error;
  }
  return { baseUrl, credential };
}

export type StdioOptions = {
  /** The HTTP transport to the API; undici's `fetch` unless a test says otherwise. */
  readonly fetch?: ApiFetch;
  /** Where log lines go; the process's stderr unless a test says otherwise. */
  readonly stderr?: (line: string) => void;
  /** The MCP transport; the process's stdio unless a test says otherwise. */
  readonly transport?: Transport;
};

const processStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export function stdioDeps(
  config: CliConfig,
  options: { readonly fetch: ApiFetch; readonly stderr: (line: string) => void },
): McpDeps {
  return {
    api: createApiClient({ baseUrl: config.baseUrl, fetch: options.fetch }),
    log: (event) => options.stderr(JSON.stringify(event)),
    // What makes `upload_audio` answerable here: the presigned PUT, over the
    // same pinned undici the API calls go out on.
    upload: undiciUploadTransport,
  };
}

/** Every tool this server registers: the hosted catalog, and the local-only one. */
export const SERVED_TOOLS = Object.freeze([...TOOLS, ...LOCAL_TOOLS]);

/** Starts serving and returns the handle; the transport keeps the process alive until it closes. */
export function serve(config: CliConfig, options: StdioOptions = {}): StdioServerHandle {
  const deps = stdioDeps(config, {
    fetch: options.fetch ?? undiciTransport,
    stderr: options.stderr ?? processStderr,
  });
  return serveStdio(() => createMcpServer(deps, config.credential, SERVED_TOOLS), {
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    onerror: (error) => deps.log({ event: 'mcp_error', error: errorName(error) }),
  });
}

/** The `bin` entry's body: an exit code, so the entry file can stay one line of wiring. */
export function main(
  env: Env = process.env,
  stderr: (line: string) => void = processStderr,
): number {
  let config: CliConfig;
  try {
    config = configFromEnv(env);
  } catch (error) {
    if (error instanceof CliConfigError) {
      stderr(error.message);
      return 1;
    }
    throw error;
  }
  serve(config, { stderr });
  stderr(`audivo-mcp: serving ${SERVED_TOOLS.length} tools over stdio against ${config.baseUrl}`);
  return 0;
}

/**
 * The Lambda entry point for the hosted MCP server: stateless Streamable
 * HTTP, one function, no table, no bucket, no secret. This is what serves
 * `https://api.audivo.dev/mcp`.
 *
 * Everything the function needs is the API's base URL. It is checked with
 * `assertApiBaseUrl` before a connection can be opened — https only, no
 * userinfo, no loopback, link-local, or metadata literal — so a misconfigured
 * URL fails the cold start rather than sending a customer's key somewhere it
 * should not go. The transport is undici's `fetch`, pinned.
 */
import { createApiClient, type ApiFetch } from './api-client.js';
import { assertApiBaseUrl } from './base-url.js';
import {
  toLambdaResponse,
  toWebRequest,
  type LambdaHttpEvent,
  type LambdaHttpResponse,
} from './http.js';
import { createHandler, type McpDeps, type McpHandler } from './server.js';
import { undiciTransport } from './transport.js';

/**
 * Every variable this function reads. `AUDIVO_API_BASE_URL` is the public
 * API's origin, with any stage prefix
 * (`https://….execute-api.eu-west-1.amazonaws.com/staging`).
 */
export const MCP_ENV = {
  STAGE: 'AUDIVO_STAGE',
  API_BASE_URL: 'AUDIVO_API_BASE_URL',
} as const;

export type Env = Readonly<Record<string, string | undefined>>;
export type { LambdaHttpEvent, LambdaHttpResponse };

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`environment variable ${name} is required`);
  }
  return value;
}

export { undiciTransport };

export function mcpDepsFromEnv(env: Env, transport: ApiFetch): McpDeps {
  // Throws `BaseUrlError` for anything this server refuses to connect to;
  // the message names the rule, never the URL's userinfo.
  const baseUrl = assertApiBaseUrl(requireEnv(env, MCP_ENV.API_BASE_URL));
  return {
    api: createApiClient({ baseUrl, fetch: transport }),
    log: (event) => console.log(JSON.stringify(event)),
  };
}

let defaultHandler: McpHandler | undefined;

export async function handler(event: LambdaHttpEvent): Promise<LambdaHttpResponse> {
  defaultHandler ??= createHandler(mcpDepsFromEnv(process.env, undiciTransport));
  return toLambdaResponse(await defaultHandler.fetch(toWebRequest(event)));
}

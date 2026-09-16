import { describe, expect, it } from 'vitest';
import { MCP_ENV, mcpDepsFromEnv, undiciTransport } from './lambda.js';
import { toLambdaResponse, toWebRequest } from './http.js';
import { createHandler } from './server.js';
import { BASE_URL, CREDENTIAL, fakeApi } from './testing/fake-api.js';

describe('the environment', () => {
  it('requires the API base URL', () => {
    expect(() => mcpDepsFromEnv({}, fakeApi().fetch)).toThrow(
      `environment variable ${MCP_ENV.API_BASE_URL} is required`,
    );
    const blank = { [MCP_ENV.API_BASE_URL]: '  ' };
    expect(() => mcpDepsFromEnv(blank, fakeApi().fetch)).toThrow(/is required/);
  });

  it('refuses a base URL that is not a public https origin, before any request', () => {
    const refused = [
      'http://api.hark.test',
      'https://user:pw@api.hark.test',
      'https://127.0.0.1/api',
      'https://169.254.169.254/latest',
      'not a url',
    ];
    for (const bad of refused) {
      expect(() => mcpDepsFromEnv({ [MCP_ENV.API_BASE_URL]: bad }, fakeApi().fetch), bad).toThrow();
    }
  });

  it('wires a client on the base URL, with a log that writes JSON lines', () => {
    const deps = mcpDepsFromEnv({ [MCP_ENV.API_BASE_URL]: `${BASE_URL}/` }, fakeApi().fetch);
    expect(deps.api.baseUrl).toBe(BASE_URL);
    expect(deps.api.transcriptReference('job_0123456789abcdef')).toBe(
      `${BASE_URL}/v1/transcripts/job_0123456789abcdef?format=json`,
    );
    expect(typeof deps.log).toBe('function');
  });

  it("exposes undici's fetch narrowed to the client's seam", () => {
    expect(typeof undiciTransport).toBe('function');
  });
});

describe('the Lambda wiring', () => {
  it('answers a proxy event end to end through the handler', async () => {
    const api = fakeApi();
    const env = { [MCP_ENV.API_BASE_URL]: BASE_URL };
    const handler = createHandler({ ...mcpDepsFromEnv(env, api.fetch), log: () => {} });
    const event = {
      httpMethod: 'POST',
      path: '/mcp',
      headers: {
        Host: 'mcp.hark.test',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
        Authorization: CREDENTIAL,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_groups', arguments: {} },
      }),
      isBase64Encoded: false,
    };
    const response = await toLambdaResponse(await handler.fetch(toWebRequest(event)));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    type Body = { result: { isError?: boolean; content: { text: string }[] } };
    const body = JSON.parse(response.body) as Body;
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ groups: [{ n: 1 }] });
    expect(api.calls[0]!.headers.authorization).toBe(CREDENTIAL);
  });
});

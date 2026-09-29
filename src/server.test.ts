/**
 * The server over the wire: JSON-RPC requests as an MCP client sends them,
 * both protocol eras, and the properties that only exist at this layer —
 * one credential per request and none between them, no key in any log line
 * or result, a tool surface no transcript can be fed into, and a listing
 * that fits the budget.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createApiClient } from './api-client.js';
import {
  SERVER_INFO,
  createHandler,
  createMcpServer,
  credentialOf,
  type Logger,
  type McpDeps,
} from './server.js';
import {
  MAX_INPUT_STRING_LENGTH,
  TOOLS,
  TOOL_NAMES,
  TOOL_SURFACE_TOKEN_BUDGET,
  estimateTokens,
} from './tools.js';
import {
  BASE_URL,
  CREDENTIAL,
  FEED_URL,
  GROUP_ID,
  JOB_ID,
  OTHER_CREDENTIAL,
  OTHER_TOKEN,
  QUOTE_ID,
  READ_ID,
  SHOW_ID,
  TOKEN,
  errorEnvelope,
  fakeApi,
  jobStatus,
  nonces,
  transcriptRead,
  type FakeApiOptions,
} from './testing/fake-api.js';

type Era = 'legacy' | 'modern';
const ERAS: Era[] = ['legacy', 'modern'];
type Handler = { fetch(request: Request): Promise<Response> };

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'suite', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function wired(options: FakeApiOptions = {}) {
  const api = fakeApi(options);
  const lines: Record<string, unknown>[] = [];
  const log: Logger = (event) => lines.push(event);
  const deps: McpDeps = {
    api: createApiClient({ baseUrl: BASE_URL, fetch: api.fetch }),
    log,
    nonce: nonces('0123456789abcdef', 'fedcba9876543210'),
  };
  return { api, lines, deps, handler: createHandler(deps) };
}

let nextId = 1;

type RequestOptions = {
  readonly credential?: string | null;
  readonly era?: Era;
  readonly toolName?: string;
};

function request(method: string, params: Record<string, unknown>, options: RequestOptions = {}) {
  const era = options.era ?? 'legacy';
  const id = nextId++;
  const body =
    era === 'modern'
      ? { jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } }
      : { jsonrpc: '2.0', id, method, params };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': era === 'modern' ? '2026-07-28' : '2025-11-25',
  };
  if (era === 'modern') {
    headers['mcp-method'] = method;
    if (options.toolName !== undefined) headers['mcp-name'] = options.toolName;
  }
  const credential = options.credential === undefined ? CREDENTIAL : options.credential;
  if (credential !== null) headers.authorization = credential;
  return new Request('https://mcp.hark.test/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function rpc(handler: Handler, req: Request) {
  const response = await handler.fetch(req);
  const text = await response.text();
  expect(response.headers.get('content-type') ?? '').toMatch(/^application\/json/);
  const body = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
  return { status: response.status, body, text };
}

async function listTools(handler: Handler, era: Era = 'legacy') {
  const { status, body } = await rpc(handler, request('tools/list', {}, { era }));
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  return (body.result as { tools: Record<string, unknown>[] }).tools;
}

async function callTool(
  handler: Handler,
  name: string,
  args: unknown,
  options: { readonly credential?: string | null; readonly era?: Era } = {},
): Promise<{ result: CallToolResult; text: string; status: number }> {
  const { status, body, text } = await rpc(
    handler,
    request('tools/call', { name, arguments: args }, { ...options, toolName: name }),
  );
  expect(body.error).toBeUndefined();
  return { result: body.result as CallToolResult, text, status };
}

function trustedOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no trusted block');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('the listing', () => {
  it.each(ERAS)('serves all ten tools with their annotations (%s)', async (era) => {
    const { handler } = wired();
    const tools = await listTools(handler, era);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name as string, tool]));
    const annotations = (name: string) => byName[name]!.annotations;
    expect(annotations('confirm')).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(annotations('cancel_group')).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    for (const name of ['search_shows', 'chart_shows', 'group_status', 'list_groups']) {
      expect(annotations(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(annotations('read_transcript')).toMatchObject({ readOnlyHint: true });
    expect(annotations('quote')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // It spends, so it is not read-only; it creates and charges and never
    // deletes or overwrites, so it is not destructive; the same call returns
    // the same job, so it is idempotent.
    expect(annotations('transcribe')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    for (const tool of tools) expect((tool.inputSchema as { type: string }).type).toBe('object');
  });

  it('leaves the local tools to the local server: ten tools, none of them local-only', async () => {
    const { handler } = wired();
    const tools = await listTools(handler);
    // `upload_audio` reads a file off the caller's disk and `youtube_search`
    // runs yt-dlp on it; this process has seen neither, and nothing Audivo
    // hosts fetches from YouTube, so the hosted surface offers neither.
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.name)).not.toContain('upload_audio');
    expect(tools.map((tool) => tool.name)).not.toContain('youtube_search');
    // And its `transcribe` takes no file path.
    const transcribe = tools.find((tool) => tool.name === 'transcribe')!;
    expect(
      Object.keys((transcribe.inputSchema as { properties: object }).properties),
    ).not.toContain('path');
  });

  it('stays within the token budget', async () => {
    const { handler } = wired();
    const tools = await listTools(handler);
    const chars = JSON.stringify(tools).length;
    const tokens = estimateTokens(JSON.stringify(tools));
    console.log(`tool surface: ${chars} chars, ~${tokens} tokens of ${TOOL_SURFACE_TOKEN_BUDGET}`);
    expect(tokens).toBeLessThanOrEqual(TOOL_SURFACE_TOKEN_BUDGET);
  });

  it('takes no transcript text: bounded strings, capped arrays, no prose names', async () => {
    const { handler } = wired();
    const tools = await listTools(handler);
    const FORBIDDEN =
      /transcript|text|content|segment|body|prompt|instruction|message|note|summary/i;
    const strings: string[] = [];
    type Schema = Record<string, unknown>;
    const visit = (schema: Schema, path: string): void => {
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        const branches = (schema[key] as Schema[] | undefined) ?? [];
        for (const [index, branch] of branches.entries()) visit(branch, `${path}[${key}${index}]`);
      }
      if (schema.type === 'string') {
        strings.push(path);
        const bound = schema.maxLength as number | undefined;
        expect(bound, `${path} is an unbounded string`).toBeTypeOf('number');
        expect(bound, `${path} is over the longest input`).toBeLessThanOrEqual(
          MAX_INPUT_STRING_LENGTH,
        );
      }
      if (schema.type === 'array') {
        expect(schema.maxItems, `${path} is an unbounded array`).toBeTypeOf('number');
        visit(schema.items as Schema, `${path}[]`);
      }
      const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [name, property] of Object.entries(properties)) {
        expect(name, `${path}.${name} is named for prose`).not.toMatch(FORBIDDEN);
        visit(property, `${path}.${name}`);
      }
    };
    for (const tool of tools) visit(tool.inputSchema as Schema, tool.name as string);
    // The sweep saw the surface: at least one string per tool that takes one.
    expect(strings.length).toBeGreaterThanOrEqual(TOOLS.length - 1);
  });
});

describe('a tool call', () => {
  it.each(ERAS)("carries the request's key to the API, two blocks back (%s)", async (era) => {
    const { api, handler } = wired();
    const { result } = await callTool(handler, 'search_shows', { q: 'daily' }, { era });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(trustedOf(result)).toMatchObject({
      shows: [{ n: 1 }, { n: 2 }],
      untrusted_content: { nonce: '0123456789abcdef' },
    });
    expect(api.callsTo('searchShows')[0]!.headers.authorization).toBe(CREDENTIAL);
  });

  it.each(ERAS)(
    'delivers a paid cache read’s text, inside the fence, end to end (%s)',
    async (era) => {
      const { api, handler } = wired({ reads: { [READ_ID]: transcriptRead() } });

      // The whole arc a confirm on a cached episode leaves behind: the group
      // names the read, and this is the call that turns the id into text.
      const { result } = await callTool(handler, 'read_transcript', { read_id: READ_ID }, { era });

      expect(result.isError).toBeFalsy();
      const trusted = trustedOf(result);
      expect(trusted).toMatchObject({
        read_id: READ_ID,
        credits_charged: 0,
        untrusted_content: { nonce: '0123456789abcdef' },
      });
      // The transcript is in the second block, between the markers the first
      // block names, and nowhere else.
      const [, fenced] = result.content;
      if (fenced?.type !== 'text') throw new Error('no fenced block');
      const { begin, end } = (trusted.untrusted_content as Record<string, string>) ?? {};
      const between = fenced.text.slice(
        fenced.text.indexOf(begin!) + begin!.length,
        fenced.text.indexOf(end!),
      );
      expect(between).toContain('Today we are talking about credits.');
      expect(JSON.stringify(trusted)).not.toContain('Today we are talking about credits.');
      expect(api.callsTo('getTranscriptRead')[0]!.headers.authorization).toBe(CREDENTIAL);
    },
  );

  it('refuses a call with no key as unauthenticated without calling the API', async () => {
    const { api, handler } = wired();
    const anonymous = { credential: null };
    const { result } = await callTool(handler, 'search_shows', { q: 'daily' }, anonymous);
    expect(result.isError).toBe(true);
    expect(trustedOf(result)).toMatchObject({
      error: { origin: 'mcp', code: 'unauthenticated', type: 'unauthenticated' },
    });
    expect(api.calls).toHaveLength(0);
  });

  it('treats a non-bearer Authorization value as no key', async () => {
    const { api, handler } = wired();
    const basic = { credential: 'Basic dXNlcjpwYXNz' };
    const { result } = await callTool(handler, 'list_groups', {}, basic);
    expect(trustedOf(result)).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(api.calls).toHaveLength(0);
    expect(credentialOf(undefined)).toBeNull();
    const bare = new Request('https://x', { headers: { authorization: 'Bearer' } });
    expect(credentialOf(bare)).toBeNull();
    const padded = new Request('https://x', { headers: { authorization: ` ${CREDENTIAL} ` } });
    expect(credentialOf(padded)).toBe(CREDENTIAL);
  });

  it('answers a schema violation from the SDK without calling the API', async () => {
    const { api, handler } = wired();
    const args = { quote_ref: QUOTE_ID, expected_total_credits: 150, idempotency_key: 'k' };
    const { result } = await callTool(handler, 'confirm', args);
    expect(result.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses a mismatched confirm total over the wire and never reaches the API', async () => {
    const { api, handler, lines } = wired();
    const args = {
      quote_ref: `${QUOTE_ID}:150`,
      expected_total_credits: 15,
      idempotency_key: 'k1',
    };
    const { result } = await callTool(handler, 'confirm', args);
    expect(result.isError).toBe(true);
    expect(trustedOf(result)).toMatchObject({
      error: { origin: 'mcp', code: 'expected_total_mismatch' },
    });
    expect(api.calls).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({
      tool: 'confirm',
      outcome: 'error',
      code: 'expected_total_mismatch',
      api: [],
    });
  });

  it('answers 405 to a GET on the stateless legacy leg', async () => {
    const { handler } = wired();
    const response = await handler.fetch(
      new Request('https://mcp.hark.test/mcp', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
    );
    expect(response.status).toBe(405);
  });
});

describe('statelessness across requests', () => {
  it("serves a second account with none of the first's key, and a third with none", async () => {
    const { api, handler } = wired();
    await callTool(handler, 'list_groups', {}, { credential: CREDENTIAL });
    await callTool(handler, 'list_groups', {}, { credential: OTHER_CREDENTIAL, era: 'modern' });
    const third = await callTool(handler, 'list_groups', {}, { credential: null });

    const sent = api.calls.map((call) => call.headers.authorization);
    expect(sent).toEqual([CREDENTIAL, OTHER_CREDENTIAL]);
    expect(third.result.isError).toBe(true);
    expect(third.text).not.toContain(TOKEN);
    expect(third.text).not.toContain(OTHER_TOKEN);
  });

  it('builds a fresh server per request, credential in its closure and on no field', () => {
    const { deps } = wired();
    const a = createMcpServer(deps, CREDENTIAL);
    const b = createMcpServer(deps, OTHER_CREDENTIAL);
    expect(a).not.toBe(b);
    expect(JSON.stringify(Object.entries(a))).not.toContain(TOKEN);
    expect(JSON.stringify(Object.entries(b))).not.toContain(OTHER_TOKEN);
    expect(JSON.stringify(deps)).not.toContain(TOKEN);
  });
});

describe('what leaves the server', () => {
  it('never carries the key in a log line or a result, whatever happens', async () => {
    const leaky = new Error(`ECONNRESET while sending authorization: ${CREDENTIAL}`);
    leaky.name = 'FetchError';
    const conflict = errorEnvelope({
      code: 'idempotency_conflict',
      type: 'conflict',
      message: `you sent ${CREDENTIAL}`,
    });
    const withTranscript: FakeApiOptions = { transcripts: { [JOB_ID]: jobStatus() } };
    const confirmArgs = {
      quote_ref: `${QUOTE_ID}:150`,
      expected_total_credits: 150,
      idempotency_key: 'k',
    };
    const cases: { options: FakeApiOptions; tool: string; args: unknown }[] = [
      { options: withTranscript, tool: 'read_transcript', args: { job_id: JOB_ID } },
      { options: withTranscript, tool: 'group_status', args: { group_id: GROUP_ID } },
      { options: {}, tool: 'quote', args: { shows: [{ feed_url: FEED_URL }] } },
      {
        options: { answers: { listShowEpisodes: { status: 404, body: `no ${CREDENTIAL}` } } },
        tool: 'list_episodes',
        args: { show_id: SHOW_ID, feed_url: FEED_URL },
      },
      { options: {}, tool: 'confirm', args: confirmArgs },
      {
        options: {
          created: { status: 402, body: `no credit for ${CREDENTIAL}` },
        },
        tool: 'transcribe',
        args: { url: 'https://podcasts.apple.com/us/podcast/x/id123?i=456' },
      },
      { options: { throws: leaky }, tool: 'search_shows', args: { q: 'x' } },
      {
        options: { answers: { getChart: { status: 500, body: `<html>${CREDENTIAL}</html>` } } },
        tool: 'chart_shows',
        args: { category: 'News' },
      },
      {
        options: { answers: { listGroups: { status: 200, body: `not json ${CREDENTIAL}` } } },
        tool: 'list_groups',
        args: {},
      },
      {
        options: { answers: { cancelGroup: { status: 409, body: JSON.stringify(conflict) } } },
        tool: 'cancel_group',
        args: { group_id: GROUP_ID },
      },
    ];
    const seenTools = new Set<string>();
    for (const { options, tool, args } of cases) {
      const { handler, lines } = wired(options);
      const { text } = await callTool(handler, tool, args);
      seenTools.add(tool);
      expect(lines.length).toBeGreaterThan(0);
      for (const written of [JSON.stringify(lines), text]) {
        expect(written, `${tool} leaked the credential`).not.toContain(TOKEN);
        expect(written, `${tool} leaked a key prefix`).not.toContain('hk_live_');
      }
      const line = lines.at(-1)!;
      expect(line).toMatchObject({ tool, authenticated: true });
      expect(Object.keys(line)).not.toContain('headers');
    }
    expect([...seenTools].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('logs the trace and outcome, and the error name only for an internal failure', async () => {
    const { handler, lines } = wired({
      transcripts: { [JOB_ID]: jobStatus() },
      reads: { [READ_ID]: transcriptRead() },
    });
    await callTool(handler, 'group_status', { group_id: GROUP_ID });
    expect(lines.at(-1)).toMatchObject({
      tool: 'group_status',
      outcome: 'ok',
      api: [
        { operation: 'getGroup', status: 200 },
        { operation: 'getTranscriptJob', status: 200 },
        // The group's cache read is fetched too: it is content the account
        // has already paid for, and it has no job to poll.
        { operation: 'getTranscriptRead', status: 200 },
      ],
    });
    expect(lines.at(-1)).toHaveProperty('ms');

    const broken = wired();
    // A handler that throws something untyped is the one case whose text is
    // hidden from the caller, and whose name is what an operator gets.
    const explode = createHandler({
      ...broken.deps,
      api: { ...broken.deps.api, listGroups: () => Promise.reject(new RangeError('boom')) },
    });
    const { result } = await callTool(explode, 'list_groups', {});
    expect(trustedOf(result)).toMatchObject({
      error: { origin: 'mcp', code: 'internal_error', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain('boom');
    expect(broken.lines.at(-1)).toMatchObject({
      tool: 'list_groups',
      outcome: 'error',
      code: 'internal_error',
      error: 'RangeError',
    });
  });

  it('scrubs the log line even when an unexpected error is named after the key', async () => {
    // The only field a log line takes from an error is its name, and the
    // name is the one thing a library could have built from the request.
    const { deps, lines } = wired();
    const named = new Error('boom');
    named.name = `FetchError(${CREDENTIAL})`;
    const explode = createHandler({
      ...deps,
      api: { ...deps.api, listGroups: () => Promise.reject(named) },
    });
    const { text } = await callTool(explode, 'list_groups', {});
    expect(lines.at(-1)).toMatchObject({ tool: 'list_groups', code: 'internal_error' });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
  });

  it('names itself', () => {
    expect(SERVER_INFO).toEqual({ name: 'audivo', version: '0.3.0' });
  });
});

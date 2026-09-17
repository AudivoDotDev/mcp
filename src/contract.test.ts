/**
 * The tools against the contract they call. Two checks, because each
 * catches what the other cannot:
 *
 * - **Compile time.** The client's request and response types *are* the
 *   generated ones (`api-client.ts` imports them), and every fixture in
 *   `testing/fake-api.ts` is declared as its `components['schemas']` type;
 *   a renamed field stops the package compiling.
 * - **Run time.** The fixtures the tools are exercised against, and the
 *   bodies and query strings the tools actually send, are validated with
 *   ajv against the bundled spec — so a fixture that is well-typed but out
 *   of bounds, or a query parameter the operation does not declare, fails
 *   here rather than against the real API.
 */
import { beforeAll, describe, expect, it } from 'vitest';
// See openapi/tests/examples.test.ts for why ajv is cast through a local
// interface rather than imported directly.
import * as Ajv2020Module from 'ajv/dist/2020.js';
import * as AjvFormatsModule from 'ajv-formats';
import { loadSpec } from './testing/spec.js';
import { API_PATHS, createApiClient, type ApiOperation } from './api-client.js';
import { ERROR_TYPES } from './errors.js';
import { TOOLS, type ToolContext } from './tools.js';
import {
  BASE_URL,
  CHART,
  CREDENTIAL,
  EPISODES,
  EPISODE_ID,
  FEED_URL,
  GROUP,
  GROUPS,
  GROUP_ID,
  JOB_ID,
  QUOTE,
  QUOTE_ID,
  READ_ID,
  SEARCH,
  SHOW_ID,
  UPLOAD_CREATED,
  errorEnvelope,
  fakeApi,
  jobStatus,
  nonces,
  transcriptRead,
  type RecordedCall,
} from './testing/fake-api.js';

type AjvValidateFunction = ((data: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  compile(schema: object): AjvValidateFunction;
}
interface AjvConstructor {
  new (opts?: { strict?: boolean; allErrors?: boolean }): AjvInstance;
}

const Ajv2020 = Ajv2020Module.default as unknown as AjvConstructor;
const addFormats = AjvFormatsModule.default as unknown as (ajv: AjvInstance) => void;

type Parameter = { name: string; in: string; required?: boolean; schema: object };
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: object }> };
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, object> };
};

let spec: Spec;
let ajv: AjvInstance;

beforeAll(() => {
  spec = loadSpec() as unknown as Spec;
  ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
});

function validate(schema: object, data: unknown): void {
  const check = ajv.compile(schema);
  const ok = check(data);
  expect(ok, JSON.stringify(check.errors, null, 2)).toBe(true);
}

function schemaOf(name: string): object {
  const schema = spec.components.schemas[name];
  if (schema === undefined) throw new Error(`no schema ${name}`);
  return schema;
}

function operationOf(operationId: string) {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === operationId) {
        return { path, method: method.toUpperCase(), operation };
      }
    }
  }
  throw new Error(`no operation ${operationId}`);
}

const OPERATIONS = Object.keys(API_PATHS) as ApiOperation[];
// createUpload joins this sweep once a tool sends it (upload_audio, a later
// task): nothing here calls it yet, so it would fail "was never sent".
const SENT_OPERATIONS = OPERATIONS.filter((operation) => operation !== 'createUpload');

describe('the fixtures the suites run against', () => {
  it.each([
    ['ShowSearchResponse', SEARCH],
    ['ChartResponse', CHART],
    ['EpisodesListResponse', EPISODES],
    ['QuoteResponse', QUOTE],
    ['JobGroupResponse', GROUP],
    ['JobGroupsListResponse', GROUPS],
    ['JobStatus', jobStatus()],
    ['TranscriptRead', transcriptRead()],
    ['UploadCreated', UPLOAD_CREATED],
    ['Error', errorEnvelope({ code: 'payment_required', type: 'payment_required' })],
  ])('%s validates against the contract', (name, fixture) => {
    validate(schemaOf(name), fixture);
  });

  it("validates a literal CreateUploadRequest against the contract's schema", () => {
    validate(schemaOf('CreateUploadRequest'), {
      sha256: 'a'.repeat(64),
      bytes: 4_500_000,
      content_type: 'audio/mpeg',
      declared_duration_seconds: 1800,
      title: 'A test upload',
    });
  });
});

describe('the error table', () => {
  it('pairs every code with the type the contract pairs it with', () => {
    // A mismatched pair matches no `oneOf` branch of `ErrorDetail`.
    for (const [code, type] of Object.entries(ERROR_TYPES)) {
      const detail = { code, type } as Parameters<typeof errorEnvelope>[0];
      validate(schemaOf('Error'), errorEnvelope(detail));
    }
    // And the table names every code the contract enumerates, exactly.
    const enumerated = (schemaOf('ErrorCode') as { enum: string[] }).enum;
    expect(Object.keys(ERROR_TYPES).sort()).toEqual([...enumerated].sort());
  });
});

describe('what each tool sends', () => {
  const sent: Partial<Record<ApiOperation, RecordedCall>> = {};

  beforeAll(async () => {
    const api = fakeApi({
      transcripts: { [JOB_ID]: jobStatus() },
      reads: { [READ_ID]: transcriptRead() },
    });
    const ctx: ToolContext = {
      credential: CREDENTIAL,
      api: createApiClient({ baseUrl: BASE_URL, fetch: api.fetch }),
      nonce: nonces('0123456789abcdef'),
      trace: [],
    };
    const calls: [string, unknown][] = [
      ['search_shows', { q: 'daily', limit: 5 }],
      ['chart_shows', { category: 'News', size: 25, language: 'en' }],
      [
        'list_episodes',
        {
          show_id: SHOW_ID,
          feed_url: FEED_URL,
          itunes_id: 1,
          limit: 5,
          cursor: 'eyJvZmZzZXQiOjJ9',
        },
      ],
      [
        'quote',
        {
          shows: [{ feed_url: FEED_URL, itunes_id: 1, title: 'x', episode_ids: [EPISODE_ID] }],
          episodes_per_show: 2,
          include_music_led: true,
        },
      ],
      [
        'confirm',
        { quote_ref: `${QUOTE_ID}:150`, expected_total_credits: 150, idempotency_key: 'k' },
      ],
      ['list_groups', { limit: 3 }],
      ['group_status', { group_id: GROUP_ID }],
      ['cancel_group', { group_id: GROUP_ID }],
      ['read_transcript', { job_id: JOB_ID }],
      // The same tool's other id: a settled cache read, on its own operation.
      ['read_transcript', { read_id: READ_ID }],
    ];
    for (const [name, args] of calls) {
      const tool = TOOLS.find((candidate) => candidate.name === name)!;
      await tool.handler(tool.inputSchema.parse(args), ctx);
    }
    for (const call of api.calls) {
      if (call.operation !== 'unknown') sent[call.operation] ??= call;
    }
  });

  it.each(SENT_OPERATIONS)("%s hits the contract's path and method", (operationId) => {
    const { path, method } = operationOf(operationId);
    expect(API_PATHS[operationId]).toBe(path);
    const call = sent[operationId];
    expect(call, `${operationId} was never sent`).toBeDefined();
    expect(call!.method).toBe(method);
    const template = path.replace(/\{(\w+)\}/g, '([^/]+)');
    expect(call!.path).toMatch(new RegExp(`^${template}$`));
  });

  it.each(SENT_OPERATIONS)('%s sends only declared query parameters, all required ones', (id) => {
    const { operation } = operationOf(id);
    const call = sent[id]!;
    const declared = (operation.parameters ?? []).filter((parameter) => parameter.in === 'query');
    for (const [name, value] of call.query) {
      const parameter = declared.find((candidate) => candidate.name === name);
      expect(parameter, `${id} sent undeclared query parameter ${name}`).toBeDefined();
      const schema = parameter!.schema as { type?: string };
      validate(parameter!.schema, schema.type === 'integer' ? Number(value) : value);
    }
    for (const parameter of declared.filter((candidate) => candidate.required === true)) {
      expect(call.query.has(parameter.name), `${id} omitted ${parameter.name}`).toBe(true);
    }
  });

  it.each(SENT_OPERATIONS)('%s sends a body only when the operation takes one', (id) => {
    const { operation } = operationOf(id);
    const call = sent[id]!;
    const bodySchema = operation.requestBody?.content['application/json']?.schema;
    if (bodySchema === undefined) {
      expect(call.body, `${id} sent a body the operation does not take`).toBeUndefined();
    } else {
      expect(call.body, `${id} sent no body`).toBeDefined();
      validate(bodySchema, call.body);
    }
  });

  it("sends the confirm's required Idempotency-Key header", () => {
    const { operation } = operationOf('confirmQuote');
    const header = (operation.parameters ?? []).find((parameter) => parameter.in === 'header');
    expect(header).toMatchObject({ name: 'Idempotency-Key', required: true });
    expect(sent.confirmQuote!.headers['idempotency-key']).toBe('k');
    validate(header!.schema, sent.confirmQuote!.headers['idempotency-key']);
  });

  it("reads the transcript with the contract's explicit json format", () => {
    expect(sent.getTranscriptJob!.query.get('format')).toBe('json');
    expect(sent.getTranscriptRead!.query.get('format')).toBe('json');
  });
});

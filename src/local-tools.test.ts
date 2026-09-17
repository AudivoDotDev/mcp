/**
 * `upload_audio` as one typed call, driven the way `tools.test.ts` drives the
 * hosted nine: arguments parsed through the same schema the SDK validates
 * against, a fake API recording what was announced, and a fake transport
 * recording what was PUT.
 *
 * The happy paths run against a real WAV written to a temp directory, so the
 * hash, the size, the content type and the duration in the announcement are
 * the file's own. Only the facts a fixture cannot honestly carry — a file
 * over five gigabytes, a container nothing recognises, a duration the
 * container does not state — are simulated, by injecting an `inspect` seam.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiClient } from './api-client.js';
import { McpToolError } from './errors.js';
import { LOCAL_TOOLS, MAX_UPLOAD_BYTES, localTools } from './local-tools.js';
import type { ToolContext } from './tools.js';
import type { AudioFileFacts } from './upload.js';
import { writeWavFixture } from './testing/audio-file.js';
import {
  BASE_URL,
  CREDENTIAL,
  TOKEN,
  UPLOAD_CREATED,
  UPLOAD_ID,
  fakeApi,
  fakeUploadTransport,
  nonces,
  type FakeApiOptions,
  type FakeResponse,
  type FakeUploadRejection,
} from './testing/fake-api.js';

const NONCE = '0123456789abcdef';
const SECONDS = 2.5;

function sha256Of(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

type HarnessOptions = {
  readonly api?: FakeApiOptions;
  /** What the presigned PUT answers; 200 with an empty body unless a test says otherwise. */
  readonly put?: FakeResponse | FakeUploadRejection;
  /** Replaces the real `inspectAudioFile`, for facts a fixture cannot honestly carry. */
  readonly inspect?: (filePath: string) => Promise<AudioFileFacts>;
  readonly credential?: string | null;
  /** `false` drops the transport from the context, as the hosted server does. */
  readonly transport?: false;
};

function harness(options: HarnessOptions = {}) {
  const api = fakeApi(options.api);
  const upload = fakeUploadTransport(options.put);
  const tools =
    options.inspect === undefined ? LOCAL_TOOLS : localTools({ inspect: options.inspect });
  const tool = tools.find((candidate) => candidate.name === 'upload_audio');
  if (tool === undefined) throw new Error('no tool upload_audio');
  const ctx: ToolContext = {
    credential: options.credential === undefined ? CREDENTIAL : options.credential,
    api: createApiClient({ baseUrl: BASE_URL, fetch: api.fetch }),
    nonce: nonces(NONCE),
    trace: [],
    ...(options.transport === false ? {} : { upload }),
  };
  const run = async (args: unknown) => tool.handler(tool.inputSchema.parse(args), ctx);
  const fail = async (args: unknown): Promise<McpToolError> => {
    try {
      await run(args);
    } catch (error) {
      if (error instanceof McpToolError) return error;
      throw error;
    }
    throw new Error('upload_audio did not fail');
  };
  return { api, upload, run, fail };
}

/** The facts the real inspector would report for the WAV fixture, as a starting point. */
function facts(overrides: Partial<AudioFileFacts> = {}): AudioFileFacts {
  return {
    bytes: 40_044,
    sha256: 'a'.repeat(64),
    contentType: 'audio/wav',
    durationSeconds: SECONDS,
    container: 'WAVE',
    ...overrides,
  };
}

function inspectAs(
  overrides: Partial<AudioFileFacts>,
): (filePath: string) => Promise<AudioFileFacts> {
  return async () => facts(overrides);
}

describe('the local tool table', () => {
  it('is exactly upload_audio, annotated as a write that reaches the outside world', () => {
    expect(LOCAL_TOOLS.map((tool) => tool.name)).toEqual(['upload_audio']);
    expect(LOCAL_TOOLS[0]!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('upload_audio announces the file', () => {
  it('sends the file it hashed: sha256, size, content type, duration, and the title given', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { api, run } = harness();

    await run({ path: filePath, title: 'A test upload' });

    const calls = api.callsTo('createUpload');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/uploads');
    expect(calls[0]!.body).toEqual({
      sha256: sha256Of(filePath),
      bytes: fs.statSync(filePath).size,
      content_type: 'audio/wav',
      declared_duration_seconds: expect.closeTo(SECONDS, 3),
      title: 'A test upload',
    });
  });

  it('omits the title when none was given, and prefers the arguments over the file', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { api, run } = harness();

    await run({ path: filePath, content_type: 'audio/x-wav', declared_duration_seconds: 99 });

    const body = api.callsTo('createUpload')[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('title');
    expect(body.content_type).toBe('audio/x-wav');
    expect(body.declared_duration_seconds).toBe(99);
  });

  it('takes an explicit content_type for a container it could not place', async () => {
    const { api, run } = harness({
      inspect: inspectAs({ contentType: null, container: 'Matroska' }),
    });

    await run({ path: '/tmp/clip.mkv', content_type: 'audio/webm' });

    expect((api.callsTo('createUpload')[0]!.body as { content_type: string }).content_type).toBe(
      'audio/webm',
    );
  });

  it('forwards the credential verbatim and keeps it out of the result', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { api, run } = harness();

    const doc = await run({ path: filePath });

    expect(api.calls[0]!.headers.authorization).toBe(CREDENTIAL);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
  });
});

describe('upload_audio sends the bytes', () => {
  it('PUTs the same file to the presigned URL with exactly the headers the API returned', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { upload, run } = harness();

    await run({ path: filePath });

    expect(upload.puts).toEqual([
      {
        url: UPLOAD_CREATED.put_url,
        headers: UPLOAD_CREATED.put_headers,
        path: filePath,
      },
    ]);
  });

  it('hands back a quote handle, naming the file by its basename and never its directory', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { run } = harness();

    const doc = await run({ path: filePath });

    expect(doc.trusted).toEqual({
      upload_id: UPLOAD_ID,
      file: 'fixture.wav',
      bytes: UPLOAD_CREATED.bytes,
      content_type: UPLOAD_CREATED.content_type,
      declared_duration_seconds: UPLOAD_CREATED.declared_duration_seconds,
      sha256: sha256Of(filePath),
      title: UPLOAD_CREATED.title,
      retained_until: UPLOAD_CREATED.retained_until,
      quote_with: { uploads: [{ upload_id: UPLOAD_ID }] },
    });
    expect(doc.untrusted).toBe('');
    expect(JSON.stringify(doc.trusted)).not.toContain(path.dirname(filePath));
  });

  it('reports a PUT the bucket refused as upload_failed, retryable, and does not send it twice', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { upload, fail } = harness({
      put: { status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' },
    });

    const error = await fail({ path: filePath });

    expect(error.code).toBe('upload_failed');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('403');
    expect(error.message).toContain('SignatureDoesNotMatch');
    expect(upload.puts).toHaveLength(1);
  });

  it('reports a PUT that never got an answer (a transport rejection) as upload_failed, not internal_error', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { api, upload, fail } = harness({
      put: { reject: new Error('ECONNRESET') },
    });

    const error = await fail({ path: filePath });

    expect(error.code).toBe('upload_failed');
    expect(error.type).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNRESET');
    expect(upload.puts).toHaveLength(1);
    expect(api.callsTo('createUpload')).toHaveLength(1);
  });

  it('refuses a PUT URL that is not a public https origin, without leaking the raw error', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { upload, fail } = harness({
      api: { upload: { ...UPLOAD_CREATED, put_url: 'https://127.0.0.1/uploads/x' } },
    });

    const error = await fail({ path: filePath });

    expect(error).toBeInstanceOf(McpToolError);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('host_not_allowed');
    expect(upload.puts).toEqual([]);
  });
});

describe('upload_audio refuses', () => {
  it("a relative path by the tool's own schema, before any API call", () => {
    const { api } = harness();
    const schema = LOCAL_TOOLS[0]!.inputSchema;

    expect(schema.safeParse({ path: 'relative/audio.mp3' }).success).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('a path that is not a file', async () => {
    const dir = path.dirname(writeWavFixture(SECONDS));
    const { api, fail } = harness();

    const error = await fail({ path: dir });

    expect(error.code).toBe('invalid_request');
    expect(api.calls).toEqual([]);
  });

  it('an empty file', async () => {
    const filePath = path.join(path.dirname(writeWavFixture(SECONDS)), 'empty.wav');
    fs.writeFileSync(filePath, '');
    const { api, fail } = harness();

    const error = await fail({ path: filePath });

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('1 byte');
    expect(api.calls).toEqual([]);
  });

  it("a file over the contract's size limit, naming the limit", async () => {
    const { api, fail } = harness({ inspect: inspectAs({ bytes: MAX_UPLOAD_BYTES + 1 }) });

    const error = await fail({ path: '/tmp/huge.wav' });

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain(String(MAX_UPLOAD_BYTES));
    expect(api.calls).toEqual([]);
  });

  it('a container it does not recognise, naming what it saw and what it takes', async () => {
    const { api, fail } = harness({
      inspect: inspectAs({ contentType: null, container: 'Matroska' }),
    });

    const error = await fail({ path: '/tmp/clip.mkv' });

    expect(error.code).toBe('file_not_supported');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Matroska');
    expect(error.message).toContain('audio/mpeg');
    expect(api.calls).toEqual([]);
  });

  it('a file whose container states no duration, asking for declared_duration_seconds', async () => {
    const { api, fail } = harness({ inspect: inspectAs({ durationSeconds: null }) });

    const error = await fail({ path: '/tmp/clip.wav' });

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('declared_duration_seconds');
    expect(api.calls).toEqual([]);
  });

  it('a container duration past the contract ceiling', async () => {
    const { api, fail } = harness({ inspect: inspectAs({ durationSeconds: 36_001 }) });

    const error = await fail({ path: '/tmp/long.wav' });

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('36000');
    expect(api.calls).toEqual([]);
  });

  it('a call with no upload transport, as the hosted server makes, without asking the API', async () => {
    const filePath = writeWavFixture(SECONDS);
    const { api, fail } = harness({ transport: false });

    const error = await fail({ path: filePath });

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('local server');
    expect(api.calls).toEqual([]);
  });

  it('a call with no credential, before reading anything from disk', async () => {
    const { api, upload, fail } = harness({ credential: null });

    const error = await fail({ path: '/tmp/never-read.wav' });

    expect(error.code).toBe('unauthenticated');
    expect(api.calls).toEqual([]);
    expect(upload.puts).toEqual([]);
  });
});

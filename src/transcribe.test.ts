/**
 * `transcribe`, the one call: what it sends, how it waits, how it hands the
 * transcript back a page at a time, and what it refuses before any request.
 * Driven the way `tools.test.ts` drives the rest — arguments parsed through
 * the tool's own schema, a fake API recording every request — with a fake
 * clock, so a minute of polling runs in a millisecond.
 */
import { describe, expect, it } from 'vitest';
import { createApiClient } from './api-client.js';
import { McpToolError } from './errors.js';
import { TRANSCRIPT_PAGE_CHARS } from './render.js';
import type { ToolContext } from './tools.js';
import {
  HOSTED_WAIT,
  LOCAL_WAIT,
  idempotencyKeyFor,
  transcribeTool,
  waitForJob,
  type LocalSources,
  type WaitPolicy,
} from './transcribe.js';
import { fakeClock, waitContext, type FakeClock } from './testing/clock.js';
import {
  BASE_URL,
  CREDENTIAL,
  EPISODE_ID,
  FEED_URL,
  GROUP_ID,
  JOB_ID,
  READ_ID,
  TOKEN,
  UPLOAD_ID,
  errorEnvelope,
  fakeApi,
  jobAccepted,
  jobStatus,
  nonces,
  segment,
  transcript,
  transcriptRead,
  type FakeApiOptions,
} from './testing/fake-api.js';

const APPLE_URL = 'https://podcasts.apple.com/us/podcast/x/id123?i=456';

function json(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

/** The edge's own throttle refusal, as API Gateway answers it (ADR-0037: one second). */
const throttled = () => ({
  ...json(429, errorEnvelope({ code: 'rate_limited', type: 'rate_limited', retryable: true })),
  headers: { 'retry-after': '1' },
});

const running = (status: 'queued' | 'transcribing' = 'transcribing') =>
  jobStatus({
    status,
    artifact: undefined,
    settled_credits: undefined,
    released_credits: undefined,
  });

function harness(
  options: FakeApiOptions = {},
  config: {
    readonly local?: LocalSources;
    readonly wait?: WaitPolicy;
    readonly clock?: FakeClock;
    readonly progress?: ToolContext['progress'];
  } = {},
) {
  const api = fakeApi(options);
  const clock = config.clock ?? fakeClock();
  const ctx: ToolContext = {
    credential: CREDENTIAL,
    api: createApiClient({ baseUrl: BASE_URL, fetch: api.fetch, sleep: clock.sleep }),
    nonce: nonces('0123456789abcdef'),
    trace: [],
    ...waitContext(clock, config.wait ?? HOSTED_WAIT),
    ...(config.progress === undefined ? {} : { progress: config.progress }),
  };
  const tool = transcribeTool(config.local);
  const run = async (args: unknown) => tool.handler(tool.inputSchema.parse(args), ctx);
  const fail = async (args: unknown): Promise<McpToolError> => {
    try {
      await run(args);
    } catch (error) {
      if (error instanceof McpToolError) return error;
      throw error;
    }
    throw new Error('transcribe did not fail');
  };
  return { api, clock, ctx, tool, run, fail };
}

describe('transcribe: a fresh episode', () => {
  it('submits once, waits on the job, and hands back the first page when it completes', async () => {
    const { api, run } = harness({
      transcripts: { [JOB_ID]: [running('queued'), jobStatus()] },
    });

    const doc = await run({ url: APPLE_URL });

    const [submit] = api.callsTo('createTranscript');
    expect(submit).toMatchObject({ method: 'POST', path: '/v1/transcripts' });
    expect(submit!.body).toEqual({ url: APPLE_URL, dry_run: false });
    expect(submit!.headers['idempotency-key']).toMatch(/^mcp-transcribe-[a-f0-9]{40}$/);
    expect(submit!.headers.authorization).toBe(CREDENTIAL);
    expect(api.callsTo('getTranscriptJob')).toHaveLength(2);
    expect(doc.trusted).toMatchObject({
      source: { kind: 'url' },
      group_id: GROUP_ID,
      job_id: JOB_ID,
      status: 'completed',
      transcript: { delivery: 'page', page: { page_start: 0, complete: true } },
    });
    expect(doc.untrusted).toContain('Today we are talking about credits.');
  });

  it('answers with the job and how to keep waiting when the hosted ceiling comes first', async () => {
    const { api, clock, run } = harness({ transcripts: { [JOB_ID]: running('queued') } });

    const doc = await run({ url: APPLE_URL, wait_seconds: 900 });

    expect(doc.trusted).toMatchObject({
      job_id: JOB_ID,
      status: 'queued',
      transcript: {
        delivery: 'not_yet',
        wait_with: { tool: 'read_transcript', arguments: { job_id: JOB_ID } },
      },
    });
    // 900 asked; the hosted policy grants its 20, looked at every 10 s: two
    // requests on the account's plan, not seven (ADR-0037).
    expect(clock.slept.every((ms) => ms === HOSTED_WAIT.pollIntervalMs)).toBe(true);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      HOSTED_WAIT.maxSeconds * 1000,
    );
    expect(api.callsTo('getTranscriptJob').length).toBe(clock.slept.length);
  });

  it('ends the wait with the last status when a look is throttled, instead of failing', async () => {
    // The job was accepted and holds its reservation. A throttled look says
    // nothing about the job, so the call answers what it knows and how to
    // keep waiting, rather than an error a model would read as "it failed".
    const { api, run } = harness({
      transcripts: { [JOB_ID]: [running(), throttled(), throttled()] },
    });
    const doc = await run({ url: APPLE_URL });
    expect(doc.trusted).toMatchObject({
      job_id: JOB_ID,
      status: 'transcribing',
      transcript: { delivery: 'not_yet', wait_with: { tool: 'read_transcript' } },
    });
    // One look, one throttled look, and the client's one quiet retry of it.
    expect(api.callsTo('getTranscriptJob')).toHaveLength(3);
  });

  it('answers the accepted job when even the first look is throttled', async () => {
    const { run } = harness({ transcripts: { [JOB_ID]: throttled() } });
    const doc = await run({ url: APPLE_URL });
    expect(doc.trusted).toMatchObject({
      job_id: JOB_ID,
      status: 'queued',
      transcript: { delivery: 'not_yet' },
    });
  });

  it('still fails on a look the API refuses for good', async () => {
    const gone = json(
      404,
      errorEnvelope({ code: 'job_not_found', type: 'not_found', message: 'no such job' }),
    );
    const { fail } = harness({ transcripts: { [JOB_ID]: [running(), gone] } });
    expect(await fail({ url: APPLE_URL })).toMatchObject({ code: 'job_not_found' });
  });

  it('with wait_seconds 0, answers the accepted job without polling', async () => {
    const { api, run } = harness({ transcripts: { [JOB_ID]: running('queued') } });
    const doc = await run({ url: APPLE_URL, wait_seconds: 0 });
    expect(doc.trusted).toMatchObject({ job_id: JOB_ID, transcript: { delivery: 'not_yet' } });
    expect(api.callsTo('getTranscriptJob')).toHaveLength(1);
  });

  it('reports a job that failed with its error, and no transcript', async () => {
    const failed = jobStatus({
      status: 'failed',
      artifact: undefined,
      settled_credits: undefined,
      released_credits: 150,
      reservation_released: true,
      error: {
        type: 'unavailable',
        code: 'processing_failed',
        message: 'The feed stopped serving the episode.',
        doc_url: 'https://docs.audivo.dev/errors#processing_failed',
        request_id: 'req_0123456789abcdef',
        retryable: false,
      },
    });
    const { run } = harness({ transcripts: { [JOB_ID]: [running(), failed] } });
    const doc = await run({ url: APPLE_URL });
    expect(doc.trusted).toMatchObject({
      status: 'failed',
      reservation_released: true,
      transcript: { delivery: 'none' },
    });
    // The failure's own message is publisher-adjacent: fenced, never trusted.
    expect(doc.untrusted).toContain('The feed stopped serving the episode.');
    expect(JSON.stringify(doc.trusted)).not.toContain('stopped serving');
  });

  it('resubmits once under a fresh key when the same call replays a job that already failed', async () => {
    const replayedFailure = json(202, jobAccepted({ status: 'failed' }));
    let submits = 0;
    const api = fakeApi({
      transcripts: { [JOB_ID]: jobStatus() },
      answers: {},
    });
    const fetch: typeof api.fetch = async (url, init) => {
      if (init.method === 'POST' && url.endsWith('/v1/transcripts')) {
        submits += 1;
        const response = submits === 1 ? replayedFailure : json(202, jobAccepted());
        return {
          status: response.status,
          headers: { get: () => 'application/json' },
          text: async () => response.body,
        };
      }
      return api.fetch(url, init);
    };
    const clock = fakeClock();
    const ctx: ToolContext = {
      credential: CREDENTIAL,
      api: createApiClient({ baseUrl: BASE_URL, fetch }),
      nonce: nonces('0123456789abcdef'),
      trace: [],
      ...waitContext(clock),
    };
    const tool = transcribeTool();
    const doc = await tool.handler(tool.inputSchema.parse({ url: APPLE_URL }), ctx);
    expect(submits).toBe(2);
    expect(doc.trusted).toMatchObject({ status: 'completed' });
  });
});

describe('transcribe: an episode already transcribed', () => {
  it('hands back the transcript at once, and names the free repeat that reads the next page', async () => {
    const long = transcript({
      segments: Array.from({ length: 1500 }, (_unused, i) =>
        segment(i, i * 5, `Sentence ${i} of a long episode, spoken at an ordinary pace.`),
      ),
    });
    const { api, run } = harness({
      created: json(200, transcriptRead({ credits_charged: 8, transcript: long })),
    });

    const doc = await run({ episode_id: EPISODE_ID, max_credits: 20 });

    expect(api.callsTo('getTranscriptJob')).toEqual([]);
    type View = {
      page: { chars: number; complete: boolean };
      next_page: { tool: string; arguments: Record<string, unknown> };
    };
    const view = doc.trusted.transcript as View;
    expect(doc.trusted).toMatchObject({ is_cached: true, credits_charged: 8 });
    expect(view.page).toMatchObject({ complete: false });
    expect(view.page.chars).toBeLessThanOrEqual(TRANSCRIPT_PAGE_CHARS);
    // The rest is read through the receipt it was charged under (0.15.0):
    // read_transcript, which spends nothing, rather than a replay of this.
    expect(doc.trusted.read_id).toBe(READ_ID);
    expect(view.next_page).toEqual({
      tool: 'read_transcript',
      arguments: { read_id: READ_ID, page_start: expect.any(Number) },
    });

    // An API that names no receipt (before 0.15.0) still pages: the same
    // call, turned to the next page, under the same idempotency key, which
    // the API answers as a replay.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
    const { read_id: _dropped, ...unnamed } = transcriptRead({
      credits_charged: 8,
      transcript: long,
    });
    const older = harness({ created: json(200, unnamed) });
    const first = await older.run({ episode_id: EPISODE_ID, max_credits: 20 });
    const olderView = first.trusted.transcript as View;
    expect(olderView.next_page.tool).toBe('transcribe');
    expect(olderView.next_page.arguments).toMatchObject({
      episode_id: EPISODE_ID,
      max_credits: 20,
    });
    const again = await older.run(olderView.next_page.arguments);
    const keys = older.api
      .callsTo('createTranscript')
      .map((call) => call.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(again.trusted.transcript).toMatchObject({
      page: { page_start: olderView.next_page.arguments.page_start },
    });
  });
});

describe('transcribe: what it sends', () => {
  it('derives one key from one request, whatever order its fields came in', () => {
    const a = idempotencyKeyFor({ url: APPLE_URL, max_credits: 40, dry_run: false });
    const b = idempotencyKeyFor({ dry_run: false, max_credits: 40, url: APPLE_URL });
    const c = idempotencyKeyFor({ url: APPLE_URL, max_credits: 41, dry_run: false });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('sends each input shape as the contract spells it, with the cap', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ url: APPLE_URL }, { url: APPLE_URL, dry_run: false }],
      [
        { feed_url: FEED_URL, guid: 'g-1', max_credits: 5 },
        { feed_url: FEED_URL, guid: 'g-1', max_credits: 5, dry_run: false },
      ],
      [{ episode_id: EPISODE_ID }, { episode_id: EPISODE_ID, dry_run: false }],
      // An episode as list_episodes listed it, with the feed and Apple id
      // that listing took: how one nobody has transcribed yet is found.
      [
        { episode_id: EPISODE_ID, feed_url: FEED_URL, itunes_id: 1502871393 },
        { episode_id: EPISODE_ID, feed_url: FEED_URL, itunes_id: 1502871393, dry_run: false },
      ],
      [
        { episode_id: EPISODE_ID, feed_url: FEED_URL },
        { episode_id: EPISODE_ID, feed_url: FEED_URL, itunes_id: null, dry_run: false },
      ],
      [{ upload_id: UPLOAD_ID }, { upload_id: UPLOAD_ID, dry_run: false }],
    ];
    for (const [args, body] of cases) {
      const { api, run } = harness({ transcripts: { [JOB_ID]: jobStatus() } });
      await run(args);
      expect(api.callsTo('createTranscript')[0]!.body).toEqual(body);
    }
  });

  it('refuses no pointer, two pointers, and half a feed pair before any request', async () => {
    for (const args of [
      {},
      { url: APPLE_URL, episode_id: EPISODE_ID },
      { feed_url: FEED_URL },
      { guid: 'g-1' },
      { episode_id: EPISODE_ID, guid: 'g-1' },
      { episode_id: EPISODE_ID, itunes_id: 7 },
      { feed_url: FEED_URL, guid: 'g-1', itunes_id: 7 },
    ]) {
      const { api, fail } = harness();
      const error = await fail(args);
      expect(error.code, JSON.stringify(args)).toBe('invalid_request');
      expect(api.calls).toEqual([]);
    }
  });

  it('refuses a YouTube link on the hosted server with the way to the local one', async () => {
    for (const url of [
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://youtu.be/jNQXAC9IVRw',
    ]) {
      const { api, fail } = harness();
      const error = await fail({ url });
      expect(error.code).toBe('invalid_request');
      expect(error.message).toContain('npx -y @audivo/mcp');
      expect(api.calls).toEqual([]);
    }
  });

  it("relays the API's refusal of a cap, typed, with the figure it named", async () => {
    const { fail } = harness({
      created: json(
        422,
        errorEnvelope({
          code: 'max_credits_exceeded',
          type: 'unprocessable_input',
          message: 'this request can take up to 150 credits and max_credits is 40',
        }),
      ),
    });
    const error = await fail({ url: APPLE_URL, max_credits: 40 });
    expect(error).toMatchObject({ code: 'max_credits_exceeded', origin: 'api', status: 422 });
    expect(error.message).toContain('150');
  });

  it('never carries the key in what it answers', async () => {
    const { run } = harness({ transcripts: { [JOB_ID]: jobStatus() } });
    const doc = await run({ url: APPLE_URL });
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
  });
});

describe('transcribe: local sources', () => {
  function sources(record: string[]): LocalSources {
    return {
      uploadFile: async (_call, _ctx, path) => {
        record.push(`file:${path}`);
        return { uploadId: UPLOAD_ID, title: 'recording' };
      },
      uploadYoutube: async (_call, _ctx, videoId) => {
        record.push(`youtube:${videoId}`);
        return { uploadId: UPLOAD_ID, title: 'Me at the zoo' };
      },
    };
  }

  it('uploads a YouTube video and transcribes it as an upload, naming the upload for later pages', async () => {
    const record: string[] = [];
    const { api, run } = harness(
      { transcripts: { [JOB_ID]: jobStatus() } },
      { local: sources(record), wait: LOCAL_WAIT },
    );
    const doc = await run({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=42' });
    expect(record).toEqual(['youtube:jNQXAC9IVRw']);
    expect(api.callsTo('createTranscript')[0]!.body).toEqual({
      upload_id: UPLOAD_ID,
      dry_run: false,
    });
    expect(doc.trusted).toMatchObject({
      source: { kind: 'youtube', video_id: 'jNQXAC9IVRw', upload_id: UPLOAD_ID },
    });
  });

  it('uploads a file by path and transcribes it', async () => {
    const record: string[] = [];
    const { api, run } = harness(
      { transcripts: { [JOB_ID]: jobStatus() } },
      { local: sources(record), wait: LOCAL_WAIT },
    );
    await run({ path: '/tmp/interview.m4a' });
    expect(record).toEqual(['file:/tmp/interview.m4a']);
    expect(api.callsTo('createTranscript')[0]!.body).toMatchObject({ upload_id: UPLOAD_ID });
  });

  it('only the local schema takes a path', () => {
    const hosted = transcribeTool();
    const local = transcribeTool(sources([]));
    expect(Object.keys(hosted.inputSchema.shape)).not.toContain('path');
    expect(Object.keys(local.inputSchema.shape)).toContain('path');
    expect(() => local.inputSchema.parse({ path: 'relative/file.mp3' })).toThrow();
  });
});

describe('waitForJob', () => {
  it('reports progress while it waits, where the client asked for it', async () => {
    const reports: string[] = [];
    const { api, ctx } = harness(
      { transcripts: { [JOB_ID]: [running(), running(), jobStatus()] } },
      {
        wait: LOCAL_WAIT,
        progress: async (_progress, _total, message) => {
          reports.push(message);
        },
      },
    );
    const call = { credential: CREDENTIAL, trace: [] };
    const initial = await ctx.api.getTranscriptJob(call, JOB_ID);
    const done = await waitForJob(call, ctx, JOB_ID, {
      waitSeconds: 60,
      startedAt: ctx.now(),
      initial,
    });
    expect(done && 'status' in done ? done.status : undefined).toBe('completed');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toContain('transcribing');
    expect(api.callsTo('getTranscriptJob')).toHaveLength(3);
  });

  it('stops when the call is cancelled', async () => {
    const controller = new AbortController();
    const { ctx } = harness({ transcripts: { [JOB_ID]: running() } }, { wait: LOCAL_WAIT });
    const call = { credential: CREDENTIAL, trace: [] };
    controller.abort();
    const latest = await waitForJob(call, { ...ctx, signal: controller.signal }, JOB_ID, {
      waitSeconds: 900,
      startedAt: ctx.now(),
      initial: running(),
    });
    expect(latest && 'status' in latest ? latest.status : undefined).toBe('transcribing');
  });
});

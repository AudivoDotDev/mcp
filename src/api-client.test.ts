/**
 * The client's one quiet retry: an edge throttle with a short `Retry-After`
 * is waited out once, here, and anything else is relayed as it came. A fake
 * clock, so a second's wait runs in a millisecond and is counted.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_RETRY_MAX_SECONDS, createApiClient, type ApiCall } from './api-client.js';
import { McpToolError } from './errors.js';
import { fakeClock } from './testing/clock.js';
import {
  BASE_URL,
  CREDENTIAL,
  JOB_ID,
  errorEnvelope,
  fakeApi,
  jobStatus,
  type FakeApiOptions,
  type FakeResponse,
} from './testing/fake-api.js';

function refusal(
  code: 'rate_limited' | 'concurrency_limited',
  retryAfter: string | null,
): FakeResponse {
  return {
    status: 429,
    // Both codes carry the contract's `rate_limited` type; only the code differs.
    body: JSON.stringify(errorEnvelope({ code, type: 'rate_limited', retryable: true })),
    ...(retryAfter === null ? {} : { headers: { 'retry-after': retryAfter } }),
  };
}

function setup(options: FakeApiOptions) {
  const api = fakeApi(options);
  const clock = fakeClock();
  const client = createApiClient({ baseUrl: BASE_URL, fetch: api.fetch, sleep: clock.sleep });
  const call = (): ApiCall => ({ credential: CREDENTIAL, trace: [] });
  return { api, clock, client, call };
}

async function failure(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpToolError) return error;
    throw error;
  }
  throw new Error('the call did not fail');
}

describe('a throttled request', () => {
  it('is waited out once, for as long as Retry-After says, and then answered', async () => {
    const { api, clock, client, call } = setup({
      transcripts: { [JOB_ID]: [refusal('rate_limited', '1'), jobStatus()] },
    });
    const body = await client.getTranscriptJob(call(), JOB_ID);
    expect(body).toMatchObject({ job_id: JOB_ID, status: 'completed' });
    expect(api.callsTo('getTranscriptJob')).toHaveLength(2);
    expect(clock.slept).toEqual([1000]);
  });

  it('is retried only once; a second refusal is relayed with its wait', async () => {
    const { api, client, call } = setup({
      transcripts: { [JOB_ID]: [refusal('rate_limited', '1'), refusal('rate_limited', '1')] },
    });
    const error = await failure(client.getTranscriptJob(call(), JOB_ID));
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: 1 });
    expect(api.callsTo('getTranscriptJob')).toHaveLength(2);
  });

  it('is relayed at once when the wait is longer than the client takes on itself', async () => {
    const wait = String(AUTO_RETRY_MAX_SECONDS + 1);
    const { api, clock, client, call } = setup({
      answers: { searchShows: refusal('rate_limited', wait) },
    });
    const error = await failure(client.searchShows(call(), { q: 'x' }));
    expect(error.retryAfterSeconds).toBe(AUTO_RETRY_MAX_SECONDS + 1);
    expect(api.callsTo('searchShows')).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });

  it('is relayed at once when the API named no wait', async () => {
    const { api, client, call } = setup({
      answers: { searchShows: refusal('rate_limited', null) },
    });
    await failure(client.searchShows(call(), { q: 'x' }));
    expect(api.callsTo('searchShows')).toHaveLength(1);
  });

  it('is never retried for the open-job cap, which the operation answers and time does not clear', async () => {
    const { api, client, call } = setup({
      answers: { searchShows: refusal('concurrency_limited', '1') },
    });
    const error = await failure(client.searchShows(call(), { q: 'x' }));
    expect(error.code).toBe('concurrency_limited');
    expect(api.callsTo('searchShows')).toHaveLength(1);
  });
});

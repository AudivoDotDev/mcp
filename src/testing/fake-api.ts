/**
 * The API as the suites see it: an `ApiFetch` over fixtures typed by the
 * contract, recording every request it is handed. No SDK is mocked and no
 * network is touched; the seam is the one production crosses.
 *
 * Every fixture is declared as its `components['schemas']` type, so a
 * contract change that renames a field stops this file compiling, and
 * `contract.test.ts` validates the same fixtures against the bundled spec
 * with ajv, so a fixture that is well-typed but out of bounds fails there.
 *
 * Test support only: excluded from the package build.
 */
import type { components } from '../contract/types.js';
import type { ApiFetch, ApiFetchInit, ApiFetchResponse, ApiOperation } from '../api-client.js';
import type { PutHeaders, UploadTransport } from '../upload.js';

type Schemas = components['schemas'];

export const BASE_URL = 'https://api.hark.test/staging';
export const TOKEN = `hk_live_${'a1b2c3d4'.repeat(4)}`;
export const CREDENTIAL = `Bearer ${TOKEN}`;
export const OTHER_TOKEN = `hk_live_${'f9e8d7c6'.repeat(4)}`;
export const OTHER_CREDENTIAL = `Bearer ${OTHER_TOKEN}`;

export const QUOTE_ID = 'qte_0123456789abcdef';
export const GROUP_ID = 'grp_0123456789abcdef';
export const JOB_ID = 'job_0123456789abcdef';
export const JOB_ID_2 = 'job_fedcba9876543210';
export const JOB_ID_3 = 'job_00000000000000ff';
export const READ_ID = 'job_cached00000000aa';
export const SHOW_ID = 'sh_abcdefghijklmnop';
export const SHOW_ID_2 = 'sh_ponmlkjihgfedcba';
export const EPISODE_ID = 'ep_abcdefghijklmnop';
export const EPISODE_ID_2 = 'ep_ponmlkjihgfedcba';
export const FEED_URL = 'https://feeds.example.com/the-daily.rss';
export const FEED_URL_2 = 'https://feeds.example.com/hard-fork.rss';
export const REQUEST_ID = 'req_7f3a9c2b1d4e4f5a8b6c0d1e2f3a4b5c';
export const UPLOAD_ID = 'upl_0123456789abcdef01234567';
export const NOW = '2026-09-08T09:00:00.000Z';
export const LATER = '2026-09-08T09:30:00.000Z';
/** What the API hands back for an oversized artifact — and what must never reach a model. */
export const PRESIGNED_URL =
  'https://hark-transcripts-staging.s3.eu-west-1.amazonaws.com/transcripts/abc.json.gz?X-Amz-Signature=deadbeef&X-Amz-Expires=86400';
/** Presigned PUT for an announced upload; shaped like the real bucket, in the test account. */
export const PRESIGNED_PUT_URL = `https://hark-uploads-test.s3.us-east-1.amazonaws.com/acct_1/${UPLOAD_ID}?X-Amz-Signature=deadbeef`;

export function showSummary(
  overrides: Partial<Schemas['ShowSummary']> = {},
): Schemas['ShowSummary'] {
  return {
    show_id: SHOW_ID,
    title: 'The Daily',
    feed_url: FEED_URL,
    itunes_id: 1200361736,
    author: 'The New York Times',
    categories: ['News', 'Daily News'],
    artwork_url: 'https://images.example.com/the-daily.jpg',
    music_led: false,
    music_led_basis: 'no music category is on the show',
    ...overrides,
  };
}

export const SEARCH: Schemas['ShowSearchResponse'] = {
  data: [
    showSummary(),
    showSummary({
      show_id: SHOW_ID_2,
      title: 'Hard Fork',
      feed_url: FEED_URL_2,
      itunes_id: null,
      author: null,
      categories: ['Technology'],
      artwork_url: null,
    }),
  ],
  excluded: [
    {
      title: 'A show with no feed',
      reason: 'no_feed_url',
      detail: 'the discovery provider carried no feed URL for this show, so it cannot be selected',
    },
  ],
  next_cursor: null,
};

export function episodeSummary(
  overrides: Partial<Schemas['EpisodeSummary']> = {},
): Schemas['EpisodeSummary'] {
  return {
    episode_id: EPISODE_ID,
    show_id: SHOW_ID,
    guid: 'the-daily-2026-09-08',
    title: 'The Daily: Monday, September 8',
    published_at: NOW,
    duration_sec: 1740,
    publisher_transcript_available: false,
    // Always `null` on a listing: the surface probes no audio (contract).
    is_cached: null,
    estimated_credits: 29,
    ...overrides,
  };
}

export const EPISODES: Schemas['EpisodesListResponse'] = {
  data: [
    episodeSummary(),
    episodeSummary({
      episode_id: EPISODE_ID_2,
      guid: 'the-daily-2026-09-05',
      title: 'The Daily: Friday, September 5',
      published_at: '2026-09-05T09:00:00.000Z',
      duration_sec: null,
      publisher_transcript_available: true,
      estimated_credits: null,
    }),
  ],
  next_cursor: 'eyJvZmZzZXQiOjJ9',
};

export const CHART: Schemas['ChartResponse'] = {
  category: 'News',
  language: 'en',
  size: { requested: 25, allowed: 10, limit: 10, clamped: true },
  data: [showSummary()],
  excluded: [],
};

export const QUOTE: Schemas['QuoteResponse'] = {
  quote_id: QUOTE_ID,
  source: 'shows',
  episodes_per_show: 1,
  entries: [
    {
      episode_id: EPISODE_ID,
      show_id: SHOW_ID,
      feed_url: FEED_URL,
      guid: 'the-daily-0',
      show_title: 'The Daily',
      episode_title: 'Monday',
      published_at: '2026-09-07T06:00:00.000Z',
      is_cached: false,
      estimated_credits: 120,
      quote_ceiling_credits: 132,
      quote_basis: 'feed_metadata',
      declared_duration_seconds: 3600,
    },
    {
      episode_id: EPISODE_ID_2,
      show_id: SHOW_ID_2,
      feed_url: FEED_URL_2,
      guid: 'hard-fork-0',
      show_title: 'Hard Fork',
      episode_title: null,
      published_at: null,
      is_cached: true,
      estimated_credits: 18,
      quote_ceiling_credits: 18,
      quote_basis: 'feed_metadata',
      declared_duration_seconds: 2400,
    },
  ],
  excluded: [
    {
      feed_url: 'https://feeds.example.com/music.rss',
      guid: null,
      title: 'Lo-fi Beats',
      reason: 'music_led',
      detail: 'the show is categorized Music; pass include_music_led to keep it',
    },
  ],
  clamps: [
    {
      dimension: 'episodes_per_show',
      requested: 5,
      allowed: 1,
      limit: 1,
      clamped: true,
      detail: 'the free tier prices one episode per show',
    },
  ],
  cached_members: 1,
  uncached_members: 1,
  total_ceiling_credits: 150,
  remaining_open_jobs: 4,
  balance_credits: 900,
  reserved_credits: 0,
  expires_at: LATER,
  created_at: NOW,
};

export const UPLOAD_CREATED: Schemas['UploadCreated'] = {
  upload_id: UPLOAD_ID,
  put_url: PRESIGNED_PUT_URL,
  put_headers: {
    'content-type': 'audio/mpeg',
    'content-length': '4500000',
    'x-amz-checksum-sha256': 'P4qcKx1OnywdTp88HU6fLD+KnCsdTp8sHU6fLB1Onyw=',
  },
  put_url_expires_at: '2026-09-08T10:00:00.000Z',
  retained_until: '2026-09-15T09:00:00.000Z',
  bytes: 4_500_000,
  content_type: 'audio/mpeg',
  declared_duration_seconds: 1800,
  title: 'A test upload',
};

export const GROUP: Schemas['JobGroupResponse'] = {
  group_id: GROUP_ID,
  status: 'complete',
  quote_id: QUOTE_ID,
  member_count: 3,
  members: [
    {
      kind: 'job',
      job_id: JOB_ID,
      episode_id: EPISODE_ID,
      status: 'completed',
      estimated_credits: 120,
      reserved_credits: 132,
      settled_credits: 118,
      released_credits: 14,
      created_at: NOW,
    },
    {
      kind: 'job',
      job_id: JOB_ID_2,
      episode_id: EPISODE_ID_2,
      status: 'queued',
      estimated_credits: 60,
      reserved_credits: 66,
      created_at: NOW,
    },
    {
      kind: 'cached_read',
      read_id: READ_ID,
      episode_id: EPISODE_ID_2,
      credits_charged: 18,
      created_at: NOW,
    },
  ],
  member_counts: {
    validating: 0,
    queued: 1,
    downloading: 0,
    transcribing: 0,
    merging: 0,
    completed: 1,
    failed: 0,
    cancelled: 0,
    cached_read: 1,
  },
  credits_reserved: 66,
  credits_settled: 136,
  credits_released: 14,
  created_at: NOW,
  completion_deadline: LATER,
  completed_at: NOW,
  abandoned_at: null,
};

export const GROUPS: Schemas['JobGroupsListResponse'] = {
  data: [
    {
      group_id: GROUP_ID,
      status: 'complete',
      quote_id: QUOTE_ID,
      member_count: 3,
      created_at: NOW,
      completed_at: NOW,
      abandoned_at: null,
    },
  ],
  next_cursor: null,
};

export function segment(id: number, start: number, text: string): Schemas['TranscriptSegment'] {
  return { id, start, end: start + 5, speaker: null, text };
}

export function transcript(
  overrides: Partial<Schemas['CanonicalTranscript']> = {},
): Schemas['CanonicalTranscript'] {
  return {
    episode_id: EPISODE_ID,
    show_id: SHOW_ID,
    language: 'en',
    duration_sec: 61,
    source: 'whisper-large-v3-turbo',
    source_revision: `sha256:${'a'.repeat(64)}`,
    model_version: 'v3-turbo-2026-08',
    pipeline_version: '2026.09-vad4-merge2',
    timing_precision: 'segment',
    diarized: false,
    warnings: [],
    segments: [
      segment(0, 0, 'Welcome back to the show.'),
      segment(1, 5, 'Today we are talking about credits.'),
      segment(2, 10, 'Stay with us.'),
    ],
    created_at: NOW,
    ...overrides,
  };
}

export function jobStatus(overrides: Partial<Schemas['JobStatus']> = {}): Schemas['JobStatus'] {
  return {
    job_id: JOB_ID,
    status: 'completed',
    episode_id: EPISODE_ID,
    estimated_credits: 120,
    reserved_credits: 132,
    settled_credits: 118,
    released_credits: 14,
    ledger_event_ids: ['evt_0123456789abcdef'],
    artifact: { format: 'json', transcript: transcript() },
    created_at: NOW,
    started_at: NOW,
    completed_at: LATER,
    ...overrides,
  };
}

/** `GET /v1/reads/{read_id}` on a settled read: the transcript, and no charge. */
export function transcriptRead(
  overrides: Partial<Schemas['TranscriptRead']> = {},
): Schemas['TranscriptRead'] {
  return {
    format: 'json',
    is_cached: true,
    credits_charged: 0,
    transcript: transcript({ episode_id: EPISODE_ID_2 }),
    ...overrides,
  };
}

export function errorEnvelope(
  detail: Partial<Schemas['ErrorDetail']> & Pick<Schemas['ErrorDetail'], 'code' | 'type'>,
): Schemas['Error'] {
  return {
    error: {
      message: 'the API refused this request',
      doc_url: `https://docs.audivo.dev/errors#${detail.code}`,
      request_id: REQUEST_ID,
      retryable: false,
      ...detail,
    } as Schemas['ErrorDetail'],
  };
}

/** Deterministic fence nonces, in sequence, so a suite can predict the markers. */
export function nonces(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

export type RecordedCall = {
  readonly operation: ApiOperation | 'unknown';
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

export type FakeResponse = { readonly status: number; readonly body: string };

export type FakeApiOptions = {
  readonly search?: Schemas['ShowSearchResponse'];
  readonly chart?: Schemas['ChartResponse'];
  readonly episodes?: Schemas['EpisodesListResponse'];
  readonly quote?: Schemas['QuoteResponse'];
  readonly upload?: Schemas['UploadCreated'];
  readonly group?: Schemas['JobGroupResponse'];
  readonly groups?: Schemas['JobGroupsListResponse'];
  /** By job id; a job not named here is `404 job_not_found`. */
  readonly transcripts?: Readonly<
    Record<string, Schemas['JobStatus'] | Schemas['TranscriptUrlRef'] | FakeResponse>
  >;
  /** By read id, for `GET /v1/reads/{read_id}`; an unnamed read is the same 404. */
  readonly reads?: Readonly<
    Record<string, Schemas['TranscriptRead'] | Schemas['TranscriptUrlRef'] | FakeResponse>
  >;
  /** A canned answer for one operation, whatever the fixtures say. */
  readonly answers?: Partial<Readonly<Record<ApiOperation, FakeResponse>>>;
  /** Thrown by the transport itself, before any response. */
  readonly throws?: Error;
  /** Milliseconds each transcript read takes; for asserting the fan-out width. */
  readonly transcriptDelayMs?: number;
};

export type FakeApi = {
  readonly fetch: ApiFetch;
  readonly calls: RecordedCall[];
  callsTo(operation: ApiOperation): RecordedCall[];
  /** The most transcript reads ever in flight at once. */
  readonly peakInFlight: () => number;
};

type Route = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly operation: ApiOperation;
};

const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/v1\/search\/shows$/, operation: 'searchShows' },
  { method: 'GET', pattern: /^\/v1\/charts$/, operation: 'getChart' },
  { method: 'GET', pattern: /^\/v1\/shows\/([^/]+)\/episodes$/, operation: 'listShowEpisodes' },
  { method: 'POST', pattern: /^\/v1\/quotes$/, operation: 'createQuote' },
  { method: 'POST', pattern: /^\/v1\/uploads$/, operation: 'createUpload' },
  { method: 'POST', pattern: /^\/v1\/quotes\/([^/]+)\/confirm$/, operation: 'confirmQuote' },
  { method: 'GET', pattern: /^\/v1\/groups$/, operation: 'listGroups' },
  { method: 'GET', pattern: /^\/v1\/groups\/([^/]+)$/, operation: 'getGroup' },
  { method: 'POST', pattern: /^\/v1\/groups\/([^/]+)\/cancel$/, operation: 'cancelGroup' },
  { method: 'GET', pattern: /^\/v1\/transcripts\/([^/]+)$/, operation: 'getTranscriptJob' },
  { method: 'GET', pattern: /^\/v1\/reads\/([^/]+)$/, operation: 'getTranscriptRead' },
];

function json(status: number, body: unknown): FakeResponse {
  return { status, body: JSON.stringify(body) };
}

function isFakeResponse(value: unknown): value is FakeResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FakeResponse).status === 'number' &&
    typeof (value as FakeResponse).body === 'string'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RecordedPut = {
  readonly url: string;
  readonly headers: PutHeaders;
  readonly path: string;
};

export type FakeUploadTransport = UploadTransport & { readonly puts: RecordedPut[] };

/**
 * The presigned PUT as the suites see it: every call recorded, one canned
 * answer for all of them. Nothing is written and no socket is opened, so a
 * test asserts the URL, the headers and the file the tool chose rather than
 * what S3 would have made of them.
 */
export function fakeUploadTransport(
  answer: FakeResponse = { status: 200, body: '' },
): FakeUploadTransport {
  const puts: RecordedPut[] = [];
  return {
    puts,
    put: async (url, headers, path) => {
      puts.push({ url, headers, path });
      return answer;
    },
  };
}

export function fakeApi(options: FakeApiOptions = {}): FakeApi {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let peak = 0;

  async function answer(call: RecordedCall, pathParam: string | undefined): Promise<FakeResponse> {
    if (call.operation === 'unknown') {
      return { status: 404, body: '<html>not a contract path</html>' };
    }
    const canned = options.answers?.[call.operation];
    if (canned !== undefined) return canned;
    switch (call.operation) {
      case 'searchShows':
        return json(200, options.search ?? SEARCH);
      case 'getChart':
        return json(200, options.chart ?? CHART);
      case 'listShowEpisodes':
        return json(200, options.episodes ?? EPISODES);
      case 'createQuote':
        return json(200, options.quote ?? QUOTE);
      case 'createUpload':
        return json(201, options.upload ?? UPLOAD_CREATED);
      case 'confirmQuote': {
        // The API's own half of the spending fence: a stated total
        // that disagrees with the quote's is refused, as the real one does.
        const stated = (call.body as { expected_total_credits?: number } | undefined)
          ?.expected_total_credits;
        const total = (options.quote ?? QUOTE).total_ceiling_credits;
        if (stated !== undefined && stated !== total) {
          return json(
            409,
            errorEnvelope({
              code: 'expected_total_mismatch',
              type: 'conflict',
              message: `expected_total_credits (${stated}) disagrees with the quote's total_ceiling_credits (${total})`,
            }),
          );
        }
        return json(200, options.group ?? GROUP);
      }
      case 'getGroup':
      case 'cancelGroup':
        return json(200, options.group ?? GROUP);
      case 'listGroups':
        return json(200, options.groups ?? GROUPS);
      case 'getTranscriptJob':
      case 'getTranscriptRead': {
        const id = pathParam ?? '';
        const fixture =
          call.operation === 'getTranscriptJob' ? options.transcripts?.[id] : options.reads?.[id];
        if (fixture === undefined) {
          return json(
            404,
            errorEnvelope({ code: 'job_not_found', type: 'not_found', message: 'no such job' }),
          );
        }
        if (options.transcriptDelayMs !== undefined) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(options.transcriptDelayMs);
          inFlight -= 1;
        }
        return isFakeResponse(fixture) ? fixture : json(200, fixture);
      }
    }
  }

  const fetch: ApiFetch = async (url: string, init: ApiFetchInit): Promise<ApiFetchResponse> => {
    if (options.throws !== undefined) throw options.throws;
    const parsed = new URL(url);
    const prefix = new URL(BASE_URL).pathname;
    const path = parsed.pathname.startsWith(prefix)
      ? parsed.pathname.slice(prefix.length)
      : parsed.pathname;
    const route = ROUTES.find((r) => r.method === init.method && r.pattern.test(path));
    const match = route === undefined ? null : route.pattern.exec(path);
    const call: RecordedCall = {
      operation: route?.operation ?? 'unknown',
      method: init.method,
      url,
      path,
      query: parsed.searchParams,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    const pathParam = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    const response = await answer(call, pathParam);
    return {
      status: response.status,
      headers: {
        get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => response.body,
    };
  };

  return {
    fetch,
    calls,
    callsTo: (operation) => calls.filter((call) => call.operation === operation),
    peakInFlight: () => peak,
  };
}

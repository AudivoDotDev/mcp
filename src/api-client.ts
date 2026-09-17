/**
 * The one way this server reaches the API: ten operations, each typed by
 * the contract (`contract/types.ts`) and each carrying the caller's
 * own credential for that one call.
 *
 * The client holds the base URL and a transport, and nothing else. A
 * credential is an argument to every call, never a field: there is no way to
 * construct a client "as" an account, so a warm container serving a second
 * caller has nothing of the first to leak. What each call returns is the
 * operation's `200` body, parsed and nothing more; what it throws is always a
 * `McpToolError` (`errors.ts`), never a body or a transport exception.
 *
 * ## Why the transport is a plain `fetch`
 *
 * The destination is fixed, first-party and operator-configured, never
 * derived from anything a caller sends. `lambda.ts` and `cli.ts` check the
 * base URL with `assertApiBaseUrl` before a connection can be opened, the
 * transport is a pinned undici `fetch`, and nothing here is exposed as a
 * general-purpose HTTP helper.
 */
import type { components, operations, paths } from './contract/types.js';
import { errorName, fromApiResponse, localError, type McpToolError } from './errors.js';

// --- The contract's shapes, by operation ----------------------------------

type Ok<Op extends keyof operations> = operations[Op] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;

/** `Ok`'s twin for an operation whose success status is `201`, not `200`. */
type Ok201<Op extends keyof operations> = operations[Op] extends {
  responses: { 201: { content: { 'application/json': infer T } } };
}
  ? T
  : never;

export type SearchQuery = operations['searchShows']['parameters']['query'];
export type ShowSearchResponse = Ok<'searchShows'>;
export type ChartQuery = operations['getChart']['parameters']['query'];
export type ChartResponse = Ok<'getChart'>;
export type EpisodesListResponse = Ok<'listShowEpisodes'>;
export type EpisodeSummary = components['schemas']['EpisodeSummary'];
export type QuoteRequest = components['schemas']['QuoteRequest'];
export type QuoteResponse = Ok<'createQuote'>;
export type CreateUploadRequest = components['schemas']['CreateUploadRequest'];
export type UploadCreated = Ok201<'createUpload'>;
export type ConfirmRequest = components['schemas']['ConfirmRequest'];
export type JobGroupResponse = Ok<'confirmQuote'>;
export type ListGroupsQuery = NonNullable<operations['listGroups']['parameters']['query']>;
export type JobGroupsListResponse = Ok<'listGroups'>;
export type JobStatus = components['schemas']['JobStatus'];
export type TranscriptUrlRef = components['schemas']['TranscriptUrlRef'];
export type TranscriptJobResponse = Ok<'getTranscriptJob'>;
export type TranscriptRead = components['schemas']['TranscriptRead'];
export type TranscriptReadResponse = Ok<'getTranscriptRead'>;
export type CanonicalTranscript = components['schemas']['CanonicalTranscript'];
export type ShowSummary = components['schemas']['ShowSummary'];
export type DiscoveryExclusion = components['schemas']['DiscoveryExclusion'];
export type JobGroupMember = components['schemas']['JobGroupMember'];

/** Every path this client calls, as the contract spells it: a typo here does not compile. */
export const API_PATHS = {
  searchShows: '/v1/search/shows',
  getChart: '/v1/charts',
  listShowEpisodes: '/v1/shows/{show_id}/episodes',
  createQuote: '/v1/quotes',
  createUpload: '/v1/uploads',
  confirmQuote: '/v1/quotes/{quote_id}/confirm',
  listGroups: '/v1/groups',
  getGroup: '/v1/groups/{group_id}',
  cancelGroup: '/v1/groups/{group_id}/cancel',
  getTranscriptJob: '/v1/transcripts/{job_id}',
  getTranscriptRead: '/v1/reads/{read_id}',
} as const satisfies Partial<Record<keyof operations, keyof paths>>;

export type ApiOperation = keyof typeof API_PATHS;

/** The contract's `Idempotency-Key` header, required on a confirm. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// --- The transport seam -------------------------------------------------------

export type ApiFetchResponse = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type ApiFetchInit = {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
};

/** What `index.ts` gives the client in production (undici's `fetch`); the suites give it a fake. */
export type ApiFetch = (url: string, init: ApiFetchInit) => Promise<ApiFetchResponse>;

/**
 * One API call as the log line records it: the operation, the status, the
 * time — never the URL, never a header.
 */
export type TraceEntry = {
  readonly operation: ApiOperation;
  readonly status: number | null;
  readonly ms: number;
};

/** Per tool call: the caller's credential, and the calls made on their behalf. */
export type ApiCall = {
  /** The `Authorization` value exactly as the MCP request carried it; forwarded verbatim. */
  readonly credential: string;
  readonly trace: TraceEntry[];
};

export type ApiClientOptions = {
  /** The API's origin, with any stage prefix; validated by `index.ts` before it reaches here. */
  readonly baseUrl: string;
  readonly fetch: ApiFetch;
  /** Per call. The API's own ceiling is 29 s; a call that outlives it is not coming back. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export const DEFAULT_API_TIMEOUT_MS = 30_000;
/** What the API sees; the read surface's own is `AudivoApi/0.1`. */
export const MCP_USER_AGENT = 'AudivoMcp/0.1';

export type ApiClient = {
  readonly baseUrl: string;
  /** The authenticated URL of the full transcript — the API's own, never storage. */
  transcriptReference(jobId: string): string;
  /** The same, for a read that has already been paid for: fetching it again costs nothing. */
  readReference(readId: string): string;
  searchShows(call: ApiCall, query: SearchQuery): Promise<ShowSearchResponse>;
  getChart(call: ApiCall, query: ChartQuery): Promise<ChartResponse>;
  /**
   * A show's episodes, newest first, with the `ep_` ids `NamedShow.episode_ids`
   * takes. The feed URL travels as a query parameter because a
   * `show_id` is a one-way derivation and cannot be resolved back to a feed.
   */
  listShowEpisodes(
    call: ApiCall,
    params: {
      readonly showId: string;
      readonly feedUrl: string;
      readonly itunesId?: number | null;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ): Promise<EpisodesListResponse>;
  createQuote(call: ApiCall, body: QuoteRequest): Promise<QuoteResponse>;
  /** Announces a file to upload; PUT it next with exactly the returned `put_headers`. */
  createUpload(call: ApiCall, body: CreateUploadRequest): Promise<UploadCreated>;
  confirmQuote(
    call: ApiCall,
    params: {
      readonly quoteId: string;
      readonly idempotencyKey: string;
      /** The quote's total as the model stated it; the API refuses to spend past it. */
      readonly expectedTotalCredits: number;
    },
  ): Promise<JobGroupResponse>;
  listGroups(call: ApiCall, query: ListGroupsQuery): Promise<JobGroupsListResponse>;
  getGroup(call: ApiCall, groupId: string): Promise<JobGroupResponse>;
  cancelGroup(call: ApiCall, groupId: string): Promise<JobGroupResponse>;
  /** Always `?format=json`: the one delivery a model can be handed fenced. */
  getTranscriptJob(call: ApiCall, jobId: string): Promise<TranscriptJobResponse>;
  /**
   * A settled read's transcript, `?format=json` for the same reason. This is
   * the only way to the content of a group's `cached_read` members: they
   * were charged at confirm and have no job to poll, and the episode read
   * would charge the account a second time for what it already owns.
   */
  getTranscriptRead(call: ApiCall, readId: string): Promise<TranscriptReadResponse>;
};

type QueryValue = string | number | undefined;

function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`path parameter ${name} is missing`);
    return encodeURIComponent(value);
  });
}

function queryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  async function send<T>(
    call: ApiCall,
    operation: ApiOperation,
    request: {
      readonly method: 'GET' | 'POST';
      readonly path: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, QueryValue>>;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<T> {
    const path = fillPath(API_PATHS[operation], request.path);
    const url = `${baseUrl}${path}${queryString(request.query)}`;
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const headers: Record<string, string> = {
      authorization: call.credential,
      accept: 'application/json',
      'user-agent': MCP_USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...request.headers,
    };
    const startedAt = now();
    let response: ApiFetchResponse;
    let text: string;
    try {
      response = await options.fetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      call.trace.push({ operation, status: null, ms: now() - startedAt });
      // The name of what failed and nothing else: a transport error's own
      // text can quote the request it was building.
      throw localError('api_unreachable', `The API did not answer (${errorName(cause)}).`, {
        cause,
      });
    }
    call.trace.push({ operation, status: response.status, ms: now() - startedAt });
    if (response.status < 200 || response.status >= 300) {
      throw fromApiResponse(response.status, text);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw localError(
        'api_response_unreadable',
        `The API answered ${response.status} with a body that is not JSON.`,
        { cause },
      ) satisfies McpToolError;
    }
  }

  return {
    baseUrl,
    transcriptReference(jobId) {
      return `${baseUrl}${fillPath(API_PATHS.getTranscriptJob, { job_id: jobId })}?format=json`;
    },
    readReference(readId) {
      return `${baseUrl}${fillPath(API_PATHS.getTranscriptRead, { read_id: readId })}?format=json`;
    },
    searchShows: (call, query) =>
      send(call, 'searchShows', {
        method: 'GET',
        path: {},
        query: { q: query.q, limit: query.limit },
      }),
    getChart: (call, query) =>
      send(call, 'getChart', {
        method: 'GET',
        path: {},
        query: { category: query.category, size: query.size, language: query.language },
      }),
    listShowEpisodes: (call, params) =>
      send(call, 'listShowEpisodes', {
        method: 'GET',
        path: { show_id: params.showId },
        query: {
          feed_url: params.feedUrl,
          // `null` is "the provider carried none", which the contract spells
          // as the parameter's absence, not as the string "null".
          itunes_id: params.itunesId ?? undefined,
          limit: params.limit,
          cursor: params.cursor,
        } satisfies Record<keyof operations['listShowEpisodes']['parameters']['query'], QueryValue>,
      }),
    createQuote: (call, body) => send(call, 'createQuote', { method: 'POST', path: {}, body }),
    createUpload: (call, body) => send(call, 'createUpload', { method: 'POST', path: {}, body }),
    confirmQuote: (call, params) =>
      send(call, 'confirmQuote', {
        method: 'POST',
        path: { quote_id: params.quoteId },
        // The one property the contract's body carries: the fence the tool
        // already applied locally, restated for the API to apply too.
        body: { expected_total_credits: params.expectedTotalCredits } satisfies ConfirmRequest,
        headers: { [IDEMPOTENCY_KEY_HEADER]: params.idempotencyKey },
      }),
    listGroups: (call, query) =>
      send(call, 'listGroups', { method: 'GET', path: {}, query: { limit: query.limit } }),
    getGroup: (call, groupId) =>
      send(call, 'getGroup', { method: 'GET', path: { group_id: groupId } }),
    cancelGroup: (call, groupId) =>
      send(call, 'cancelGroup', { method: 'POST', path: { group_id: groupId } }),
    getTranscriptJob: (call, jobId) =>
      send(call, 'getTranscriptJob', {
        method: 'GET',
        path: { job_id: jobId },
        query: { format: 'json' } satisfies operations['getTranscriptJob']['parameters']['query'],
      }),
    getTranscriptRead: (call, readId) =>
      send(call, 'getTranscriptRead', {
        method: 'GET',
        path: { read_id: readId },
        // Stated rather than left to the parameter's `json` default, so the
        // request the trace records is the request the contract describes.
        query: { format: 'json' } satisfies operations['getTranscriptRead']['parameters']['query'],
      }),
  };
}

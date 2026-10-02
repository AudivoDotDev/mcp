/**
 * What a model is told when a tool call fails, and how the API's error
 * envelope becomes that.
 *
 * Every failure is one `McpToolError`: the contract's `code` and `type` when
 * the API refused, or one of the few codes this server needs for refusals it
 * makes on its own — before an API call (`unauthenticated`, and
 * `expected_total_mismatch`, which the API answers with too, so a caller
 * reads one code whichever side refused and `origin` says which), or because
 * no usable answer came back (`api_unreachable`, `api_response_unreadable`).
 * A raw body never reaches the model: an envelope is parsed and re-rendered,
 * and anything that is not an envelope — the gateway's own throttle, an HTML
 * error page, a truncated stream — is answered by status alone.
 *
 * The code → type table below is the contract's `ErrorDetail` `oneOf`
 * restated, and `PairsAreLegal` fails to compile if any pair here is one the
 * generated type does not allow. It exists for the envelope that arrives with
 * a `type` the enum does not name, and for the codes this server mints.
 */
import type { components } from './contract/types.js';

export type ApiErrorCode = components['schemas']['ErrorCode'];
export type ApiErrorType = components['schemas']['ErrorType'];
export type ApiErrorDetail = components['schemas']['ErrorDetail'];

/**
 * The refusals this server makes itself. Not in the contract's enum — the
 * contract describes the API — which is why every rendered error also says
 * which side refused (`origin`).
 */
export const LOCAL_ERROR_CODES = [
  /** The API did not answer: a connection, DNS, or timeout failure. */
  'api_unreachable',
  /** The API answered with something that is neither the operation's body nor an envelope. */
  'api_response_unreadable',
  /** The file on disk is not one `upload_audio` can send: wrong container, unreadable, or empty. */
  'file_not_supported',
  /** The PUT to the presigned URL failed; the announcement stands, but nothing was sent. */
  'upload_failed',
  /** yt-dlp is not on this machine and could not be installed; nothing was fetched from YouTube. */
  'youtube_unavailable',
  /** yt-dlp ran and could not search or download; its own reason is in the message. */
  'youtube_failed',
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];
export type ToolErrorCode = ApiErrorCode | LocalErrorCode;

export const ERROR_TYPES = {
  invalid_request: 'invalid_request',
  invalid_url: 'invalid_request',
  source_not_supported: 'invalid_request',
  unsafe_source: 'invalid_request',
  duration_exceeded: 'unprocessable_input',
  size_exceeded: 'unprocessable_input',
  unsupported_codec: 'unprocessable_input',
  unsupported_language: 'unprocessable_input',
  credits_not_refundable: 'unprocessable_input',
  nothing_to_quote: 'unprocessable_input',
  unauthenticated: 'unauthenticated',
  idempotency_conflict: 'conflict',
  job_not_completed: 'conflict',
  request_in_progress: 'conflict',
  quote_expired: 'conflict',
  quote_mismatch: 'conflict',
  quote_unverified: 'conflict',
  expected_total_mismatch: 'conflict',
  // The account's own state. A model holding a key needs these as
  // codes rather than as a 500 it can only retry: no retry lifts a hold,
  // reopens a closed account, or creates a missing one. `conflict` and not
  // `not_found` even for the last, because none of them is about a resource
  // the tool call named — see the contract's `ErrorCode` description.
  account_suspended: 'conflict',
  account_closed: 'conflict',
  account_not_found: 'conflict',
  // The dashboard's per-account ceiling on live API keys. No tool here
  // creates a key — this server holds one, it does not issue them — so the row
  // exists because the table is closed over the contract's enum rather than
  // because a tool can produce it.
  api_key_limit_reached: 'conflict',
  // A checkout against the tier the account already holds. Here for the
  // same reason the key ceiling is: no tool on this server buys a plan, and
  // the table is closed over the contract's enum rather than over what a tool
  // can produce.
  tier_unchanged: 'conflict',
  feed_dead: 'not_found',
  episode_not_found: 'not_found',
  show_not_found: 'not_found',
  job_not_found: 'not_found',
  quote_not_found: 'not_found',
  group_not_found: 'not_found',
  api_key_not_found: 'not_found',
  credit_lot_not_found: 'not_found',
  // The dashboard's OAuth consent and connected-apps operations (ADR-0035).
  // No tool reaches them; listed because the contract declares them.
  oauth_request_not_found: 'not_found',
  connected_app_not_found: 'not_found',
  content_blocked: 'content_blocked',
  payment_required: 'payment_required',
  rate_limited: 'rate_limited',
  concurrency_limited: 'rate_limited',
  // POST /v1/uploads's own admission refusal: the account's announced,
  // unexpired uploads are already at the 10 GiB / 100-upload ceiling.
  upload_quota_exceeded: 'rate_limited',
  // A submit by `upload_id` refused for the reasons a quote excludes an
  // upload, and the caller's own spend cap. `upload_not_received` is the one
  // a retry can fix, once the file's PUT has landed.
  upload_not_found: 'not_found',
  upload_not_received: 'conflict',
  upload_mismatch: 'unprocessable_input',
  max_credits_exceeded: 'unprocessable_input',
  engine_unavailable: 'unavailable',
  processing_failed: 'unavailable',
  discovery_unavailable: 'unavailable',
  internal_error: 'unavailable',
} as const satisfies Record<ApiErrorCode, ApiErrorType>;

/**
 * Each table row as the envelope it would produce, assigned to the generated
 * `ErrorDetail`. That type is an intersection with the contract's `oneOf`, so
 * a row pairing a code with a type the document does not allow matches no
 * branch and this file stops compiling.
 */
type PairsAreLegal = {
  [C in ApiErrorCode]: {
    code: C;
    type: (typeof ERROR_TYPES)[C];
    message: string;
    doc_url: string;
    request_id: string;
    retryable: boolean;
  };
};
const pairsAreLegal: { [C in ApiErrorCode]: ApiErrorDetail } = null as unknown as PairsAreLegal;
void pairsAreLegal;

export const API_ERROR_CODES = Object.freeze(Object.keys(ERROR_TYPES) as ApiErrorCode[]);
const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(API_ERROR_CODES);
const API_ERROR_TYPE_SET: ReadonlySet<string> = new Set(Object.values(ERROR_TYPES));

/** `ErrorDetail.message` is bounded at 1000 characters in the contract; no more is relayed. */
export const ERROR_MESSAGE_MAX_LENGTH = 1000;
/**
 * The most `Retry-After` relayed, in seconds. The edge sends one second
 * (ADR-0037); a larger value would be a header nobody here chose, and a model
 * told to wait an hour would just stop.
 */
export const RETRY_AFTER_MAX_SECONDS = 300;

/** `Retry-After` as delta-seconds, the only form the API sends; anything else is not relayed. */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (header === null || header === undefined || !/^\s*\d{1,6}\s*$/.test(header)) return null;
  return Math.min(Number(header.trim()), RETRY_AFTER_MAX_SECONDS);
}

/** The contract's `RequestId`: the hyphen admits an id minted at the edge from API Gateway's own. */
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9-]+$/;

export type ToolErrorOrigin = 'api' | 'mcp';

export class McpToolError extends Error {
  override readonly name = 'McpToolError';
  readonly origin: ToolErrorOrigin;
  readonly code: ToolErrorCode;
  readonly type: ApiErrorType;
  readonly retryable: boolean;
  /** The API's HTTP status, or `null` for a refusal made here. */
  readonly status: number | null;
  /** The API's request id, so a customer can quote it; `null` for a local refusal. */
  readonly requestId: string | null;
  readonly docUrl: string | null;
  /** The API's `Retry-After`, in seconds, when it sent one; how long to wait before asking again. */
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    readonly origin: ToolErrorOrigin;
    readonly code: ToolErrorCode;
    readonly type: ApiErrorType;
    readonly message: string;
    readonly retryable: boolean;
    readonly status?: number | null;
    readonly requestId?: string | null;
    readonly docUrl?: string | null;
    readonly retryAfterSeconds?: number | null;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.origin = input.origin;
    this.code = input.code;
    this.type = input.type;
    this.retryable = input.retryable;
    this.status = input.status ?? null;
    this.requestId = input.requestId ?? null;
    this.docUrl = input.docUrl ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

const LOCAL_TYPES: Readonly<Record<LocalErrorCode, { type: ApiErrorType; retryable: boolean }>> = {
  api_unreachable: { type: 'unavailable', retryable: true },
  api_response_unreadable: { type: 'unavailable', retryable: true },
  file_not_supported: { type: 'invalid_request', retryable: false },
  upload_failed: { type: 'unavailable', retryable: true },
  youtube_unavailable: { type: 'unavailable', retryable: false },
  youtube_failed: { type: 'unavailable', retryable: true },
};

/** A refusal this server makes without, or instead of, an API call. */
export function localError(
  code:
    | LocalErrorCode
    | 'unauthenticated'
    | 'invalid_request'
    | 'internal_error'
    | 'expected_total_mismatch',
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): McpToolError {
  const local = (LOCAL_TYPES as Record<string, { type: ApiErrorType; retryable: boolean }>)[code];
  const type = local?.type ?? ERROR_TYPES[code as ApiErrorCode];
  const retryable = options.retryable ?? local?.retryable ?? code === 'internal_error';
  return new McpToolError({ origin: 'mcp', code, type, message, retryable, cause: options.cause });
}

export const NO_CREDENTIAL_MESSAGE =
  'This call carried no API key. The MCP client must send Authorization: Bearer hk_live_... ' +
  'on every request; nothing was sent to the API.';

export const INTERNAL_ERROR_MESSAGE =
  'Something went wrong inside the MCP server. Retry; if it keeps happening, report the tool ' +
  'name and the time.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The contract's envelope, if the body is one. Every field is checked before
 * it is trusted: a `code` outside the enum, or an `error` that is not an
 * object, is not an envelope — whatever the status line said.
 */
export function parseErrorEnvelope(text: string): ApiErrorDetail | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const detail = body.error;
  if (typeof detail.code !== 'string' || !API_ERROR_CODE_SET.has(detail.code)) return undefined;
  const code = detail.code as ApiErrorCode;
  const type =
    typeof detail.type === 'string' && API_ERROR_TYPE_SET.has(detail.type)
      ? (detail.type as ApiErrorType)
      : ERROR_TYPES[code];
  return {
    code,
    type,
    message: typeof detail.message === 'string' ? detail.message : '',
    retryable: detail.retryable === true,
    doc_url: typeof detail.doc_url === 'string' ? detail.doc_url : '',
    request_id:
      typeof detail.request_id === 'string' && REQUEST_ID_PATTERN.test(detail.request_id)
        ? detail.request_id
        : '',
  } as ApiErrorDetail;
}

/**
 * A non-2xx answer from the API as one typed error. An envelope is relayed
 * with its own code, type, and message; anything else — API Gateway's own
 * throttle body, a 502 page — is answered from the status line, and its body
 * is discarded rather than shown. `Retry-After` travels with either, so the
 * caller waits as long as the API asked rather than guessing.
 */
export function fromApiResponse(
  status: number,
  text: string,
  retryAfterHeader: string | null = null,
): McpToolError {
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  const envelope = parseErrorEnvelope(text);
  if (envelope !== undefined) {
    return new McpToolError({
      origin: 'api',
      code: envelope.code,
      type: envelope.type,
      message: envelope.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
      retryable: envelope.retryable,
      status,
      requestId: envelope.request_id === '' ? null : envelope.request_id,
      docUrl: envelope.doc_url === '' ? null : envelope.doc_url,
      retryAfterSeconds,
    });
  }
  if (status === 401 || status === 403) {
    return new McpToolError({
      origin: 'api',
      code: 'unauthenticated',
      type: 'unauthenticated',
      message: 'The API refused the key this call carried.',
      retryable: false,
      status,
    });
  }
  if (status === 429) {
    return new McpToolError({
      origin: 'api',
      code: 'rate_limited',
      type: 'rate_limited',
      message: 'The account is over its request rate for the moment; wait and retry.',
      retryable: true,
      status,
      retryAfterSeconds,
    });
  }
  return new McpToolError({
    origin: 'api',
    code: 'api_response_unreadable',
    type: 'unavailable',
    message:
      `The API answered ${status} without a readable error; retry, and report the time if it ` +
      'keeps happening.',
    retryable: status >= 500,
    status,
    retryAfterSeconds,
  });
}

/** Name only, never the message: an unexpected error's text may carry anything. */
export function errorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'Error';
}

/**
 * The credential, wherever it might have been interpolated, replaced. A
 * credential is the whole `Authorization` value as the caller sent it, so
 * both that value and the bare token after the scheme are scrubbed; the
 * server never builds a string from either on purpose, and this is what
 * makes an accident — a transport error echoing a header — harmless.
 */
export function scrub(text: string, credential: string | null): string {
  if (credential === null || credential === '') return text;
  let out = text;
  for (const secret of secretsOf(credential)) {
    if (secret !== '') out = out.split(secret).join('[redacted]');
  }
  return out;
}

function secretsOf(credential: string): readonly string[] {
  const token = credential.replace(/^\s*bearer\s+/i, '').trim();
  return token === credential ? [credential] : [credential, token];
}

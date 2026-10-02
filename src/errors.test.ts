import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ERROR_MESSAGE_MAX_LENGTH,
  ERROR_TYPES,
  LOCAL_ERROR_CODES,
  errorName,
  RETRY_AFTER_MAX_SECONDS,
  fromApiResponse,
  localError,
  parseErrorEnvelope,
  parseRetryAfter,
  scrub,
} from './errors.js';
import { CREDENTIAL, REQUEST_ID, TOKEN, errorEnvelope } from './testing/fake-api.js';

describe('parsing an envelope', () => {
  it("accepts the contract's shape and takes every field from it", () => {
    const envelope = errorEnvelope({
      code: 'quote_expired',
      type: 'conflict',
      message: 'take a new quote',
      retryable: false,
    });
    expect(parseErrorEnvelope(JSON.stringify(envelope))).toEqual({
      code: 'quote_expired',
      type: 'conflict',
      message: 'take a new quote',
      retryable: false,
      doc_url: 'https://docs.audivo.dev/errors#quote_expired',
      request_id: REQUEST_ID,
    });
  });

  it('is not fooled by a body that merely has an error key', () => {
    expect(parseErrorEnvelope('not json')).toBeUndefined();
    expect(parseErrorEnvelope('{"error":"string"}')).toBeUndefined();
    expect(parseErrorEnvelope('{"error":{"code":"made_up"}}')).toBeUndefined();
    expect(parseErrorEnvelope('[]')).toBeUndefined();
  });

  it('repairs a type outside the enum from the table and drops a malformed request id', () => {
    const odd = {
      code: 'feed_dead',
      type: 'weird',
      message: 'x',
      request_id: 'nope',
      retryable: 'yes',
    };
    const detail = parseErrorEnvelope(JSON.stringify({ error: odd }));
    expect(detail).toMatchObject({ code: 'feed_dead', type: 'not_found', request_id: '' });
    expect(detail?.retryable).toBe(false);
  });
});

describe('a non-2xx answer', () => {
  it("relays an envelope, clipped to the contract's message bound", () => {
    const envelope = errorEnvelope({
      code: 'nothing_to_quote',
      type: 'unprocessable_input',
      message: 'm'.repeat(5000),
      retryable: false,
    });
    const error = fromApiResponse(422, JSON.stringify(envelope));
    expect(error).toMatchObject({ origin: 'api', code: 'nothing_to_quote', status: 422 });
    expect(error.type).toBe('unprocessable_input');
    expect(error.requestId).toBe(REQUEST_ID);
    expect(error.message).toHaveLength(ERROR_MESSAGE_MAX_LENGTH);
  });

  it('answers from the status line when there is no envelope, and shows none of the body', () => {
    const unauthenticated = fromApiResponse(401, '{"message":"Unauthorized"}');
    expect(unauthenticated).toMatchObject({ code: 'unauthenticated', retryable: false });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.type).toBe('unauthenticated');
    expect(fromApiResponse(403, 'Forbidden')).toMatchObject({ code: 'unauthenticated' });
    const throttled = fromApiResponse(429, '{"message":"Too Many Requests"}');
    expect(throttled).toMatchObject({ code: 'rate_limited', retryable: true });
    const gateway = fromApiResponse(502, '<html>Bad Gateway</html>');
    expect(gateway).toMatchObject({ code: 'api_response_unreadable', retryable: true });
    expect(gateway.status).toBe(502);
    expect(gateway.type).toBe('unavailable');
    expect(fromApiResponse(418, 'teapot')).toMatchObject({ code: 'api_response_unreadable' });
    expect(fromApiResponse(418, 'teapot').retryable).toBe(false);
    for (const status of [401, 403, 429, 502, 418]) {
      expect(fromApiResponse(status, `secret body ${CREDENTIAL}`).message).not.toContain('secret');
    }
  });

  it("keeps the API's Retry-After, with an envelope or without one, so nobody guesses the wait", () => {
    const envelope = errorEnvelope({ code: 'rate_limited', type: 'rate_limited', retryable: true });
    expect(fromApiResponse(429, JSON.stringify(envelope), '1').retryAfterSeconds).toBe(1);
    expect(fromApiResponse(429, 'Too Many Requests', '6').retryAfterSeconds).toBe(6);
    expect(fromApiResponse(503, '<html/>', '30').retryAfterSeconds).toBe(30);
    expect(fromApiResponse(429, 'Too Many Requests').retryAfterSeconds).toBeNull();
  });
});

describe('reading Retry-After', () => {
  it('takes delta-seconds, bounded, and nothing else', () => {
    expect(parseRetryAfter('1')).toBe(1);
    expect(parseRetryAfter(' 12 ')).toBe(12);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('86400')).toBe(RETRY_AFTER_MAX_SECONDS);
    // An HTTP-date is legal HTTP but not what this API sends; it is not relayed.
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    for (const bad of [null, undefined, '', '-1', '1.5', 'soon']) {
      expect(parseRetryAfter(bad), String(bad)).toBeNull();
    }
  });
});

describe('local refusals', () => {
  it('carry a type from the table and their own retryability', () => {
    const mismatch = localError('expected_total_mismatch', 'x');
    expect(mismatch).toMatchObject({ origin: 'mcp', retryable: false, status: null });
    expect(mismatch.type).toBe('conflict');
    expect(localError('api_unreachable', 'x')).toMatchObject({ retryable: true });
    expect(localError('api_unreachable', 'x').type).toBe('unavailable');
    expect(localError('unauthenticated', 'x').type).toBe('unauthenticated');
    expect(localError('invalid_request', 'x').type).toBe('invalid_request');
    const internal = localError('internal_error', 'x', { cause: new Error('c') });
    expect(internal).toMatchObject({ retryable: true });
    expect(internal.type).toBe('unavailable');
  });

  it('name codes the contract does not, and only those', () => {
    for (const code of LOCAL_ERROR_CODES) expect(API_ERROR_CODES).not.toContain(code);
    expect(Object.keys(ERROR_TYPES)).toEqual(API_ERROR_CODES);
  });

  it('carries upload_quota_exceeded as rate_limited, and two local upload refusals', () => {
    expect(ERROR_TYPES.upload_quota_exceeded).toBe('rate_limited');
    const fileNotSupported = localError('file_not_supported', 'x');
    expect(fileNotSupported).toMatchObject({ origin: 'mcp', retryable: false });
    expect(fileNotSupported.type).toBe('invalid_request');
    const uploadFailed = localError('upload_failed', 'x');
    expect(uploadFailed).toMatchObject({ origin: 'mcp', retryable: true });
    expect(uploadFailed.type).toBe('unavailable');
  });
});

describe('scrubbing', () => {
  it('replaces the header value and the bare token wherever they appear', () => {
    const scrubbed = scrub(`sent ${CREDENTIAL} and again ${TOKEN}.`, CREDENTIAL);
    expect(scrubbed).toBe('sent [redacted] and again [redacted].');
    expect(scrub('nothing here', CREDENTIAL)).toBe('nothing here');
    expect(scrub(`keeps ${TOKEN}`, null)).toBe(`keeps ${TOKEN}`);
    expect(scrub(`keeps ${TOKEN}`, '')).toBe(`keeps ${TOKEN}`);
  });

  it('names an error by its class only', () => {
    expect(errorName(new RangeError('x'))).toBe('RangeError');
    expect(errorName('string')).toBe('Error');
    expect(errorName(Object.assign(new Error('x'), { name: '' }))).toBe('Error');
  });
});

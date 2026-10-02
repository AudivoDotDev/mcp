import { describe, expect, it } from 'vitest';
import { messageFor, outcomeOf } from './bridge.js';

describe('reading a tool result', () => {
  it('takes the view from _meta and nothing from the model’s text', () => {
    const view = { kind: 'library', items: [], next_cursor: null };
    expect(
      outcomeOf({ content: [{ type: 'text', text: '{"x":1}' }], _meta: { 'audivo/view': view } }),
    ).toEqual({ ok: true, view });
  });

  it('turns a failure into the app’s own sentence, with the reference a person can quote', () => {
    const outcome = outcomeOf({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'payment_required' } }) }],
      _meta: { 'audivo/request_id': 'req_abc' },
    });
    expect(outcome).toEqual({
      ok: false,
      message: messageFor('payment_required'),
      reference: 'req_abc',
    });
  });

  it('carries the wait the server relayed, and only a usable one', () => {
    const failed = (error: Record<string, unknown>) =>
      outcomeOf({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] });
    expect(failed({ code: 'rate_limited', retry_after_seconds: 1 })).toMatchObject({
      ok: false,
      message: messageFor('rate_limited'),
      retryAfterSeconds: 1,
    });
    for (const bad of [undefined, '1', -1, Number.NaN]) {
      expect(failed({ code: 'rate_limited', retry_after_seconds: bad })).not.toHaveProperty(
        'retryAfterSeconds',
      );
    }
  });

  it('never promotes a plan or a price, for any code', () => {
    for (const code of [
      'payment_required',
      'insufficient_credits',
      'max_credits_exceeded',
      'rate_limited',
      'account_suspended',
      undefined,
      'anything',
    ]) {
      expect(messageFor(code)).not.toMatch(/upgrade|subscri|plan\b|pricing|\$\d/i);
    }
  });
});

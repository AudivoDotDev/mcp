import { describe, expect, it } from 'vitest';
import {
  clock,
  deepLinkUrl,
  creditsLine,
  duration,
  isSettled,
  languageName,
  refFromPath,
  shortDate,
  statusLabel,
} from './format.js';

describe('the app’s wording', () => {
  it('writes timestamps and durations', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(754)).toBe('12:34');
    expect(clock(3723)).toBe('1:02:03');
    expect(duration(45)).toBe('45 s');
    expect(duration(3120)).toBe('52 min');
    expect(duration(3840)).toBe('1 h 4 min');
    expect(duration(7200)).toBe('2 h');
  });

  it('says what a cost figure is, and never names a plan', () => {
    expect(creditsLine(1, 'charged')).toBe('1 credit');
    expect(creditsLine(52, 'settled')).toBe('52 credits');
    expect(creditsLine(66, 'reserved')).toBe('up to 66 credits');
    expect(creditsLine(60, 'estimated')).toBe('about 60 credits');
    expect(creditsLine(null, 'charged')).toBeNull();
  });

  it('dates in the user’s locale, with the year only when it is another one', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(shortDate('2026-09-30T08:00:00Z', 'en-US', now)).toBe('Sep 30');
    expect(shortDate('2025-09-30T08:00:00Z', 'en-US', now)).toBe('Sep 30, 2025');
    expect(shortDate('not a date', 'en-US', now)).toBe('');
  });

  it('names a language, and falls back to its code', () => {
    expect(languageName('en', 'en-US')).toBe('English');
    expect(languageName(null)).toBeNull();
    expect(languageName('zz-not-real', 'en-US')).toBeTypeOf('string');
  });

  it('tells a finished job from one still running', () => {
    expect(statusLabel('cached')).toEqual({ text: 'Ready', tone: 'ready' });
    expect(statusLabel('transcribing').tone).toBe('working');
    expect(isSettled('completed')).toBe(true);
    expect(isSettled('queued')).toBe(false);
  });

  it('reads a deep link in the form current hosts send and in the older one', () => {
    expect(deepLinkUrl({ url: '/jobs/job_abcdefghijklmnop' })).toBe('/jobs/job_abcdefghijklmnop');
    expect(deepLinkUrl({ path: ['reads', 'job_abcdefghijklmnop'], query: [] })).toBe(
      '/reads/job_abcdefghijklmnop',
    );
    expect(deepLinkUrl({ path: ['parts'], query: [['tag', 'a b']] })).toBe('/parts?tag=a+b');
    expect(deepLinkUrl({ path: [1, 2] })).toBeUndefined();
    expect(deepLinkUrl(null)).toBeUndefined();
  });

  it('reads a deep link as a transcript, and nothing else as one', () => {
    expect(refFromPath('/jobs/job_abcdefghijklmnop')).toEqual({ job_id: 'job_abcdefghijklmnop' });
    expect(refFromPath('/reads/job_abcdefghijklmnop/')).toEqual({
      read_id: 'job_abcdefghijklmnop',
    });
    expect(refFromPath('/jobs/job_short')).toBeUndefined();
    expect(refFromPath('/jobs/job_abcdefghijklmnop?x=1')).toBeUndefined();
    expect(refFromPath('https://evil.example/jobs/job_abcdefghijklmnop')).toBeUndefined();
  });
});

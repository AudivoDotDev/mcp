import { describe, expect, it } from 'vitest';
import { BaseUrlError, MAX_BASE_URL_LENGTH, assertApiBaseUrl } from './base-url.js';

describe('assertApiBaseUrl', () => {
  it('accepts the production origin and hands it back without a trailing slash', () => {
    expect(assertApiBaseUrl('https://api.audivo.dev')).toBe('https://api.audivo.dev');
    expect(assertApiBaseUrl('https://api.audivo.dev/')).toBe('https://api.audivo.dev');
  });

  it('accepts a stage-prefixed origin and keeps the prefix', () => {
    const staged = 'https://abc123.execute-api.eu-west-1.amazonaws.com/staging';
    expect(assertApiBaseUrl(`${staged}/`)).toBe(staged);
    expect(assertApiBaseUrl(staged)).toBe(staged);
  });

  it.each([
    ['http://api.audivo.dev', 'scheme_not_allowed'],
    ['ftp://api.audivo.dev', 'scheme_not_allowed'],
    ['https://user:pw@api.audivo.dev', 'credentials_in_url'],
    ['https://user@api.audivo.dev', 'credentials_in_url'],
    ['https://api.audivo.dev/?debug=1', 'query_not_allowed'],
    ['https://api.audivo.dev/#frag', 'fragment_not_allowed'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['/v1', 'invalid_url'],
  ])('refuses %s as %s', (raw, code) => {
    expect(() => assertApiBaseUrl(raw)).toThrow(BaseUrlError);
    try {
      assertApiBaseUrl(raw);
    } catch (error) {
      expect((error as BaseUrlError).code).toBe(code);
    }
  });

  it.each([
    'https://localhost',
    'https://localhost:8443/api',
    'https://api.localhost',
    'https://127.0.0.1/api',
    'https://127.1.2.3',
    'https://0.0.0.0',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://172.31.255.254',
    'https://192.168.1.1',
    'https://169.254.169.254/latest',
    'https://100.64.0.1',
    'https://[::1]',
    'https://[fe80::1]',
    'https://[fd00::1]',
    'https://[::ffff:127.0.0.1]',
  ])('refuses %s as a private or local host', (raw) => {
    expect(() => assertApiBaseUrl(raw)).toThrow(BaseUrlError);
    try {
      assertApiBaseUrl(raw);
    } catch (error) {
      expect((error as BaseUrlError).code).toBe('host_not_allowed');
    }
  });

  it('still allows a public address that merely resembles a private range', () => {
    expect(assertApiBaseUrl('https://172.32.0.1')).toBe('https://172.32.0.1');
    expect(assertApiBaseUrl('https://11.0.0.1')).toBe('https://11.0.0.1');
  });

  it('refuses an over-long URL before parsing it', () => {
    const long = `https://api.audivo.dev/${'a'.repeat(MAX_BASE_URL_LENGTH)}`;
    expect(() => assertApiBaseUrl(long)).toThrow(/url_too_long/);
  });

  it('never echoes userinfo in the message', () => {
    try {
      assertApiBaseUrl('https://alice:hunter2@api.audivo.dev');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).not.toContain('alice');
    }
  });
});

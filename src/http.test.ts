import { describe, expect, it } from 'vitest';
import {
  toLambdaResponse,
  toWebRequest,
  type HttpApiV2Event,
  type RestProxyEvent,
} from './http.js';

const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

describe('the REST proxy event', () => {
  it('becomes a Request with the method, URL, headers and body', async () => {
    const event: RestProxyEvent = {
      httpMethod: 'post',
      path: '/mcp',
      headers: {
        Host: 'mcp.hark.test',
        'Content-Type': 'application/json',
        Authorization: 'Bearer hk_live_x',
      },
      multiValueQueryStringParameters: { a: ['1', '2'], b: ['x'] },
      body: BODY,
      isBase64Encoded: false,
      requestContext: { domainName: 'ignored-when-host-is-set' },
    };
    const request = toWebRequest(event);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://mcp.hark.test/mcp?a=1&a=2&b=x');
    expect(request.headers.get('authorization')).toBe('Bearer hk_live_x');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.text()).toBe(BODY);
  });

  it('decodes a base64 body, and falls back to the query map and domain name', async () => {
    const event: RestProxyEvent = {
      httpMethod: 'POST',
      path: '/mcp',
      headers: null,
      queryStringParameters: { only: 'one' },
      body: Buffer.from(BODY, 'utf8').toString('base64'),
      isBase64Encoded: true,
      requestContext: { domainName: 'abc.execute-api.eu-west-1.amazonaws.com' },
    };
    const request = toWebRequest(event);
    expect(request.url).toBe('https://abc.execute-api.eu-west-1.amazonaws.com/mcp?only=one');
    expect(await request.text()).toBe(BODY);
  });

  it('sends no body on a GET', () => {
    const request = toWebRequest({ httpMethod: 'GET', path: '/mcp', body: 'ignored' });
    expect(request.url).toBe('https://localhost/mcp');
    expect(request.body).toBeNull();
  });
});

describe('the HTTP API v2 event', () => {
  it('becomes the same Request', async () => {
    const event: HttpApiV2Event = {
      version: '2.0',
      rawPath: '/mcp',
      rawQueryString: 'a=1&a=2',
      headers: { host: 'mcp.hark.test', authorization: 'Bearer hk_live_y' },
      body: BODY,
      isBase64Encoded: false,
      requestContext: { http: { method: 'POST' }, domainName: 'mcp.hark.test' },
    };
    const request = toWebRequest(event);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://mcp.hark.test/mcp?a=1&a=2');
    expect(request.headers.get('authorization')).toBe('Bearer hk_live_y');
    expect(await request.text()).toBe(BODY);
  });
});

describe('the response', () => {
  it('is buffered into the Lambda shape with its headers', async () => {
    const response = new Response('{"ok":true}', {
      status: 202,
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' },
    });
    expect(await toLambdaResponse(response)).toEqual({
      statusCode: 202,
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' },
      body: '{"ok":true}',
      isBase64Encoded: false,
    });
  });
});

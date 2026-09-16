/**
 * Between Lambda's HTTP event shapes and the web-standard `Request` and
 * `Response` the MCP handler speaks.
 *
 * Two event shapes, because the stack has not yet chosen the edge: the REST
 * API's proxy event (what API Gateway's REST API sends) and the HTTP API /
 * Function URL payload (version 2.0). Both are read for the same five things
 * — method, path, query, headers, body — and nothing else is typed. The
 * response is always buffered: every MCP answer this server produces is a
 * JSON document (`server.ts`), and an edge that cannot stream is not asked
 * to.
 */

export type RestProxyEvent = {
  readonly httpMethod: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly multiValueQueryStringParameters?: Readonly<
    Record<string, readonly string[] | undefined>
  > | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly domainName?: string } | null;
};

export type HttpApiV2Event = {
  readonly version: '2.0';
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly http: { readonly method: string };
    readonly domainName?: string;
  };
};

export type LambdaHttpEvent = RestProxyEvent | HttpApiV2Event;

export type LambdaHttpResponse = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
};

function isV2(event: LambdaHttpEvent): event is HttpApiV2Event {
  return (event as HttpApiV2Event).version === '2.0';
}

function headerEntries(
  headers: Readonly<Record<string, string | undefined>> | null | undefined,
): [string, string][] {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') entries.push([name, value]);
  }
  return entries;
}

function hostOf(entries: readonly [string, string][], fallback: string | undefined): string {
  const host = entries.find(([name]) => name.toLowerCase() === 'host')?.[1];
  return host ?? fallback ?? 'localhost';
}

function restQuery(event: RestProxyEvent): string {
  const params = new URLSearchParams();
  const multi = event.multiValueQueryStringParameters;
  if (multi !== undefined && multi !== null) {
    for (const [name, values] of Object.entries(multi)) {
      for (const value of values ?? []) params.append(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
      if (typeof value === 'string') params.append(name, value);
    }
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function toWebRequest(event: LambdaHttpEvent): Request {
  const entries = headerEntries(event.headers);
  const host = hostOf(entries, event.requestContext?.domainName);
  const method = (isV2(event) ? event.requestContext.http.method : event.httpMethod).toUpperCase();
  const path = isV2(event) ? event.rawPath : event.path;
  const query = isV2(event)
    ? event.rawQueryString === undefined || event.rawQueryString === ''
      ? ''
      : `?${event.rawQueryString}`
    : restQuery(event);
  const raw = event.body ?? null;
  const body =
    raw === null || method === 'GET' || method === 'HEAD'
      ? null
      : event.isBase64Encoded === true
        ? Buffer.from(raw, 'base64')
        : raw;
  return new Request(`https://${host}${path}${query}`, {
    method,
    headers: entries,
    ...(body === null ? {} : { body }),
  });
}

export async function toLambdaResponse(response: Response): Promise<LambdaHttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

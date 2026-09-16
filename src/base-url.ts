/**
 * The one check on the API's base URL, made once at startup and never per
 * request. A misconfigured URL fails the process before a caller's key can be
 * sent anywhere: the only destination this server will open a connection to
 * is a public https origin, with no userinfo, query or fragment, and never a
 * loopback, private, link-local, or metadata address.
 *
 * Hostnames are not resolved here. The base URL is operator-configured and
 * fixed for the life of the process, so the check is on its shape, not on
 * what DNS answers.
 */

export const MAX_BASE_URL_LENGTH = 2048;

export type BaseUrlErrorCode =
  | 'url_too_long'
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'query_not_allowed'
  | 'fragment_not_allowed'
  | 'host_not_allowed';

/** The message names the code and the rule, never the URL: a URL can carry a password. */
export class BaseUrlError extends Error {
  readonly code: BaseUrlErrorCode;
  constructor(code: BaseUrlErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'BaseUrlError';
    this.code = code;
  }
}

/** Returns the origin plus any path prefix, with no trailing slash, or throws `BaseUrlError`. */
export function assertApiBaseUrl(raw: string): string {
  if (raw.length > MAX_BASE_URL_LENGTH) {
    throw new BaseUrlError(
      'url_too_long',
      `URL is ${raw.length} characters, limit is ${MAX_BASE_URL_LENGTH}`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BaseUrlError('invalid_url', 'not an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new BaseUrlError('scheme_not_allowed', `scheme ${url.protocol} is not https:`);
  }
  if (url.username !== '' || url.password !== '' || authorityOf(raw).includes('@')) {
    throw new BaseUrlError('credentials_in_url', 'URL carries userinfo (user:password@host)');
  }
  if (url.search !== '' || raw.includes('?')) {
    throw new BaseUrlError('query_not_allowed', 'a base URL has no query string');
  }
  if (url.hash !== '' || raw.includes('#')) {
    throw new BaseUrlError('fragment_not_allowed', 'a base URL has no fragment');
  }
  if (!isPublicHost(url.hostname)) {
    throw new BaseUrlError(
      'host_not_allowed',
      'host is a loopback, private, link-local, or local address',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The text between `//` and the first `/`, `?` or `#`: where userinfo would sit. */
function authorityOf(raw: string): string {
  const start = raw.indexOf('//');
  if (start === -1) return '';
  const rest = raw.slice(start + 2);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    const hextets = parseIpv6(host.slice(1, -1));
    return hextets === null ? false : isPublicIpv6(hextets);
  }
  const octets = parseIpv4(host);
  if (octets !== null) return isPublicIpv4(octets);
  return true;
}

function parseIpv4(host: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * The address classes a base URL may not point at: this-network, private
 * (RFC 1918), carrier NAT, loopback, link-local (where cloud metadata lives),
 * IETF protocol assignments, benchmarking, multicast, reserved, and broadcast.
 */
function isPublicIpv4([a, b]: readonly number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;
  return true;
}

/** Eight 16-bit groups, with one `::` expanded, or `null` for anything else. */
function parseIpv6(text: string): readonly number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Unspecified, loopback, link-local, unique-local, and IPv4-mapped addresses whose IPv4 half is not public. */
function isPublicIpv6(h: readonly number[]): boolean {
  const first = h[0] ?? 0;
  if (h.every((group) => group === 0)) return false;
  if (h.slice(0, 7).every((group) => group === 0) && h[7] === 1) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  const mapped = h.slice(0, 5).every((group) => group === 0) && h[5] === 0xffff;
  if (mapped) {
    const hi = h[6] ?? 0;
    const lo = h[7] ?? 0;
    return isPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return true;
}

/**
 * The pure helpers `upload_audio` (a local-only tool, added separately)
 * builds on: inspecting a file on disk, and putting it to a presigned URL.
 * Nothing here talks to the Audivo API — that is `api-client.ts`'s
 * `createUpload`, which hands back the URL and headers this module consumes.
 *
 * Content type is detected from the file's own magic bytes with `file-type`
 * (`fileTypeFromFile`), not from `music-metadata`'s `format.container`: for
 * an MP4 family file that field is the `ftyp` brand list (e.g.
 * `M4A/mp42/isom`), which makes an exact-match table fragile. `file-type`'s
 * MIME is mapped into the contract's accepted list by `MIME_CONTENT_TYPES`;
 * `music-metadata` still supplies `container` (a human-readable label) and
 * `durationSeconds`, and an unparseable file yields nulls for both rather
 * than throwing.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { fileTypeFromFile } from 'file-type';
import { parseFile } from 'music-metadata';
import { fetch as undiciFetch } from 'undici';
import { isPublicHost } from './base-url.js';
import { localError } from './errors.js';

export type AudioFileFacts = {
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string | null;
  readonly durationSeconds: number | null;
  readonly container: string | null;
  /**
   * `file-type`'s raw detected MIME, ahead of `contentTypeFor` mapping it
   * into the contract's enum (or dropping it to `null` when the mapping
   * table has no entry for it). `null` means detection found nothing at
   * all; a non-null value outside the `audio/`/`video/` prefixes means
   * detection found something and that something is not audio, for example
   * `application/pdf`. `contentType` alone cannot make this distinction:
   * it is `null` both when nothing was detected and when something was
   * detected but is not on the contract's list, yet a caller's explicit
   * `content_type` should be trusted in the first case and refused in the
   * second, so callers needing that distinction read `detectedMime`.
   */
  readonly detectedMime: string | null;
};

/**
 * `file-type`'s detected MIME, mapped to the contract's `UploadContentType`
 * enum. Every value here is one of the contract's exact strings. Anything
 * `file-type` reports that is not a key here — including a video container
 * such as Matroska's `video/matroska` that merely happens to hold audio —
 * is not a type `upload_audio` will announce.
 */
export const MIME_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/mp4': 'audio/mp4',
  'video/mp4': 'audio/mp4',
  'audio/aac': 'audio/aac',
  'audio/ogg': 'audio/ogg',
  'audio/opus': 'audio/opus',
  'audio/x-flac': 'audio/flac',
  'audio/flac': 'audio/flac',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'video/webm': 'audio/webm',
  'audio/webm': 'audio/webm',
};

/**
 * `null` in, `null` out; a MIME the table does not list also answers `null`.
 * `file-type` 21.x reports Opus-in-Ogg as `audio/ogg; codecs=opus` — a
 * parameterised MIME that appears nowhere in `MIME_CONTENT_TYPES` verbatim —
 * so the string is lower-cased and trimmed to its type/subtype (everything
 * before the first `;`) before lookup, and the Opus case is mapped
 * explicitly: a `codecs=opus` parameter on an `audio/ogg` MIME yields
 * `audio/opus`, while a plain `audio/ogg` (no such parameter) stays
 * `audio/ogg`.
 */
export function contentTypeFor(detected: string | null): string | null {
  if (detected === null) return null;
  const normalized = detected.toLowerCase();
  const [mime] = normalized.split(';', 1);
  if (mime === 'audio/ogg' && /(?:^|;)\s*codecs=opus\s*(?:;|$)/.test(normalized)) {
    return 'audio/opus';
  }
  return MIME_CONTENT_TYPES[mime ?? ''] ?? null;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * `fs.stat`, the streamed SHA-256, and what `file-type` and `music-metadata`
 * can tell from the bytes. A path `stat` cannot resolve at all (missing,
 * permission denied, ...) is refused as `invalid_request` without relaying
 * the OS error text; a non-regular file (a directory, a socket, ...) that
 * `stat` does resolve is refused too. Both happen before any of the rest
 * runs; a file that is regular but not audio `file-type` and
 * `music-metadata` recognise yields nulls, not a throw — the caller decides
 * whether nulls are a reason to refuse the upload.
 */
export async function inspectAudioFile(path: string): Promise<AudioFileFacts> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch {
    throw localError('invalid_request', 'path must name a readable file on this machine');
  }
  if (!stats.isFile()) {
    throw localError('invalid_request', `${path} is not a regular file.`);
  }

  const [sha256, detected, parsed] = await Promise.all([
    sha256OfFile(path),
    fileTypeFromFile(path).catch(() => undefined),
    parseFile(path, { duration: true, skipCovers: true }).catch(() => undefined),
  ]);

  return {
    bytes: stats.size,
    sha256,
    contentType: contentTypeFor(detected?.mime ?? null),
    durationSeconds: parsed?.format.duration ?? null,
    container: parsed?.format.container ?? null,
    detectedMime: detected?.mime ?? null,
  };
}

// --- The presigned PUT ------------------------------------------------------

export type PutUrlErrorCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'fragment_not_allowed'
  | 'host_not_allowed';

/**
 * `BaseUrlError`'s (`base-url.ts`) shape, restated as its own class: the two
 * guard different things — the operator-configured API origin there, a
 * presigned URL the API hands back here, one difference being that this one
 * allows a query string — so callers catching one are never surprised to
 * also catch the other. The message names the code and the rule, never the
 * URL: a presigned URL's query is its signature, not a secret to redact, but
 * still not worth echoing into a log line by habit.
 */
export class PutUrlError extends Error {
  readonly code: PutUrlErrorCode;
  constructor(code: PutUrlErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'PutUrlError';
    this.code = code;
  }
}

/**
 * `https` only, no userinfo, a public host, a fragment refused — the same
 * rule `assertApiBaseUrl` applies to the API's own origin, reused here via
 * `isPublicHost` — but a query string is allowed: a presigned PUT URL's
 * signature lives there. Returns the URL exactly as given: reconstructing it
 * from the parsed `URL` risks re-encoding a signed query parameter and
 * invalidating the signature.
 */
export function assertPutUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PutUrlError('invalid_url', 'not an absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new PutUrlError('scheme_not_allowed', `scheme ${parsed.protocol} is not https:`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new PutUrlError('credentials_in_url', 'URL carries userinfo (user:password@host)');
  }
  if (parsed.hash !== '') {
    throw new PutUrlError('fragment_not_allowed', 'a PUT URL has no fragment');
  }
  if (!isPublicHost(parsed.hostname)) {
    throw new PutUrlError(
      'host_not_allowed',
      'host is a loopback, private, link-local, or local address',
    );
  }
  return url;
}

export type PutHeaders = Readonly<Record<string, string>>;

export interface UploadTransport {
  put(
    url: string,
    headers: PutHeaders,
    path: string,
  ): Promise<{ readonly status: number; readonly body: string }>;
}

/** The four fields `undici`'s `fetch` needs to PUT a file body; the suite gives a recording fake. */
export type UploadFetch = (
  url: string,
  init: {
    readonly method: 'PUT';
    readonly headers: PutHeaders;
    readonly body: Readable;
    readonly duplex: 'half';
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * `fetchImpl` defaults to undici's own `fetch`; `undiciUploadTransport` below
 * is that default instance, and tests pass a recording fake instead so the
 * request shaping is checked without a network call, real or local (a local
 * HTTP test server would itself be refused by `assertPutUrl`, which
 * `put` applies before `fetchImpl` is ever invoked).
 */
export function uploadTransport(fetchImpl: UploadFetch): UploadTransport {
  return {
    async put(url, headers, path) {
      const asserted = assertPutUrl(url);
      const response = await fetchImpl(asserted, {
        method: 'PUT',
        headers,
        body: createReadStream(path),
        duplex: 'half',
      });
      // S3's error bodies are small XML; there is never a reason to stream one.
      return { status: response.status, body: await response.text() };
    },
  };
}

/** The production transport: undici's `fetch`, pinned, same as `transport.ts` uses for the API. */
export const undiciUploadTransport: UploadTransport = uploadTransport((url, init) =>
  undiciFetch(url, init),
);

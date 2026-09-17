import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpToolError } from './errors.js';
import { buildWavFixture, tempDir } from './testing/audio-file.js';
import {
  MIME_CONTENT_TYPES,
  PutUrlError,
  assertPutUrl,
  contentTypeFor,
  inspectAudioFile,
  uploadTransport,
} from './upload.js';

/**
 * The smallest Ogg page `file-type` will recognise as Opus: a 27-byte `OggS`
 * header (capture pattern, version, header type, granule position, serial
 * number, page sequence number, CRC, segment count) naming one segment, a
 * one-byte segment table giving that segment's length, and a 19-byte
 * `OpusHead` packet (RFC 7845) as the segment itself. No audio data follows,
 * so `music-metadata` cannot report a duration for it — only the content
 * type is asserted here. Verified against `file-type` 21.3.4 with
 * `fileTypeFromFile`, which reports `{ ext: 'opus', mime: 'audio/ogg;
 * codecs=opus' }` for exactly these bytes.
 */
function buildOggOpusFixture(): Buffer {
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'ascii');
  opusHead.writeUInt8(1, 8); // version
  opusHead.writeUInt8(1, 9); // channel count
  opusHead.writeUInt16LE(0, 10); // pre-skip
  opusHead.writeUInt32LE(48000, 12); // input sample rate
  opusHead.writeUInt16LE(0, 16); // output gain
  opusHead.writeUInt8(0, 18); // channel mapping family

  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(0x02, 5); // header type: beginning of stream
  header.writeBigUInt64LE(0n, 6); // granule position
  header.writeUInt32LE(1, 14); // bitstream serial number
  header.writeUInt32LE(0, 18); // page sequence number
  header.writeUInt32LE(0, 22); // CRC checksum (file-type does not validate it)
  header.writeUInt8(1, 26); // number of page segments

  const segmentTable = Buffer.from([opusHead.length]);

  return Buffer.concat([header, segmentTable, opusHead]);
}

describe('inspectAudioFile', () => {
  it('reports size, sha256, container, content type and duration for a real WAV', async () => {
    const dir = tempDir();
    const wav = buildWavFixture(2.5);
    const filePath = path.join(dir, 'fixture.wav');
    fs.writeFileSync(filePath, wav);

    const facts = await inspectAudioFile(filePath);

    expect(facts.bytes).toBe(wav.length);
    expect(facts.sha256).toBe(createHash('sha256').update(wav).digest('hex'));
    expect(facts.container).toBe('WAVE');
    expect(facts.contentType).toBe('audio/wav');
    expect(facts.durationSeconds).not.toBeNull();
    expect(Math.abs((facts.durationSeconds as number) - 2.5)).toBeLessThan(0.01);
  });

  it('reports nulls for container, content type and duration on unparseable bytes', async () => {
    const dir = tempDir();
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
    const filePath = path.join(dir, 'random.bin');
    fs.writeFileSync(filePath, bytes);

    const facts = await inspectAudioFile(filePath);

    expect(facts.bytes).toBe(64);
    expect(facts.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(facts.contentType).toBeNull();
    expect(facts.durationSeconds).toBeNull();
    expect(facts.container).toBeNull();
  });

  it('refuses a directory as invalid_request', async () => {
    const dir = tempDir();

    await expect(inspectAudioFile(dir)).rejects.toMatchObject(
      expect.objectContaining({
        name: 'McpToolError',
        code: 'invalid_request',
      }) as Partial<McpToolError>,
    );
  });

  it('rejects with an McpToolError instance for the directory case', async () => {
    const dir = tempDir();
    await expect(inspectAudioFile(dir)).rejects.toBeInstanceOf(McpToolError);
  });

  it('reports audio/opus for a synthesized Ogg-Opus page (duration is unavailable for the stub)', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'fixture.opus.ogg');
    fs.writeFileSync(filePath, buildOggOpusFixture());

    const facts = await inspectAudioFile(filePath);

    expect(facts.contentType).toBe('audio/opus');
  });

  it('refuses a path that names nothing on disk as invalid_request from mcp', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'does-not-exist.wav');

    await expect(inspectAudioFile(missing)).rejects.toMatchObject(
      expect.objectContaining({
        name: 'McpToolError',
        code: 'invalid_request',
        origin: 'mcp',
      }) as Partial<McpToolError>,
    );
  });
});

describe('contentTypeFor', () => {
  it('maps every MIME the table lists to the contract content type', () => {
    expect(contentTypeFor('audio/mpeg')).toBe('audio/mpeg');
    expect(contentTypeFor('audio/x-m4a')).toBe('audio/mp4');
    expect(contentTypeFor('audio/mp4')).toBe('audio/mp4');
    expect(contentTypeFor('video/mp4')).toBe('audio/mp4');
    expect(contentTypeFor('audio/aac')).toBe('audio/aac');
    expect(contentTypeFor('audio/ogg')).toBe('audio/ogg');
    expect(contentTypeFor('audio/opus')).toBe('audio/opus');
    expect(contentTypeFor('audio/x-flac')).toBe('audio/flac');
    expect(contentTypeFor('audio/flac')).toBe('audio/flac');
    expect(contentTypeFor('audio/wav')).toBe('audio/wav');
    expect(contentTypeFor('audio/x-wav')).toBe('audio/wav');
    expect(contentTypeFor('audio/vnd.wave')).toBe('audio/wav');
    expect(contentTypeFor('video/webm')).toBe('audio/webm');
    expect(contentTypeFor('audio/webm')).toBe('audio/webm');
  });

  it('refuses an unlisted or absent MIME, including a video container merely holding audio', () => {
    expect(contentTypeFor('video/x-matroska')).toBeNull();
    expect(contentTypeFor('video/matroska')).toBeNull();
    expect(contentTypeFor('application/octet-stream')).toBeNull();
    expect(contentTypeFor(null)).toBeNull();
  });

  it('normalises the MIME before lookup and maps Ogg-Opus explicitly', () => {
    expect(contentTypeFor('audio/ogg; codecs=opus')).toBe('audio/opus');
    expect(contentTypeFor('AUDIO/OGG')).toBe('audio/ogg');
  });

  it('is exactly the table MIME_CONTENT_TYPES describes', () => {
    for (const [mime, contentType] of Object.entries(MIME_CONTENT_TYPES)) {
      expect(contentTypeFor(mime)).toBe(contentType);
    }
  });
});

describe('assertPutUrl', () => {
  it('accepts a presigned S3 PUT URL, query string and all', () => {
    const url = 'https://bucket.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=abc';
    expect(assertPutUrl(url)).toBe(url);
  });

  it.each([
    ['http://bucket.s3.us-east-1.amazonaws.com/k', 'scheme_not_allowed'],
    ['https://user@bucket.s3.us-east-1.amazonaws.com/k', 'credentials_in_url'],
    ['https://127.0.0.1/k', 'host_not_allowed'],
    ['https://bucket.s3.us-east-1.amazonaws.com/k#frag', 'fragment_not_allowed'],
    ['not a url', 'invalid_url'],
  ])('refuses %s as %s', (raw, code) => {
    expect(() => assertPutUrl(raw)).toThrow(PutUrlError);
    try {
      assertPutUrl(raw);
      expect.unreachable();
    } catch (error) {
      expect((error as PutUrlError).code).toBe(code);
    }
  });
});

describe('uploadTransport', () => {
  it('PUTs exactly the given headers and a read stream of the file, duplex half', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'clip.mp3');
    fs.writeFileSync(filePath, Buffer.from('some audio bytes'));

    const calls: Array<{ url: string; init: unknown }> = [];
    const fake = async (url: string, init: unknown) => {
      calls.push({ url, init });
      return { status: 200, text: async () => '' };
    };

    const transport = uploadTransport(fake);
    const url = 'https://bucket.s3.us-east-1.amazonaws.com/k?X-Amz-Signature=abc';
    const result = await transport.put(url, { 'content-type': 'audio/mpeg' }, filePath);

    expect(result).toEqual({ status: 200, body: '' });
    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: Record<string, unknown> };
    expect(call.url).toBe(url);
    expect(call.init.method).toBe('PUT');
    expect(call.init.headers).toEqual({ 'content-type': 'audio/mpeg' });
    expect(call.init.duplex).toBe('half');
    // The body is the file, streamed: a readable with the fixture's own bytes, not buffered eagerly.
    const chunks: Buffer[] = [];
    for await (const chunk of call.init.body as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('some audio bytes');
  });

  it('reads the response body as text and reports the status verbatim', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'clip.mp3');
    fs.writeFileSync(filePath, Buffer.from('x'));

    const fake = async () => ({
      status: 403,
      text: async () => '<Error><Code>AccessDenied</Code></Error>',
    });
    const transport = uploadTransport(fake);
    const result = await transport.put('https://bucket.s3.us-east-1.amazonaws.com/k', {}, filePath);

    expect(result).toEqual({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' });
  });

  it('refuses to PUT to a non-public host before the fetch function is ever called', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'clip.mp3');
    fs.writeFileSync(filePath, Buffer.from('x'));

    let called = false;
    const fake = async () => {
      called = true;
      return { status: 200, text: async () => '' };
    };
    const transport = uploadTransport(fake);

    await expect(transport.put('https://127.0.0.1/k', {}, filePath)).rejects.toBeInstanceOf(
      PutUrlError,
    );
    expect(called).toBe(false);
  });
});

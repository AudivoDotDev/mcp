import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpToolError } from './errors.js';
import {
  MIME_CONTENT_TYPES,
  PutUrlError,
  assertPutUrl,
  contentTypeFor,
  inspectAudioFile,
  uploadTransport,
} from './upload.js';

/** A minimal valid WAV: 44-byte RIFF/fmt/data header plus silence, PCM 16-bit mono @ 8 kHz. */
function buildWavFixture(durationSeconds: number): Buffer {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = Math.round(sampleRate * durationSeconds) * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // The rest is already zero-filled silence.
  return buf;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audivo-mcp-upload-'));
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

/**
 * A real audio file on disk for the suites that need one: `upload.test.ts`
 * inspects it, `local-tools.test.ts` and `contract.test.ts` upload it. Every
 * byte is built here rather than checked in, so the fixture's size, hash and
 * duration are all derivable from the arguments.
 *
 * Test support only: excluded from the package build.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A minimal valid WAV: 44-byte RIFF/fmt/data header plus silence, PCM 16-bit mono @ 8 kHz. */
export function buildWavFixture(durationSeconds: number): Buffer {
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

/** A fresh directory under the OS temp root, so two fixtures never collide. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audivo-mcp-upload-'));
}

/** `buildWavFixture`, written to its own directory; returns the absolute path. */
export function writeWavFixture(durationSeconds: number, name = 'fixture.wav'): string {
  const filePath = path.join(tempDir(), name);
  fs.writeFileSync(filePath, buildWavFixture(durationSeconds));
  return filePath;
}

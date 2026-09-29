/**
 * yt-dlp on the caller's machine: which binary is used, how the managed one
 * is installed and verified, what it is asked, and how its answers and its
 * failures are read. Nothing here starts a process or opens a socket: the
 * runner and GitHub are both seams, and the one real file written is the
 * installed binary, into a temp directory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpToolError } from './errors.js';
import {
  YOUTUBE_ENV,
  cacheDirFor,
  downloadArgs,
  errorDetail,
  installYtDlp,
  latestReleaseTag,
  parseChecksums,
  parseDownload,
  parseSearch,
  releaseAssetFor,
  resolveYtDlp,
  searchArgs,
  youtube,
  type InstallerHttp,
  type RunResult,
  type Runner,
  type YoutubeDeps,
} from './youtube.js';

const NODE = '/usr/local/bin/node';
const TAG = '2026.08.19';
const BINARY = Buffer.from('#!/bin/sh\necho yt-dlp\n');
const BINARY_SHA = createHash('sha256').update(BINARY).digest('hex');

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audivo-youtube-test-'));
}

function fakeHttp(
  options: { tag?: string; sums?: string; binary?: Buffer } = {},
): InstallerHttp & { downloads: string[] } {
  const downloads: string[] = [];
  const tag = options.tag ?? TAG;
  return {
    downloads,
    location: async () => `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}`,
    text: async () =>
      options.sums ?? `${BINARY_SHA}  yt-dlp_macos\n${'b'.repeat(64)}  yt-dlp.exe\n`,
    download: async (url, file) => {
      downloads.push(url);
      const body = options.binary ?? BINARY;
      fs.writeFileSync(file, body);
      return createHash('sha256').update(body).digest('hex');
    },
  };
}

function deps(overrides: Partial<YoutubeDeps> = {}): YoutubeDeps {
  const home = overrides.home ?? tempHome();
  return {
    env: { [YOUTUBE_ENV.CACHE_DIR]: path.join(home, 'cache') },
    platform: 'darwin',
    arch: 'arm64',
    musl: false,
    home,
    nodePath: NODE,
    http: fakeHttp(),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    isFile: async (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    ...overrides,
  };
}

describe('platform facts', () => {
  it.each([
    ['darwin', 'arm64', false, 'yt-dlp_macos'],
    ['darwin', 'x64', false, 'yt-dlp_macos'],
    ['linux', 'x64', false, 'yt-dlp_linux'],
    ['linux', 'x64', true, 'yt-dlp_musllinux'],
    ['linux', 'arm64', false, 'yt-dlp_linux_aarch64'],
    ['linux', 'arm64', true, 'yt-dlp_musllinux_aarch64'],
    ['win32', 'x64', false, 'yt-dlp.exe'],
    ['win32', 'arm64', false, 'yt-dlp_arm64.exe'],
    ['win32', 'ia32', false, 'yt-dlp_x86.exe'],
    ['linux', 'ppc64', false, null],
    ['freebsd', 'x64', false, null],
  ] as const)('%s/%s (musl %s) runs %s', (platform, arch, musl, asset) => {
    expect(releaseAssetFor(platform, arch, musl)).toBe(asset);
  });

  it("puts the cache where each platform keeps a user's caches", () => {
    expect(cacheDirFor({}, 'darwin', '/Users/a')).toBe('/Users/a/Library/Caches/audivo-mcp');
    expect(cacheDirFor({}, 'linux', '/home/a')).toBe('/home/a/.cache/audivo-mcp');
    expect(cacheDirFor({ XDG_CACHE_HOME: '/x' }, 'linux', '/home/a')).toBe('/x/audivo-mcp');
    expect(cacheDirFor({ [YOUTUBE_ENV.CACHE_DIR]: '/o' }, 'linux', '/home/a')).toBe('/o');
  });

  it('reads one asset out of a SHA2-256SUMS file', () => {
    const sums = `${'a'.repeat(64)}  yt-dlp\n${'c'.repeat(64)} *yt-dlp_macos\n`;
    expect(parseChecksums(sums, 'yt-dlp_macos')).toBe('c'.repeat(64));
    expect(parseChecksums(sums, 'yt-dlp_linux')).toBeNull();
  });

  it('reads the latest release tag off the redirect', async () => {
    expect(await latestReleaseTag(fakeHttp())).toBe(TAG);
    await expect(latestReleaseTag({ ...fakeHttp(), location: async () => null })).rejects.toThrow();
  });
});

describe('the managed install', () => {
  it('downloads the asset of the tagged release, checks it, and leaves it executable', async () => {
    const d = deps();
    const dir = path.join(d.home, 'bin');
    const installed = await installYtDlp(d, dir, 'yt-dlp_macos', TAG);
    expect(installed).toEqual({ path: path.join(dir, 'yt-dlp_macos'), managed: true, tag: TAG });
    expect(fs.readFileSync(installed.path)).toEqual(BINARY);
    expect(fs.statSync(installed.path).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(`${installed.path}.tag`, 'utf8')).toBe(TAG);
    // One release, both files: the binary and its sums come from the same tag.
    expect((d.http as ReturnType<typeof fakeHttp>).downloads).toEqual([
      `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos`,
    ]);
  });

  it('refuses a binary whose hash is not the release’s, and leaves nothing behind', async () => {
    const d = deps({ http: fakeHttp({ binary: Buffer.from('tampered') }) });
    const dir = path.join(d.home, 'bin');
    await expect(installYtDlp(d, dir, 'yt-dlp_macos', TAG)).rejects.toThrow(/SHA2-256SUMS/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a release that lists no checksum for this platform', async () => {
    const d = deps({ http: fakeHttp({ sums: `${'a'.repeat(64)}  yt-dlp.exe\n` }) });
    await expect(installYtDlp(d, path.join(d.home, 'bin'), 'yt-dlp_macos', TAG)).rejects.toThrow(
      /no checksum/,
    );
  });
});

describe('which yt-dlp is used', () => {
  it('prefers AUDIVO_YTDLP_PATH, then PATH, then the managed copy', async () => {
    const home = tempHome();
    const configured = path.join(home, 'my-yt-dlp');
    const onPathDir = path.join(home, 'path-bin');
    fs.mkdirSync(onPathDir);
    fs.writeFileSync(configured, BINARY);
    fs.writeFileSync(path.join(onPathDir, 'yt-dlp'), BINARY);

    const env = { [YOUTUBE_ENV.CACHE_DIR]: path.join(home, 'cache'), PATH: onPathDir };
    expect(
      await resolveYtDlp(deps({ home, env: { ...env, [YOUTUBE_ENV.YTDLP_PATH]: configured } })),
    ).toEqual({ path: configured, managed: false });
    expect(await resolveYtDlp(deps({ home, env }))).toEqual({
      path: path.join(onPathDir, 'yt-dlp'),
      managed: false,
    });
    const managed = await resolveYtDlp(deps({ home, env: { ...env, PATH: '' } }));
    expect(managed).toMatchObject({ managed: true, tag: TAG });
    // Installed once: a second resolution finds it without GitHub.
    const http = fakeHttp();
    expect(await resolveYtDlp(deps({ home, env: { ...env, PATH: '' }, http }))).toMatchObject({
      path: managed.path,
      managed: true,
      tag: TAG,
    });
    expect(http.downloads).toEqual([]);
  });

  it('refuses a configured path that names nothing', async () => {
    const error = await resolveYtDlp(
      deps({ env: { [YOUTUBE_ENV.YTDLP_PATH]: '/nowhere/yt-dlp', PATH: '' } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolError);
    expect(error).toMatchObject({ code: 'youtube_unavailable' });
  });

  it('names both remedies when there is no binary to install and none installed', async () => {
    const error = await resolveYtDlp(deps({ platform: 'freebsd', env: { PATH: '' } })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'youtube_unavailable' });
    expect((error as Error).message).toContain(YOUTUBE_ENV.YTDLP_PATH);
  });

  it('names both remedies when GitHub cannot be reached', async () => {
    const http: InstallerHttp = {
      ...fakeHttp(),
      location: async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com');
      },
    };
    const error = await resolveYtDlp(deps({ http, env: { PATH: '' } })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'youtube_unavailable' });
    expect((error as Error).message).toContain('ENOTFOUND');
  });
});

describe('what yt-dlp is asked', () => {
  it('puts everything a caller wrote after --, and hands yt-dlp this Node', () => {
    const args = searchArgs('--exec rm -rf ~', 5, NODE);
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(args.slice(separator + 1)).toEqual(['ytsearch5:--exec rm -rf ~']);
    expect(args.slice(0, 2)).toEqual(['--js-runtimes', `node:${NODE}`]);
  });

  it('downloads audio only, from the canonical URL, refusing live and over-long videos', () => {
    const args = downloadArgs('jNQXAC9IVRw', '/tmp/x', NODE);
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(args.at(-2)).toBe('--');
    expect(args).toContain('bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio');
    expect(args).toContain('!is_live & duration <= 36000');
    expect(args).toContain('--no-playlist');
    expect(args).not.toContain('-x');
  });

  it('reads search results and a download off stdout, ignoring anything else', () => {
    const stdout = [
      'some banner',
      JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', duration: 19 }),
      JSON.stringify({ id: 'bad', title: 'not an id' }),
      JSON.stringify('/tmp/x/jNQXAC9IVRw.m4a'),
    ].join('\n');
    expect(parseSearch(stdout)).toEqual([
      { id: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', durationSeconds: 19 },
    ]);
    expect(parseDownload(stdout)).toEqual({
      id: 'jNQXAC9IVRw',
      title: 'Me at the zoo',
      channel: 'jawed',
      durationSeconds: 19,
      file: '/tmp/x/jNQXAC9IVRw.m4a',
    });
    expect(parseDownload('nothing')).toBeNull();
  });

  it('keeps the error line of stderr, printable and bounded', () => {
    const stderr = `[youtube] x: Downloading\nERROR: [youtube] x: Video unavailable\u0007\n`;
    expect(errorDetail(stderr)).toBe('ERROR: [youtube] x: Video unavailable ');
    expect(errorDetail('x'.repeat(1000)).length).toBeLessThanOrEqual(240);
  });
});

describe('running it', () => {
  function recordingRunner(results: RunResult[]): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    const run: Runner = async (binary, args) => {
      calls.push([binary, ...args]);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    };
    return Object.assign(run, { calls });
  }

  const OK_DOWNLOAD: RunResult = {
    code: 0,
    stdout: `${JSON.stringify({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', duration: 19 })}\n${JSON.stringify('/tmp/x/jNQXAC9IVRw.m4a')}\n`,
    stderr: '',
  };

  it('downloads with the binary it resolved', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([OK_DOWNLOAD]);
    const yt = youtube(deps({ home, env: { PATH: home }, run }));
    const downloaded = await yt.download('jNQXAC9IVRw', '/tmp/x');
    expect(downloaded.file).toBe('/tmp/x/jNQXAC9IVRw.m4a');
    expect(run.calls[0]![0]).toBe(path.join(home, 'yt-dlp'));
  });

  it('retries without --js-runtimes for a yt-dlp too old to know it', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([
      { code: 2, stdout: '', stderr: 'yt-dlp: error: no such option: --js-runtimes' },
      OK_DOWNLOAD,
    ]);
    const yt = youtube(deps({ home, env: { PATH: home }, run }));
    await yt.download('jNQXAC9IVRw', '/tmp/x');
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]).not.toContain('--js-runtimes');
  });

  it('says why a download failed, in yt-dlp’s own words', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([
      { code: 1, stdout: '', stderr: 'ERROR: [youtube] jNQXAC9IVRw: Private video' },
    ]);
    const yt = youtube(deps({ home, env: { PATH: home }, run }));
    const error = await yt.download('jNQXAC9IVRw', '/tmp/x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'youtube_failed', retryable: true });
    expect((error as Error).message).toContain('Private video');
  });

  it('says a skipped video was live or too long, and not to retry', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([{ code: 0, stdout: '', stderr: '' }]);
    const yt = youtube(deps({ home, env: { PATH: home }, run }));
    const error = await yt.download('jNQXAC9IVRw', '/tmp/x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'youtube_failed', retryable: false });
  });

  it('updates a managed binary that is behind the latest release, once, and retries', async () => {
    const home = tempHome();
    const env = { [YOUTUBE_ENV.CACHE_DIR]: path.join(home, 'cache'), PATH: '' };
    // An old install, as a previous session left it.
    const d0 = deps({ home, env, http: fakeHttp({ tag: '2026.01.01' }) });
    await resolveYtDlp(d0);
    const run = recordingRunner([
      { code: 1, stdout: '', stderr: 'ERROR: [youtube] nsig extraction failed' },
      OK_DOWNLOAD,
    ]);
    const http = fakeHttp({ tag: TAG });
    const yt = youtube(deps({ home, env, http, run }));
    await yt.download('jNQXAC9IVRw', '/tmp/x');
    expect(run.calls).toHaveLength(2);
    expect(http.downloads).toHaveLength(1);
    const binDir = path.join(home, 'cache', 'bin');
    expect(fs.readFileSync(path.join(binDir, 'yt-dlp_macos.tag'), 'utf8')).toBe(TAG);
  });

  it('never updates a yt-dlp the user installed', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([{ code: 1, stdout: '', stderr: 'ERROR: broken' }]);
    const http = fakeHttp();
    const yt = youtube(deps({ home, env: { PATH: home }, run, http }));
    await expect(yt.download('jNQXAC9IVRw', '/tmp/x')).rejects.toMatchObject({
      code: 'youtube_failed',
    });
    expect(run.calls).toHaveLength(1);
    expect(http.downloads).toEqual([]);
  });

  it('searches and returns what it found', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'yt-dlp'), BINARY);
    const run = recordingRunner([
      {
        code: 0,
        stdout: `${JSON.stringify({ id: '9PxxtJVWRrg', title: 'Costco (Audio)', channel: 'Acquired', duration: 10894 })}\n`,
        stderr: '',
      },
    ]);
    const yt = youtube(deps({ home, env: { PATH: home }, run }));
    expect(await yt.search('acquired costco', 3)).toEqual([
      { id: '9PxxtJVWRrg', title: 'Costco (Audio)', channel: 'Acquired', durationSeconds: 10894 },
    ]);
    expect(run.calls[0]).toContain('ytsearch3:acquired costco');
  });
});

/**
 * YouTube, on the caller's machine: finding yt-dlp, installing it when it is
 * not there, and running the two things this server asks of it — a search, and
 * an audio-only download.
 *
 * Only the local stdio server loads this module. Nothing Audivo hosts fetches
 * from YouTube: the hosted server recognises a YouTube link (`youtube-url.ts`)
 * only to refuse it with the way here.
 *
 * ## Where yt-dlp comes from
 *
 * In order: `AUDIVO_YTDLP_PATH`; a `yt-dlp` on `PATH`; or the project's own
 * standalone release binary for this platform, downloaded once into the user's
 * cache directory and checked against the same release's `SHA2-256SUMS` before
 * it is made executable. The package has no install script — `npx` never runs
 * anything a user did not ask for — so the download happens at the first
 * YouTube call and not before. The checksum comes from the release that
 * published the binary: it catches a corrupted or truncated download, not a
 * compromised release, and nothing here claims otherwise.
 *
 * YouTube changes break old yt-dlp releases within weeks, so a managed binary
 * that fails is compared with the latest release once, replaced if it is
 * older, and the call retried. A yt-dlp the user installed is theirs and is
 * never touched.
 *
 * ## How it is run
 *
 * `spawn` with an argument array, never a shell. What a caller supplied
 * reaches yt-dlp only after `--`, and a video is always named by
 * `canonicalYoutubeUrl` of its id, so nothing a model writes can become an
 * option. yt-dlp needs a JavaScript runtime for YouTube today; it is handed the
 * Node that is running this server, which is always there.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch } from 'undici';
import { localError } from './errors.js';
import { canonicalYoutubeUrl } from './youtube-url.js';

/** Every variable this module reads. */
export const YOUTUBE_ENV = {
  /** A yt-dlp binary to use instead of one found on `PATH` or managed here. */
  YTDLP_PATH: 'AUDIVO_YTDLP_PATH',
  /** Where the managed binary lives; the platform's user cache directory otherwise. */
  CACHE_DIR: 'AUDIVO_CACHE_DIR',
} as const;

export const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';

/** The standalone binaries are about 40 MB; four times that is a download gone wrong. */
export const MAX_BINARY_BYTES = 160 * 1024 * 1024;

/** The longest audio an upload may declare (the contract's bound), as yt-dlp's filter reads it. */
const MAX_DURATION_SECONDS = 36_000;

export const SEARCH_TIMEOUT_MS = 60_000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** How much of yt-dlp's stderr is ever kept: its last error line is what matters. */
const STDERR_KEEP_CHARS = 16_384;
const STDOUT_KEEP_CHARS = 4 * 1024 * 1024;
const ERROR_DETAIL_CHARS = 240;

// --- Platform facts --------------------------------------------------------------------

/** The release asset that runs here without Python, or `null` where the project ships none. */
export function releaseAssetFor(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string | null {
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    if (arch === 'x64') return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
    if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'yt-dlp.exe';
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
  }
  return null;
}

/** Whether this Linux runs on musl rather than glibc; Node's own report says which libc it loaded. */
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** The user cache directory, as each platform names it. */
export function cacheDirFor(env: Env, platform: NodeJS.Platform, home: string): string {
  const override = env[YOUTUBE_ENV.CACHE_DIR]?.trim();
  if (override !== undefined && override !== '') return override;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'audivo-mcp');
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'audivo-mcp', 'Cache');
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache'), 'audivo-mcp');
}

/** The expected digest of one asset in a `SHA2-256SUMS` file, or `null` if it is not listed. */
export function parseChecksums(text: string, asset: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match !== null && match[2] === asset) return match[1]!.toLowerCase();
  }
  return null;
}

// --- The seams -------------------------------------------------------------------------

/** The two HTTP shapes the installer needs; undici in production, a fake in the suites. */
export type InstallerHttp = {
  /** A GET whose redirect is reported, not followed: how the latest release's tag is read. */
  location(url: string): Promise<string | null>;
  text(url: string): Promise<string>;
  /** Streams a body to `file`, refusing past `maxBytes`, and answers its SHA-256 in hex. */
  download(url: string, file: string, maxBytes: number): Promise<string>;
};

export type RunResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** One run of a binary with an argument array. */
export type Runner = (
  binary: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<RunResult>;

export type YoutubeDeps = {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly musl: boolean;
  readonly home: string;
  /** The Node running this server, handed to yt-dlp as its JavaScript runtime. */
  readonly nodePath: string;
  readonly http: InstallerHttp;
  readonly run: Runner;
  /** Whether a path names a regular file; `stat`, in production. */
  readonly isFile: (path: string) => Promise<boolean>;
};

// --- Resolving the binary --------------------------------------------------------------

export type YtDlpBinary = {
  readonly path: string;
  /** Installed here, and therefore ours to update. */
  readonly managed: boolean;
  /** The release a managed binary came from. */
  readonly tag?: string;
};

async function findOnPath(deps: YoutubeDeps): Promise<string | null> {
  const names = deps.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'];
  for (const dir of (deps.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (await deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The latest release's tag, read from where GitHub redirects `/releases/latest`. */
export async function latestReleaseTag(http: InstallerHttp): Promise<string> {
  const location = await http.location(`${YTDLP_RELEASES}/latest`);
  const tag = location === null ? null : /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
  if (tag === undefined || tag === null) {
    throw new Error('GitHub did not name the latest yt-dlp release');
  }
  return decodeURIComponent(tag);
}

/** Downloads, verifies and installs one release's binary for this platform. */
export async function installYtDlp(
  deps: YoutubeDeps,
  dir: string,
  asset: string,
  tag: string,
): Promise<YtDlpBinary> {
  await mkdir(dir, { recursive: true });
  const sums = await deps.http.text(`${YTDLP_RELEASES}/download/${tag}/SHA2-256SUMS`);
  const expected = parseChecksums(sums, asset);
  if (expected === null) throw new Error(`release ${tag} lists no checksum for ${asset}`);
  const partial = join(dir, `.${asset}.${randomBytes(6).toString('hex')}.part`);
  try {
    const actual = await deps.http.download(
      `${YTDLP_RELEASES}/download/${tag}/${asset}`,
      partial,
      MAX_BINARY_BYTES,
    );
    if (actual !== expected) {
      throw new Error(`the downloaded ${asset} does not match release ${tag}'s SHA2-256SUMS`);
    }
    await chmod(partial, 0o755);
    const target = join(dir, asset);
    await rename(partial, target);
    await writeFile(`${target}.tag`, tag);
    return { path: target, managed: true, tag };
  } finally {
    await rm(partial, { force: true });
  }
}

/** yt-dlp as this machine has it, installing the managed copy if there is no other. */
export async function resolveYtDlp(deps: YoutubeDeps): Promise<YtDlpBinary> {
  const configured = deps.env[YOUTUBE_ENV.YTDLP_PATH]?.trim();
  if (configured !== undefined && configured !== '') {
    if (!(await deps.isFile(configured))) {
      throw localError(
        'youtube_unavailable',
        `${YOUTUBE_ENV.YTDLP_PATH} does not name a file; point it at yt-dlp, or unset it`,
      );
    }
    return { path: configured, managed: false };
  }
  const onPath = await findOnPath(deps);
  if (onPath !== null) return { path: onPath, managed: false };

  const asset = releaseAssetFor(deps.platform, deps.arch, deps.musl);
  if (asset === null) {
    throw localError(
      'youtube_unavailable',
      `yt-dlp publishes no standalone binary for ${deps.platform}/${deps.arch}; install yt-dlp ` +
        `and put it on PATH, or set ${YOUTUBE_ENV.YTDLP_PATH}`,
    );
  }
  const dir = join(cacheDirFor(deps.env, deps.platform, deps.home), 'bin');
  const installed = join(dir, asset);
  if (await deps.isFile(installed)) {
    const tag = await readFile(`${installed}.tag`, 'utf8').then(
      (text) => text.trim(),
      () => undefined,
    );
    return { path: installed, managed: true, ...(tag === undefined ? {} : { tag }) };
  }
  try {
    return await installYtDlp(deps, dir, asset, await latestReleaseTag(deps.http));
  } catch (error) {
    throw localError(
      'youtube_unavailable',
      `yt-dlp is not installed and could not be fetched from GitHub (${
        error instanceof Error ? error.message : String(error)
      }); install yt-dlp and put it on PATH, or set ${YOUTUBE_ENV.YTDLP_PATH}`.slice(0, 600),
      { cause: error },
    );
  }
}

// --- Running it ------------------------------------------------------------------------

/** A video as a search found it: identifiers trusted, the rest the uploader's. */
export type YoutubeVideo = {
  readonly id: string;
  readonly title: string;
  readonly channel: string | null;
  readonly durationSeconds: number | null;
};

/** What a download left on disk. */
export type YoutubeDownload = YoutubeVideo & { readonly file: string };

function runtimeArgs(nodePath: string): string[] {
  return ['--js-runtimes', `node:${nodePath}`];
}

export function searchArgs(query: string, limit: number, nodePath: string): string[] {
  return [
    ...runtimeArgs(nodePath),
    '--flat-playlist',
    '--no-warnings',
    '--print',
    '%(.{id,title,channel,duration})j',
    '--',
    `ytsearch${limit}:${query}`,
  ];
}

export function downloadArgs(videoId: string, dir: string, nodePath: string): string[] {
  return [
    ...runtimeArgs(nodePath),
    // Audio only, in a container the upload takes as it is: no ffmpeg.
    '-f',
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--no-playlist',
    '--no-progress',
    '--no-warnings',
    '--no-simulate',
    '--match-filter',
    `!is_live & duration <= ${MAX_DURATION_SECONDS}`,
    '--max-filesize',
    '5G',
    '-o',
    join(dir, '%(id)s.%(ext)s'),
    '--print',
    '%(.{id,title,channel,duration})j',
    '--print',
    'after_move:%(filepath)j',
    '--',
    canonicalYoutubeUrl(videoId),
  ];
}

function asVideo(value: unknown): YoutubeVideo | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(record.id)) return null;
  return {
    id: record.id,
    title: typeof record.title === 'string' ? record.title : '',
    channel: typeof record.channel === 'string' ? record.channel : null,
    durationSeconds:
      typeof record.duration === 'number' && Number.isFinite(record.duration)
        ? record.duration
        : null,
  };
}

function jsonLines(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // Not ours: a line yt-dlp printed for some other reason.
    }
  }
  return values;
}

export function parseSearch(stdout: string): YoutubeVideo[] {
  return jsonLines(stdout)
    .map(asVideo)
    .filter((video): video is YoutubeVideo => video !== null);
}

export function parseDownload(stdout: string): YoutubeDownload | null {
  const values = jsonLines(stdout);
  const video = values.map(asVideo).find((value) => value !== null) ?? null;
  const file = values.find((value): value is string => typeof value === 'string');
  return video === null || file === undefined ? null : { ...video, file };
}

/**
 * The line of yt-dlp's stderr that says what went wrong, stripped of anything
 * that is not printable. It can quote YouTube's own reason ("This video is
 * private"), which is the useful part.
 */
export function errorDetail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  const error = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  const chosen = error ?? [...lines].reverse().find((line) => line !== '') ?? 'no output';
  // eslint-disable-next-line no-control-regex
  return chosen.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, ERROR_DETAIL_CHARS);
}

/** Old yt-dlp releases do not know `--js-runtimes`; they also do not need it. */
function unknownRuntimeOption(result: RunResult): boolean {
  return result.code !== 0 && /no such option:?\s*--js-runtimes/i.test(result.stderr);
}

export type Youtube = {
  search(query: string, limit: number, signal?: AbortSignal): Promise<YoutubeVideo[]>;
  /** Downloads one video's audio into `dir`, which the caller owns and removes. */
  download(videoId: string, dir: string, signal?: AbortSignal): Promise<YoutubeDownload>;
};

export function youtube(deps: YoutubeDeps): Youtube {
  let resolved: Promise<YtDlpBinary> | undefined;
  const binary = (): Promise<YtDlpBinary> => {
    resolved ??= resolveYtDlp(deps).catch((error: unknown) => {
      resolved = undefined;
      throw error;
    });
    return resolved;
  };

  async function runWith(
    bin: YtDlpBinary,
    args: string[],
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<RunResult> {
    const result = await deps.run(bin.path, args, options);
    if (!unknownRuntimeOption(result)) return result;
    return deps.run(bin.path, args.slice(runtimeArgs(deps.nodePath).length), options);
  }

  /**
   * Once per call: a managed binary that failed is compared with the latest
   * release, and replaced and retried if it is behind. YouTube breaking an
   * old yt-dlp is the common failure, and the one this fixes.
   */
  async function runFresh(
    args: string[],
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
    succeeded: (result: RunResult) => boolean,
  ): Promise<RunResult> {
    const bin = await binary();
    const first = await runWith(bin, args, options);
    if (succeeded(first) || !bin.managed || options.signal?.aborted === true) return first;
    let latest: string;
    try {
      latest = await latestReleaseTag(deps.http);
    } catch {
      return first;
    }
    if (bin.tag === latest) return first;
    const asset = releaseAssetFor(deps.platform, deps.arch, deps.musl);
    if (asset === null) return first;
    const dir = join(cacheDirFor(deps.env, deps.platform, deps.home), 'bin');
    const updated = await installYtDlp(deps, dir, asset, latest).catch(() => null);
    if (updated === null) return first;
    resolved = Promise.resolve(updated);
    return runWith(updated, args, options);
  }

  return {
    async search(query, limit, signal) {
      const result = await runFresh(
        searchArgs(query, limit, deps.nodePath),
        { timeoutMs: SEARCH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        (run) => run.code === 0,
      );
      if (result.code !== 0) {
        throw localError(
          'youtube_failed',
          `yt-dlp could not search YouTube: ${errorDetail(result.stderr)}`,
        );
      }
      return parseSearch(result.stdout);
    },
    async download(videoId, dir, signal) {
      const result = await runFresh(
        downloadArgs(videoId, dir, deps.nodePath),
        { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        (run) => run.code === 0 && parseDownload(run.stdout) !== null,
      );
      const downloaded = result.code === 0 ? parseDownload(result.stdout) : null;
      if (downloaded !== null) return downloaded;
      if (result.code === 0) {
        // yt-dlp ran and skipped the video: the match filter refused it.
        throw localError(
          'youtube_failed',
          `yt-dlp skipped ${videoId}: it is live, or longer than ${MAX_DURATION_SECONDS / 3600} hours`,
          { retryable: false },
        );
      }
      throw localError(
        'youtube_failed',
        `yt-dlp could not download ${videoId}: ${errorDetail(result.stderr)}`,
      );
    },
  };
}

// --- Production seams ------------------------------------------------------------------

/** `spawn`, no shell, with output capped and the child killed on timeout or cancellation. */
export const spawnRunner: Runner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_KEEP_CHARS) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP_CHARS);
    });
    const kill = (): void => {
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        localError('youtube_unavailable', `yt-dlp could not be started: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr });
    });
  });

/** A stream stage that hashes what passes and refuses past a byte ceiling. */
function hashingLimit(maxBytes: number, hash: ReturnType<typeof createHash>): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) {
        done(new Error(`the download ran past ${maxBytes} bytes`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
}

/** GitHub, over the same pinned undici the API calls use. */
export const undiciInstallerHttp: InstallerHttp = {
  async location(url) {
    const response = await undiciFetch(url, { method: 'GET', redirect: 'manual' });
    await response.body?.cancel();
    return response.headers.get('location');
  },
  async text(url) {
    const response = await undiciFetch(url, { redirect: 'follow' });
    if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  },
  async download(url, file, maxBytes) {
    const response = await undiciFetch(url, { redirect: 'follow' });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`the yt-dlp download answered ${response.status}`);
    }
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(response.body as never),
      hashingLimit(maxBytes, hash),
      createWriteStream(file, { mode: 0o600 }),
    );
    return hash.digest('hex');
  },
};

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The production wiring, from this process's own facts. */
export function youtubeFromProcess(env: Env = process.env): Youtube {
  return youtube({
    env,
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
    home: homedir(),
    nodePath: process.execPath,
    http: undiciInstallerHttp,
    run: spawnRunner,
    isFile: isRegularFile,
  });
}

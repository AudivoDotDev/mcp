/**
 * Recognising a YouTube video link, and nothing else.
 *
 * Pure parsing with no I/O, so the hosted server can load it: that is how a
 * YouTube link sent to the hosted `transcribe` is refused with the way to the
 * local server instead of reaching the API as an unsupported URL. Everything
 * that runs yt-dlp lives in `youtube.ts`, which only the local server loads.
 *
 * What goes to yt-dlp is never the caller's URL, only `canonicalYoutubeUrl` of
 * the eleven-character id taken out of it: no playlist parameter, no start
 * time, no second site, and nothing that could read as an option.
 */

/** Every host a YouTube video link is written under. */
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOST = 'youtu.be';

/** A video id: eleven characters of YouTube's URL-safe base64. */
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** The path forms that carry the id as their second segment. */
const ID_PATH_PREFIXES: ReadonlySet<string> = new Set(['shorts', 'live', 'embed', 'v', 'e']);

/**
 * The video id a link names, or `null` when it is not a YouTube video link at
 * all — a channel, a playlist without a video, another site, or not a URL.
 */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  let candidate: string | undefined;
  if (host === SHORT_HOST) {
    candidate = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') candidate = parsed.searchParams.get('v') ?? undefined;
    else if (segments[0] !== undefined && ID_PATH_PREFIXES.has(segments[0])) {
      candidate = segments[1];
    }
  } else {
    return null;
  }
  return candidate !== undefined && YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

/** The one URL form handed to yt-dlp. */
export function canonicalYoutubeUrl(videoId: string): string {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error('not a YouTube video id');
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

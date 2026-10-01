/**
 * The Audivo app (ADR-0036): one MCP App resource, the metadata that ties
 * tools to it, and the views those tools hand it.
 *
 * The resource is a single self-contained HTML document (`app-html.ts`,
 * built from `ui/` by `scripts/build-ui.ts`): script and styles inline, no
 * network, so its content security policy declares nothing. The host fetches
 * it once per URI and caches it, which is why the URI carries a version: a
 * change the old document could not read is a new URI.
 *
 * Two tools render it. `transcribe` shows the reader, and `list_transcripts`
 * shows the library and is the entrypoint ChatGPT offers in its sidebar and
 * beside a conversation. Others (`read_transcript`, `search_shows`,
 * `list_episodes`) only carry view data, for the app to call as it pages
 * and searches; a model calling them draws nothing.
 */
import type { Icon, McpServer } from '@modelcontextprotocol/server';
import type {
  CanonicalTranscript,
  ChartResponse,
  EpisodesListResponse,
  JobGroupMember,
  ShowSearchResponse,
  TranscriptJobResponse,
  TranscriptRead,
  TranscriptReadResponse,
} from './api-client.js';
import { APP_HTML } from './app-html.js';
import { pageOf } from './render.js';
import type {
  EpisodesView,
  LibraryItem,
  ShowsView,
  TranscriptRef,
  TranscriptView,
  ViewPage,
} from './view.js';

/** The app's address. Bump the version when the view stops reading what an older server sends. */
export const APP_URI = 'ui://audivo/app-v1.html';

/** The MCP Apps media type: HTML that speaks the app protocol. */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * ChatGPT's dedicated origin for the app, under OpenAI's own key: the
 * standard `ui.domain` is host-specific in format, and one resource serves
 * every host (ADR-0036 decision 3).
 */
export const APP_WIDGET_DOMAIN = 'https://audivo.dev';

/** The one scope the authorization server grants (ADR-0035). */
export const OAUTH_SCOPE = 'transcripts';

/**
 * The entrypoint icon: monochrome, transparent, `currentColor`, a 20-pixel
 * grid with 1.33-pixel strokes, as OpenAI's icon guidelines ask. A waveform
 * beside two lines of text: audio becoming a transcript.
 */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" ' +
  'stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 8.5v3M5.75 6v8M8.5 4v12M11.25 7.5v5"/><path d="M14 8.5h3M14 11.5h3"/></svg>';

export const APP_ICON: Icon = {
  src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`,
  mimeType: 'image/svg+xml',
  sizes: ['any'],
};

/** `_meta` for a tool whose result the host renders with the app. */
export function rendersApp(): Record<string, unknown> {
  return {
    ui: { resourceUri: APP_URI },
    // ChatGPT's own key for the same thing, read by older integrations.
    'openai/outputTemplate': APP_URI,
  };
}

/** `_meta` for the tool ChatGPT also offers in its sidebar and as a tab beside a conversation. */
export function entrypoints(): Record<string, unknown> {
  return { 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } };
}

/** `_meta` for the short status ChatGPT shows while a tool runs and when it is done (at most 64 characters). */
export function statusText(invoking: string, invoked: string): Record<string, unknown> {
  return {
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
  };
}

/**
 * `_meta` declaring that a tool needs a signed-in account (OpenAI's
 * `securitySchemes`, in the `_meta` mirror the SDK can carry). Hosted
 * server only: the local server is signed in by its environment's key.
 */
export function needsSignIn(): Record<string, unknown> {
  return { securitySchemes: [{ type: 'oauth2', scopes: [OAUTH_SCOPE] }] };
}

/** Registers the app resource on a server. Hosted and local alike: a client without MCP Apps never reads it. */
export function registerApp(server: McpServer, html: string = APP_HTML): void {
  server.registerResource(
    'audivo-app',
    APP_URI,
    {
      title: 'Audivo transcripts',
      description: 'A transcript reader and the account’s transcript library.',
      mimeType: APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME_TYPE,
          text: html,
          _meta: {
            // No domains of any kind: everything arrives through tool calls.
            ui: { csp: {}, prefersBorder: true },
            'openai/widgetDomain': APP_WIDGET_DOMAIN,
            'openai/widgetDescription':
              'Shows the transcript, or the list of transcripts, the user asked for. ' +
              'The user can read and search it here; no need to repeat it.',
            'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          },
        },
      ],
    }),
  );
}

// --- Views -------------------------------------------------------------------------------

function pageView(transcript: CanonicalTranscript, pageStart: number, budget: number): ViewPage {
  const page = pageOf(transcript, pageStart, budget);
  return {
    page_start: page.page_start,
    segments: transcript.segments
      .slice(page.page_start, page.page_start + page.segments_included)
      .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text })),
    segments_total: page.segments_total,
    next_page_start: page.next_segment,
  };
}

const NO_TRANSCRIPT = {
  duration_sec: null,
  language: null,
  page: null,
  oversized: false,
  error: null,
  progress_percent: null,
} as const;

/** A job, as the reader shows it: still running, ended without a transcript, or one page of it. */
export function jobView(
  body: TranscriptJobResponse,
  options: { readonly pageStart: number; readonly budgetChars: number; readonly jobId: string },
): TranscriptView {
  const ref: TranscriptRef = { job_id: options.jobId };
  if (!('job_id' in body)) {
    // Above the inline limit, answered with a reference and nothing else.
    return {
      kind: 'transcript',
      ref,
      episode_id: null,
      show_title: null,
      episode_title: null,
      status: 'completed',
      credits: null,
      credits_kind: null,
      ...NO_TRANSCRIPT,
      oversized: true,
    };
  }
  const settled = body.status === 'completed' && body.settled_credits !== undefined;
  const transcript = body.artifact?.transcript;
  return {
    kind: 'transcript',
    ref,
    episode_id: body.episode_id,
    show_title: body.show_title,
    episode_title: body.episode_title,
    status: body.status,
    credits: settled ? body.settled_credits! : body.reserved_credits,
    credits_kind: settled ? 'settled' : 'reserved',
    ...NO_TRANSCRIPT,
    progress_percent: body.progress?.percent ?? null,
    error: body.error?.message ?? null,
    ...(transcript === undefined
      ? { oversized: body.status === 'completed' && body.artifact?.transcript_url !== undefined }
      : {
          duration_sec: transcript.duration_sec,
          language: transcript.language,
          page: pageView(transcript, options.pageStart, options.budgetChars),
        }),
  };
}

/** A read already paid for: a cache hit, or a group's cached member. */
export function readView(
  body: TranscriptRead | TranscriptReadResponse,
  options: { readonly pageStart: number; readonly budgetChars: number; readonly readId?: string },
): TranscriptView | undefined {
  const readId = options.readId ?? ('read_id' in body ? body.read_id : undefined);
  if (readId === undefined) return undefined;
  const transcript = 'transcript' in body ? body.transcript : undefined;
  return {
    kind: 'transcript',
    ref: { read_id: readId },
    episode_id: transcript?.episode_id ?? null,
    show_title: 'show_title' in body ? body.show_title : null,
    episode_title: 'episode_title' in body ? body.episode_title : null,
    status: 'cached',
    credits: 'credits_charged' in body ? body.credits_charged : null,
    credits_kind: 'charged',
    ...NO_TRANSCRIPT,
    ...(transcript === undefined
      ? { oversized: true }
      : {
          duration_sec: transcript.duration_sec,
          language: transcript.language,
          page: pageView(transcript, options.pageStart, options.budgetChars),
        }),
  };
}

/** A job that has not been polled yet: what `transcribe` knows the moment it is accepted. */
export function acceptedView(accepted: {
  readonly job_id: string;
  readonly status: string;
  readonly episode_id: string;
  readonly reserved_credits: number;
}): TranscriptView {
  return {
    kind: 'transcript',
    ref: { job_id: accepted.job_id },
    episode_id: accepted.episode_id,
    show_title: null,
    episode_title: null,
    status: accepted.status,
    credits: accepted.reserved_credits,
    credits_kind: 'reserved',
    ...NO_TRANSCRIPT,
  };
}

/** One group member, as a library row. */
export function libraryItem(member: JobGroupMember): LibraryItem {
  if (member.kind === 'cached_read') {
    return {
      ref: { read_id: member.read_id },
      episode_id: member.episode_id,
      show_title: member.show_title,
      episode_title: member.episode_title,
      status: 'cached',
      created_at: member.created_at,
      credits: member.credits_charged,
    };
  }
  return {
    ref: { job_id: member.job_id },
    episode_id: member.episode_id,
    show_title: member.show_title,
    episode_title: member.episode_title,
    status: member.status,
    created_at: member.created_at,
    credits: member.settled_credits ?? member.reserved_credits,
  };
}

export function showsView(response: ShowSearchResponse | ChartResponse): ShowsView {
  return {
    kind: 'shows',
    shows: response.data.map((show) => ({
      show_id: show.show_id,
      feed_url: show.feed_url,
      itunes_id: show.itunes_id,
      title: show.title,
      author: show.author,
    })),
  };
}

export function episodesView(showId: string, response: EpisodesListResponse): EpisodesView {
  return {
    kind: 'episodes',
    show_id: showId,
    episodes: response.data.map((episode) => ({
      episode_id: episode.episode_id,
      title: episode.title,
      published_at: episode.published_at,
      duration_sec: episode.duration_sec ?? null,
      is_cached: episode.is_cached === true,
      estimated_credits: episode.estimated_credits ?? null,
    })),
    next_cursor: response.next_cursor,
  };
}

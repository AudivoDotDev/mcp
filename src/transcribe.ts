/**
 * `transcribe`: one episode, one call, and the transcript back.
 *
 * This is the default way in. It makes the API's single-episode submit —
 * `POST /v1/transcripts`, no quote first — and then waits on the job, inside
 * whatever time the host allows a tool call, so a model that asks for a
 * transcript gets one: at once for an episode already transcribed, within the
 * call for a short fresh one, or as a job handle `read_transcript` keeps
 * waiting on. The transcript comes back a page at a time (`TRANSCRIPT_PAGE_CHARS`),
 * with the exact call that returns the next page.
 *
 * Spend is bounded by the API, not by a ritual: the job holds its ceiling and
 * settles at the measured audio, and `max_credits` refuses any call that could
 * take more before anything is held. The quote-and-confirm pair stays for
 * selections of many episodes, where seeing the total first is worth a turn.
 *
 * The idempotency key is derived from the request body, not drawn at random.
 * A host that retries a timed-out call, or a model that asks for the same
 * episode twice, therefore gets the original job back rather than a second
 * one; and a cached episode's later pages are read by repeating the call with
 * `page_start`, which the API answers as a replay and charges nothing for.
 * A replay of a job that has since failed is the one repeat not wanted, so
 * that case is resubmitted once under a fresh key.
 *
 * The hosted server and the local one build this tool from the same factory.
 * The local server passes `LocalSources` — a file path, and a YouTube link it
 * downloads on the caller's machine — which widen the input schema; the hosted
 * one passes nothing, and a YouTube link there is refused with the way to the
 * local server, because nothing Audivo hosts fetches from YouTube.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import * as z from 'zod';
import type {
  ApiCall,
  TranscriptCreateRequest,
  TranscriptJobAccepted,
  TranscriptJobResponse,
} from './api-client.js';
import { localError } from './errors.js';
import {
  TRANSCRIPT_PAGE_CHARS,
  deliverJobPage,
  isTerminal,
  referenceFor,
  transcriptPage,
  untrustedBlock,
  type Document,
} from './render.js';
import {
  defineTool,
  requireCredential,
  type AnyToolDefinition,
  type ToolContext,
} from './tool-kit.js';
import { acceptedView, jobView, readView, rendersApp, statusText } from './app.js';
import { youtubeVideoId } from './youtube-url.js';

// --- Waiting on a job ------------------------------------------------------------------

/**
 * How long a tool may wait on a job, and how often it looks.
 *
 * `budgetMs` is the ceiling on the whole tool call whatever was asked for: on
 * the hosted server that is API Gateway's 29-second integration limit less the
 * submit that came before and a margin to answer in. `maxSeconds` bounds what a
 * caller may ask to wait; `defaultSeconds` is what it gets by not asking.
 */
export type WaitPolicy = {
  readonly defaultSeconds: number;
  readonly maxSeconds: number;
  readonly pollIntervalMs: number;
  readonly budgetMs: number;
};

/**
 * Behind the edge: the whole call must answer inside the gateway's 29 s. A
 * fresh episode takes a minute or two, so the hosted answer to a miss is
 * usually the job handle, and `read_transcript` waits the rest in slices.
 */
export const HOSTED_WAIT: WaitPolicy = {
  defaultSeconds: 20,
  maxSeconds: 20,
  pollIntervalMs: 3_000,
  budgetMs: 24_000,
};

/**
 * On the caller's machine there is no gateway: the ceiling is the client's own
 * request timeout, which is commonly sixty seconds and is reset by progress
 * notifications where the client supports them. The default stays under the
 * common ceiling; a caller whose client resets on progress may ask for more.
 */
export const LOCAL_WAIT: WaitPolicy = {
  defaultSeconds: 50,
  maxSeconds: 900,
  pollIntervalMs: 5_000,
  budgetMs: Number.POSITIVE_INFINITY,
};

/** The schema's own bound on `wait_seconds`; a policy clamps it further. */
const MAX_WAIT_SECONDS = 900;

/**
 * Polls one job until it ends, or until the time this call may spend is gone.
 * The first look is after one interval: a job the API has just accepted is
 * queued, and asking at once only spends a request to learn that.
 */
export async function waitForJob(
  call: ApiCall,
  ctx: ToolContext,
  jobId: string,
  options: {
    readonly waitSeconds: number | undefined;
    /** When the tool call began, for the policy's overall budget. */
    readonly startedAt: number;
    /** What is known already; answered as-is if there is no time to look again. */
    readonly initial?: TranscriptJobResponse;
  },
): Promise<TranscriptJobResponse | undefined> {
  const policy = ctx.wait;
  const asked = Math.min(
    Math.max(options.waitSeconds ?? policy.defaultSeconds, 0),
    policy.maxSeconds,
  );
  const deadline = Math.min(options.startedAt + policy.budgetMs, ctx.now() + asked * 1000);
  let latest = options.initial;
  if (latest === undefined && ctx.now() + policy.pollIntervalMs > deadline) {
    // No time to wait a full interval, but a look costs one request and is
    // worth more to a caller than a guess.
    return ctx.api.getTranscriptJob(call, jobId);
  }
  while (ctx.now() + policy.pollIntervalMs <= deadline) {
    if (ctx.signal?.aborted === true) break;
    if (ctx.progress !== undefined && latest !== undefined && 'job_id' in latest) {
      await ctx.progress(
        Math.round((ctx.now() - options.startedAt) / 1000),
        asked,
        `job ${jobId} is ${latest.status}`,
      );
    }
    await ctx.sleep(policy.pollIntervalMs, ctx.signal);
    latest = await ctx.api.getTranscriptJob(call, jobId);
    if (!('job_id' in latest) || isTerminal(latest.status)) return latest;
  }
  return latest;
}

// --- The request ----------------------------------------------------------------------

/**
 * The idempotency key a request body earns: the same body, the same key, so
 * the API answers a repeat with the original. The body is canonicalised by
 * sorted keys first — two spellings of one request must not be two jobs.
 */
export function idempotencyKeyFor(body: TranscriptCreateRequest): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `mcp-transcribe-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

/**
 * What the local server adds: two sources a process on the caller's machine
 * can read and a Lambda cannot. Each ends as an upload of this account's, which
 * the submit then takes as `upload_id` like any other.
 */
export type LocalSources = {
  /** Announce and PUT a file on this disk. */
  uploadFile(
    call: ApiCall,
    ctx: ToolContext,
    path: string,
  ): Promise<{ readonly uploadId: string; readonly title: string | null }>;
  /** Download a YouTube video's audio with yt-dlp, then announce and PUT it. */
  uploadYoutube(
    call: ApiCall,
    ctx: ToolContext,
    videoId: string,
  ): Promise<{ readonly uploadId: string; readonly title: string }>;
};

const EPISODE_ID_PATTERN = /^ep_[a-z2-7]{16}$/;
const UPLOAD_ID_PATTERN = /^upl_[A-Za-z0-9]{16,32}$/;
const MAX_URL_LENGTH = 2048;
const MAX_GUID_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;

/** The tool's arguments, whichever server built it; `path` exists on the local one only. */
type TranscribeArgs = {
  readonly url?: string;
  readonly feed_url?: string;
  readonly guid?: string;
  readonly episode_id?: string;
  readonly upload_id?: string;
  readonly path?: string;
  readonly max_credits?: number;
  readonly wait_seconds?: number;
  readonly page_start?: number;
};

const HOSTED_YOUTUBE_MESSAGE =
  'YouTube links are transcribed by the local server only (npx -y @audivo/mcp), which downloads ' +
  "the audio on the caller's machine; nothing Audivo hosts fetches from YouTube. On this server, " +
  'an Apple Podcasts link, a feed URL and GUID, an episode_id, or an upload_id works.';

/** The episode, as `transcribe` itself takes it again: how a later page is asked for. */
type Pointer =
  | { readonly url: string }
  | { readonly feed_url: string; readonly guid: string }
  | { readonly episode_id: string }
  | { readonly upload_id: string };

/**
 * What the submit names, from whichever input the caller gave, and a label
 * for the answer. A file or a YouTube video ends as an `upload_id`, so a later
 * page names the upload rather than downloading or sending it again.
 */
async function pointerFor(
  args: TranscribeArgs,
  call: ApiCall,
  ctx: ToolContext,
  local: LocalSources | undefined,
): Promise<{ readonly pointer: Pointer; readonly source: Record<string, unknown> }> {
  const given = [
    args.url !== undefined,
    args.feed_url !== undefined || args.guid !== undefined,
    args.episode_id !== undefined,
    args.upload_id !== undefined,
    args.path !== undefined,
  ].filter(Boolean).length;
  if (given !== 1) {
    throw localError(
      'invalid_request',
      local === undefined
        ? 'pass exactly one of url, feed_url with guid, episode_id, or upload_id'
        : 'pass exactly one of url, feed_url with guid, episode_id, upload_id, or path',
    );
  }
  if (args.url !== undefined) {
    const videoId = youtubeVideoId(args.url);
    if (videoId !== null) {
      if (local === undefined) throw localError('invalid_request', HOSTED_YOUTUBE_MESSAGE);
      const uploaded = await local.uploadYoutube(call, ctx, videoId);
      return {
        pointer: { upload_id: uploaded.uploadId },
        source: { kind: 'youtube', video_id: videoId, upload_id: uploaded.uploadId },
      };
    }
    return { pointer: { url: args.url }, source: { kind: 'url' } };
  }
  if (args.feed_url !== undefined || args.guid !== undefined) {
    if (args.feed_url === undefined || args.guid === undefined) {
      throw localError('invalid_request', 'feed_url and guid go together');
    }
    return { pointer: { feed_url: args.feed_url, guid: args.guid }, source: { kind: 'feed' } };
  }
  if (args.episode_id !== undefined) {
    return { pointer: { episode_id: args.episode_id }, source: { kind: 'episode_id' } };
  }
  if (args.upload_id !== undefined) {
    return { pointer: { upload_id: args.upload_id }, source: { kind: 'upload_id' } };
  }
  // `path`, which only the local schema admits.
  if (local === undefined)
    throw localError('invalid_request', 'path works on the local server only');
  const uploaded = await local.uploadFile(call, ctx, args.path!);
  return {
    pointer: { upload_id: uploaded.uploadId },
    source: { kind: 'file', upload_id: uploaded.uploadId },
  };
}

// --- The tool --------------------------------------------------------------------------

function inputSchema(local: boolean) {
  const base = {
    url: z
      .url()
      .max(MAX_URL_LENGTH)
      .optional()
      .describe(
        local
          ? 'An Apple Podcasts episode link, or a YouTube video link.'
          : 'An Apple Podcasts episode link.',
      ),
    feed_url: z
      .url()
      .max(MAX_URL_LENGTH)
      .optional()
      .describe('With guid: an RSS feed and one item.'),
    guid: z.string().min(1).max(MAX_GUID_LENGTH).optional(),
    episode_id: z
      .string()
      .regex(EPISODE_ID_PATTERN)
      .max(40)
      .optional()
      .describe('From list_episodes.'),
    upload_id: z.string().regex(UPLOAD_ID_PATTERN).max(40).optional(),
    max_credits: z.int().min(0).optional().describe('Refuse if it could cost more.'),
    wait_seconds: z
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe(local ? 'Default 50.' : 'Default and most 20.'),
    page_start: z.int().min(0).optional().describe("A later page: the answer's next_page."),
  };
  if (!local) return z.object(base);
  return z.object({
    ...base,
    path: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .refine(isAbsolute, { message: 'path must be absolute' })
      .optional()
      .describe('An audio file on this machine, by absolute path.'),
  });
}

export function transcribeTool(local?: LocalSources): AnyToolDefinition {
  return defineTool({
    name: 'transcribe',
    title: 'Transcribe an episode',
    description:
      'SPENDS CREDITS, about one per audio minute (less if already transcribed). The default ' +
      'way to get a transcript: pass one episode — ' +
      (local
        ? 'an Apple Podcasts or YouTube link, feed_url with guid, episode_id, upload_id, or path. '
        : 'an Apple Podcasts link, feed_url with guid, episode_id, or upload_id. ') +
      'Returns it a page at a time (next_page), or a job_id for read_transcript while it runs. ' +
      'max_credits caps the spend; repeating a call never charges twice.',
    inputSchema: inputSchema(local !== undefined),
    annotations: {
      readOnlyHint: false,
      // It spends credits, which cannot be taken back: the irreversible
      // transaction the hint exists for, as `confirm` already says (ADR-0036).
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    // The reader renders the result (ADR-0036).
    meta: {
      ...rendersApp(),
      ...statusText('Transcribing the episode…', 'Transcribed the episode'),
    },
    handler: async (args: TranscribeArgs, ctx) => {
      const call = requireCredential(ctx);
      const startedAt = ctx.now();
      const pageStart = args.page_start ?? 0;
      const { pointer, source } = await pointerFor(args, call, ctx, local);
      const cap = args.max_credits === undefined ? {} : { max_credits: args.max_credits };
      // `dry_run` is stated, not left to its default: the body is what the
      // idempotency key is derived from, and it should read as what it is.
      const body = { ...pointer, ...cap, dry_run: false } as TranscriptCreateRequest;
      // The same call again, turned to a later page: how the rest of a cached
      // episode is read, as a replay that charges nothing.
      const repeatWith = (next: number): Record<string, unknown> => ({
        tool: 'transcribe',
        arguments: { ...pointer, ...cap, page_start: next },
      });

      const key = idempotencyKeyFor(body);
      let created = await ctx.api.createTranscript(call, body, key);
      if (created.status === 202 && isTerminal(created.body.status)) {
        // The key named a job that has already failed or been cancelled: a
        // replay would hand the failure back for a day. Once, under a fresh key.
        created = await ctx.api.createTranscript(call, body, `${key}-retry-${randomUUID()}`);
      }

      if (created.status === 200) {
        const read = created.body;
        const trusted: Record<string, unknown> = {
          source,
          is_cached: 'is_cached' in read ? read.is_cached : true,
          credits_charged: 'credits_charged' in read ? read.credits_charged : undefined,
          repeat_is_free:
            'the same call within 24 hours replays this answer and charges nothing further',
        };
        // The receipt the read was charged under (contract 0.15.0): the rest
        // is read through read_transcript, which charges nothing and spends
        // nothing, rather than by replaying this call.
        const readId = 'read_id' in read ? read.read_id : undefined;
        if (readId !== undefined) trusted.read_id = readId;
        const view = readView(read, { pageStart, budgetChars: TRANSCRIPT_PAGE_CHARS });
        const withView = view === undefined ? {} : { view };
        if (!('transcript' in read) || read.transcript === undefined) {
          trusted.transcript = { delivery: 'by_reference', reason: 'above_inline_limit' };
          return { trusted, untrusted: '', ...withView } satisfies Document;
        }
        const page = transcriptPage(read.transcript, {
          pageStart,
          budgetChars: TRANSCRIPT_PAGE_CHARS,
          label: `episode ${read.transcript.episode_id}`,
          continueWith:
            readId === undefined
              ? repeatWith
              : (next) => ({
                  tool: 'read_transcript',
                  arguments: { read_id: readId, page_start: next },
                }),
        });
        trusted.transcript = page.facts;
        return {
          trusted,
          untrusted: untrustedBlock(page.rows, page.text),
          ...withView,
        } satisfies Document;
      }

      const accepted: TranscriptJobAccepted = created.body;
      const latest = await waitForJob(call, ctx, accepted.job_id, {
        waitSeconds: args.wait_seconds,
        startedAt,
      });
      const extra = {
        source,
        group_id: accepted.group_id,
        quote_ceiling_credits: accepted.quote_ceiling_credits,
      };
      if (latest === undefined) {
        return {
          trusted: {
            ...extra,
            job_id: accepted.job_id,
            status: accepted.status,
            episode_id: accepted.episode_id,
            estimated_credits: accepted.estimated_credits,
            reserved_credits: accepted.reserved_credits,
            estimated_seconds: accepted.estimated_seconds,
            transcript: {
              delivery: 'not_yet',
              reason: `status is ${accepted.status}`,
              wait_with: {
                tool: 'read_transcript',
                arguments: { job_id: accepted.job_id, wait_seconds: 60 },
              },
            },
          },
          untrusted: '',
          view: acceptedView(accepted),
        } satisfies Document;
      }
      return {
        ...deliverJobPage(latest, {
          reference: referenceFor(ctx.api.transcriptReference(accepted.job_id)),
          pageStart,
          budgetChars: TRANSCRIPT_PAGE_CHARS,
          extra,
        }),
        view: jobView(latest, {
          pageStart,
          budgetChars: TRANSCRIPT_PAGE_CHARS,
          jobId: accepted.job_id,
        }),
      };
    },
  });
}

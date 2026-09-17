/**
 * The tools the local stdio server serves and the hosted one cannot.
 *
 * There is one, `upload_audio`, and what makes it local is the first
 * argument: a path on the caller's own machine. The hosted server at
 * `https://api.audivo.dev/mcp` runs in a Lambda that has never seen that
 * disk, so registering the tool there would offer a capability it could only
 * refuse. `cli.ts` registers `[...TOOLS, ...LOCAL_TOOLS]`; `lambda.ts`
 * registers `TOOLS` and nothing else, and `server.test.ts` holds it to nine.
 *
 * The work is two calls with a guard between them: announce the file the API
 * is about to be sent (its hash, size, type and duration), then PUT the bytes
 * to the presigned URL that comes back, with exactly the headers it named.
 * The PUT is attempted once. A bucket that refuses it is reported as
 * `upload_failed`, which is retryable — but retrying is the caller's call,
 * made by announcing again, because a presigned URL has an expiry and a
 * silent second attempt would hide both the failure and the clock.
 *
 * Nothing here spends credits. An upload is priced by `quote` and paid for by
 * `confirm`, like any other source.
 */
import { basename, isAbsolute } from 'node:path';
import * as z from 'zod';
import type { CreateUploadRequest } from './api-client.js';
import type { components } from './contract/types.js';
import { localError } from './errors.js';
import { renderUpload } from './render.js';
import { defineTool, requireCredential, type AnyToolDefinition } from './tools.js';
import { PutUrlError, assertPutUrl, inspectAudioFile } from './upload.js';

type UploadContentType = components['schemas']['UploadContentType'];

/**
 * The contract's `UploadContentType`, as a value: the generated type is a
 * union of string literals and a zod enum needs an array at run time, so the
 * list is written once here and `satisfies` keeps every entry a member of
 * that union. `contract.test.ts` checks the other direction — that the union
 * has no member this list forgot — against the bundled spec.
 */
export const UPLOAD_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/x-aac',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
] as const satisfies readonly UploadContentType[];

/** The contract's upload bounds, restated for the schema and the checks below. */
export const MAX_UPLOAD_BYTES = 5_368_709_120;
const MAX_DECLARED_DURATION_SECONDS = 36_000;
/** Longest path any mainstream filesystem addresses; the bound exists so the string has one. */
const MAX_PATH_LENGTH = 4096;

/** The S3 error body is small XML; this much of it names the cause without pasting a page. */
const PUT_ERROR_BODY_CHARS = 200;

/**
 * A transport rejection's own `.message` is whatever the underlying `fetch`
 * threw — plenty for a DNS, TLS, or reset failure, occasionally more. This
 * much names the cause without risking an oversized tool result.
 */
const PUT_REJECTION_MESSAGE_CHARS = 300;

function isUploadContentType(value: string): value is UploadContentType {
  return (UPLOAD_CONTENT_TYPES as readonly string[]).includes(value);
}

export type LocalToolOptions = {
  /** How a file on disk is read; the real inspector unless a test says otherwise. */
  readonly inspect?: typeof inspectAudioFile;
};

/**
 * The local catalog, built around one seam. `inspect` is the only thing here
 * a test cannot drive with a real file: a five-gigabyte fixture, a container
 * nothing recognises, and a file whose container states no duration are all
 * facts about bytes rather than about this tool, so they are injected instead
 * of manufactured.
 */
export function localTools(options: LocalToolOptions = {}): readonly AnyToolDefinition[] {
  const inspect = options.inspect ?? inspectAudioFile;

  const uploadAudio = defineTool({
    name: 'upload_audio',
    title: 'Upload an audio file (local only)',
    description:
      'Announces a file on this machine to Audivo, uploads it, and returns the upload_id to ' +
      'pass to quote as uploads: [{ upload_id }]. The file must be audio you hold rights to ' +
      "(any source, for example a download you made yourself); Audivo's servers never fetch " +
      'it for you. Spends nothing; quote and confirm price it. Local server only.',
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .max(MAX_PATH_LENGTH)
        // Relative would resolve against whatever directory the MCP client
        // happened to spawn this process in, which no caller can see.
        .refine(isAbsolute, { message: 'path must be absolute' })
        .describe('Absolute path to the audio file on this machine.'),
      title: z.string().min(1).max(300).optional().describe('Quote label; defaults to the file.'),
      declared_duration_seconds: z
        .number()
        .gt(0)
        .max(MAX_DECLARED_DURATION_SECONDS)
        .optional()
        .describe('Required when the container states no duration.'),
      content_type: z
        .enum(UPLOAD_CONTENT_TYPES)
        .optional()
        .describe('Required when the container is not recognised.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, ctx) => {
      const call = requireCredential(ctx);
      const transport = ctx.upload;
      if (transport === undefined) {
        throw localError('invalid_request', 'upload_audio is available on the local server only');
      }

      const facts = await inspect(args.path);
      if (facts.bytes < 1 || facts.bytes > MAX_UPLOAD_BYTES) {
        throw localError(
          'invalid_request',
          `the file is ${facts.bytes} bytes; an upload is at least 1 byte and at most ${MAX_UPLOAD_BYTES}`,
        );
      }

      // An explicit `content_type` is honoured when detection found nothing
      // to contradict it (`detectedMime === null`) or when what it found is
      // audio or video (a container `MIME_CONTENT_TYPES` has no entry for,
      // such as Matroska, still gets the benefit of the doubt). Detection
      // finding something that is neither, a PDF, a PNG, any file that is
      // plainly not audio, refuses the upload outright: a caller's
      // `content_type` names what the bytes should be sent as, not what they
      // actually are, and honouring it there would let any file on disk be
      // announced as audio.
      let contentType: UploadContentType | null;
      if (args.content_type !== undefined) {
        const detectedMime = facts.detectedMime;
        if (
          detectedMime !== null &&
          !detectedMime.startsWith('audio/') &&
          !detectedMime.startsWith('video/')
        ) {
          throw localError(
            'file_not_supported',
            `the file here is ${detectedMime}, not audio; content_type cannot override what a file ` +
              'actually is',
          );
        }
        contentType = args.content_type;
      } else {
        const detected = facts.contentType;
        contentType = detected !== null && isUploadContentType(detected) ? detected : null;
      }
      if (contentType === null) {
        throw localError(
          'file_not_supported',
          `the container here (${facts.container ?? 'unrecognised'}) is not one Audivo takes; ` +
            `pass content_type as one of ${UPLOAD_CONTENT_TYPES.join(', ')}`,
        );
      }

      const duration = args.declared_duration_seconds ?? facts.durationSeconds;
      if (duration === null) {
        throw localError(
          'invalid_request',
          'the container states no duration; pass declared_duration_seconds, the length of the audio in seconds',
        );
      }
      if (duration <= 0 || duration > MAX_DECLARED_DURATION_SECONDS) {
        throw localError(
          'invalid_request',
          `the duration here (${duration}s) is outside what an upload may declare: ` +
            `above 0 and at most ${MAX_DECLARED_DURATION_SECONDS} seconds; pass ` +
            'declared_duration_seconds with the real duration (a container reporting 0 is the common case)',
        );
      }

      const body: CreateUploadRequest = {
        sha256: facts.sha256,
        bytes: facts.bytes,
        content_type: contentType,
        declared_duration_seconds: duration,
        ...(args.title === undefined ? {} : { title: args.title }),
      };
      const created = await ctx.api.createUpload(call, body);

      // The URL the API minted, held to the same rule as the API's own
      // origin. A `PutUrlError` is a plain `Error`, so it would surface as
      // `internal_error` with its diagnosis swallowed; this names it instead.
      try {
        assertPutUrl(created.put_url);
      } catch (error) {
        if (!(error instanceof PutUrlError)) throw error;
        throw localError(
          'invalid_request',
          `the API returned a PUT URL this server will not send to (${error.code})`,
          { cause: error },
        );
      }

      // `transport.put` is `undiciUploadTransport` in production, and its
      // `fetch` call has no try/catch of its own — a DNS failure, a reset
      // mid-stream, or a TLS error rejects instead of resolving. Left
      // uncaught, that would reach `runTool` as an uncaught throw and be
      // reported as `internal_error`, blaming this server for a bucket that
      // never answered. It gets the same code the non-2xx branch below does:
      // the PUT was attempted once either way, and retrying is the caller's
      // call to make by announcing again.
      let response: { readonly status: number; readonly body: string };
      try {
        response = await transport.put(created.put_url, created.put_headers, args.path);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw localError(
          'upload_failed',
          `PUT to the upload URL failed: ${detail}`.slice(0, PUT_REJECTION_MESSAGE_CHARS),
          { cause: error },
        );
      }
      if (response.status < 200 || response.status > 299) {
        throw localError(
          'upload_failed',
          `S3 answered ${response.status}: ${response.body.slice(0, PUT_ERROR_BODY_CHARS)}`,
        );
      }

      // The basename only: the announcement is what the model acts on, and
      // the directories above the file are the caller's business, not a
      // model's and not a log's.
      return renderUpload(created, { file: basename(args.path), sha256: facts.sha256 });
    },
  });

  return Object.freeze([uploadAudio]);
}

/** The catalog `cli.ts` registers: the real inspector, one tool. */
export const LOCAL_TOOLS: readonly AnyToolDefinition[] = localTools();

/**
 * What every tool is built from: the context a call runs in, the definition
 * shape, and the one guard every spending or reading tool starts with.
 *
 * Its own module so that the tool catalogs (`tools.ts`, `local-tools.ts`) and
 * the tools defined beside them (`transcribe.ts`) all import one thing that
 * imports none of them — a cycle between a catalog and a tool it lists is a
 * module that reads a binding before it exists.
 */
import type { Icon, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { ApiCall, ApiClient, TraceEntry } from './api-client.js';
import { NO_CREDENTIAL_MESSAGE, localError } from './errors.js';
import type { Document, Nonce } from './render.js';
import type { WaitPolicy } from './transcribe.js';
import type { UploadTransport } from './upload.js';

export type ToolContext = {
  /** The `Authorization` value the MCP request carried, or `null` when it carried none. */
  readonly credential: string | null;
  readonly api: ApiClient;
  readonly nonce: Nonce;
  readonly trace: TraceEntry[];
  /**
   * The presigned PUT, present only on the local stdio server: reading a file
   * off the caller's disk is something only a process on that disk can do, so
   * the hosted server leaves this undefined and `upload_audio` — the one tool
   * that needs it — is not registered there at all.
   */
  readonly upload?: UploadTransport;
  /** How long a tool may wait on a job: the hosted gateway's ceiling, or the local client's. */
  readonly wait: WaitPolicy;
  /** The clock and the pause the wait runs on; real in production, a fake in the suites. */
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Progress while waiting, sent where the client asked for it by giving the
   * call a progress token. Local server only: behind the hosted edge a
   * notification would turn one buffered JSON answer into a stream for nothing.
   */
  readonly progress?: (
    progress: number,
    total: number | undefined,
    message: string,
  ) => Promise<void>;
  /** The client's cancellation of this call. */
  readonly signal?: AbortSignal;
};

export type ToolDefinition<S extends z.ZodObject = z.ZodObject> = {
  readonly name: string;
  readonly title: string;
  /** What the hosted server says the tool does. Names no tool the hosted server lacks. */
  readonly description: string;
  /** What the local server says instead, where it can do more (a file, a YouTube link). */
  readonly localDescription?: string;
  readonly inputSchema: S;
  readonly annotations: ToolAnnotations;
  /** The tool's `_meta` on every surface: its app, entrypoints and status text (ADR-0036). */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly icons?: readonly Icon[];
  readonly handler: (args: z.infer<S>, ctx: ToolContext) => Promise<Document>;
};

/** The catalog's element type: arguments arrive validated, so the handler is typed loosely here. */
export type AnyToolDefinition = Omit<ToolDefinition, 'handler'> & {
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<Document>;
};

/** The one narrowing every tool goes through, `local-tools.ts`'s included. */
export function defineTool<S extends z.ZodObject>(
  definition: ToolDefinition<S>,
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

/** A call without a key is refused here, before any request; the API is never asked for nobody. */
export function requireCredential(ctx: ToolContext): ApiCall {
  if (ctx.credential === null) throw localError('unauthenticated', NO_CREDENTIAL_MESSAGE);
  return { credential: ctx.credential, trace: ctx.trace };
}

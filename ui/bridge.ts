/**
 * The app's side of the conversation with its host: calling the server's
 * tools, and reading what they hand back.
 *
 * Everything the view shows comes from `_meta["audivo/view"]`
 * (`src/view.ts`); the text the model reads is never parsed here. A failed
 * call is told in the app's own words, by code, because the API's message is
 * written for whoever made the request and the person looking at the app may
 * not be them.
 */
import type { View } from '../src/view.js';

/** The `_meta` keys the server writes (`src/view.ts`, `src/render.ts`). */
export const VIEW_KEY = 'audivo/view';
export const REQUEST_ID_KEY = 'audivo/request_id';

export type ToolResult = {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
  readonly _meta?: Readonly<Record<string, unknown>>;
};

export type Outcome =
  | { readonly ok: true; readonly view: View | undefined }
  | { readonly ok: false; readonly message: string; readonly reference: string | undefined };

/** The error code in a failed result's trusted block, when there is one. */
function errorCodeOf(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  if (first?.type !== 'text' || first.text === undefined) return undefined;
  try {
    const parsed = JSON.parse(first.text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a failure means to the person in front of the app. No plan or price
 * is ever named: a feature that needs more credits says so, and stops there.
 */
export function messageFor(code: string | undefined): string {
  switch (code) {
    case 'payment_required':
    case 'insufficient_credits':
      return 'Your Audivo account doesn’t have enough credits for this episode.';
    case 'max_credits_exceeded':
      return 'This episode would cost more than the limit set for this request.';
    case 'unauthenticated':
    case 'invalid_api_key':
      return 'Audivo couldn’t confirm your sign-in. Reconnect Audivo and try again.';
    case 'rate_limited':
    case 'concurrency_limited':
      return 'Audivo is busy with your other requests. Try again in a moment.';
    case 'episode_not_found':
    case 'job_not_found':
    case 'show_not_found':
    case 'group_not_found':
      return 'Audivo couldn’t find that. It may have been removed.';
    case 'feed_dead':
    case 'feed_unreachable':
      return 'The podcast’s feed couldn’t be reached right now.';
    case 'account_suspended':
    case 'account_closed':
      return 'This Audivo account can’t transcribe right now. Check it at dash.audivo.dev.';
    default:
      return 'Something went wrong. Try again in a moment.';
  }
}

export function outcomeOf(result: ToolResult): Outcome {
  const meta = result._meta ?? {};
  if (result.isError === true) {
    const reference = meta[REQUEST_ID_KEY];
    return {
      ok: false,
      message: messageFor(errorCodeOf(result)),
      reference: typeof reference === 'string' ? reference : undefined,
    };
  }
  return { ok: true, view: meta[VIEW_KEY] as View | undefined };
}

/** The slice of the host connection the views use; a fake in the suites. */
export type Host = {
  callTool(name: string, args: Record<string, unknown>): Promise<Outcome>;
  /** Ask to go fullscreen; false when the host cannot. */
  expand(): Promise<boolean>;
  /** Tell the conversation, by id only, what the user has open. */
  noteOpened(text: string): void;
  readonly locale: string | undefined;
  readonly inline: boolean;
};

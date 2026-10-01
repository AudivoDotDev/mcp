/**
 * What the Audivo app's view is handed, in a tool result's
 * `_meta["audivo/view"]` (ADR-0036 decision 2).
 *
 * Hosts give `_meta` to the view and never to the model, so this is the one
 * place publisher text travels unfenced: the view needs titles and
 * transcript lines as they are, and renders every one of them as a text node.
 * The model keeps getting the fenced `content` it always did.
 *
 * Shared by the server, which builds these, and by the view (`ui/`), which
 * imports the types only. Every field is plain JSON.
 */

/** The `_meta` key a view reads. */
export const VIEW_META_KEY = 'audivo/view';

/** How a transcript is fetched again: a job, or a read already paid for. */
export type TranscriptRef = { readonly job_id: string } | { readonly read_id: string };

export type ViewSegment = {
  /** Seconds from the start of the episode. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type ViewLabels = {
  readonly show_title: string | null;
  readonly episode_title: string | null;
};

/** One page of a transcript, the same page `read_transcript` gives the model. */
export type ViewPage = {
  readonly page_start: number;
  readonly segments: readonly ViewSegment[];
  readonly segments_total: number;
  /** Where the next page starts, or `null` on the last page. */
  readonly next_page_start: number | null;
};

export type TranscriptView = ViewLabels & {
  readonly kind: 'transcript';
  readonly ref: TranscriptRef;
  readonly episode_id: string | null;
  /**
   * `completed` and `cached` have a page, or are over the inline limit and
   * have none; the rest are still running or ended without a transcript.
   */
  readonly status: string;
  readonly duration_sec: number | null;
  readonly language: string | null;
  /** What it cost: settled for a finished job, charged for a read, the hold while running. */
  readonly credits: number | null;
  readonly credits_kind: 'settled' | 'charged' | 'reserved' | 'estimated' | null;
  readonly progress_percent: number | null;
  readonly page: ViewPage | null;
  /** True when the transcript exists but is above the inline limit and has no page here. */
  readonly oversized: boolean;
  /** The API's own words when the job failed; publisher-adjacent, so a text node too. */
  readonly error: string | null;
};

export type LibraryItem = ViewLabels & {
  readonly ref: TranscriptRef;
  readonly episode_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly credits: number | null;
};

export type LibraryView = {
  readonly kind: 'library';
  readonly items: readonly LibraryItem[];
  /** Pass to `list_transcripts` as `cursor` for older ones; `null` when there are none. */
  readonly next_cursor: string | null;
};

export type ShowsView = {
  readonly kind: 'shows';
  readonly shows: readonly {
    readonly show_id: string;
    readonly feed_url: string;
    readonly itunes_id: number | null;
    readonly title: string;
    readonly author: string | null;
  }[];
};

export type EpisodesView = {
  readonly kind: 'episodes';
  readonly show_id: string;
  readonly episodes: readonly {
    readonly episode_id: string;
    readonly title: string | null;
    readonly published_at: string | null;
    readonly duration_sec: number | null;
    readonly is_cached: boolean;
    readonly estimated_credits: number | null;
  }[];
  readonly next_cursor: string | null;
};

export type View = TranscriptView | LibraryView | ShowsView | EpisodesView;

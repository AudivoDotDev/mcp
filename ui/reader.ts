/**
 * The reader: one transcript, from `transcribe` or opened from the library.
 *
 * A job still running is looked at through `read_transcript` every
 * `POLL_INTERVAL_MS`, one request a look, until it ends. A look that fails is
 * not the job failing: the reader keeps the last status, backs off, and after
 * a few failures in a row offers Retry. Only the server says a job failed. A
 * finished one shows
 * its first page; later pages come from `read_transcript` with `page_start`,
 * which charges nothing. Search runs over what has been loaded, and says so.
 */
import type { TranscriptRef, TranscriptView, ViewSegment } from '../src/view.js';
import type { Host } from './bridge.js';
import { append, clear, el, highlight } from './dom.js';
import { clock, creditsLine, duration, isSettled, languageName, statusLabel } from './format.js';

/** How many lines an inline card shows before offering the whole transcript. */
export const INLINE_SEGMENTS = 6;

/** The most pages "Load all" fetches in one go, so a very long episode cannot run away. */
export const LOAD_ALL_PAGE_LIMIT = 25;

/**
 * How often the reader looks at a running job. A fresh episode takes minutes,
 * and each look is one request on the account's plan; the model may be
 * waiting on the same job at the same time.
 */
export const POLL_INTERVAL_MS = 20_000;

/** The longest wait between looks while they keep failing. */
export const POLL_BACKOFF_MAX_MS = 120_000;

/** Failed looks in a row after which the reader stops and offers Retry. */
export const POLL_FAILURES_BEFORE_RETRY = 4;

/** The wait before the next look, after `failures` failed ones in a row. */
export function pollDelay(failures: number, retryAfterSeconds?: number): number {
  const backoff = Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_BACKOFF_MAX_MS);
  return Math.max(backoff, (retryAfterSeconds ?? 0) * 1000);
}

export type ReaderOptions = {
  /** Show a back control, for a reader opened from the library. */
  readonly onBack?: () => void;
  /** Mention the transcript to the conversation: true when the user opened it themselves. */
  readonly announce?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

/** The composer chip's label: the episode, with its show when there is room. */
export function chipLabel(show: string | null, episode: string | null): string {
  const label =
    episode === null
      ? (show ?? 'Audivo transcript')
      : show === null
        ? episode
        : `${show}: ${episode}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

export type MountedReader = {
  /** The host changed how the app is shown; fullscreen shows every loaded line. */
  displayModeChanged(inline: boolean): void;
  destroy(): void;
};

function refArgs(ref: TranscriptRef): Record<string, string> {
  return 'job_id' in ref ? { job_id: ref.job_id } : { read_id: ref.read_id };
}

export function mountReader(
  root: HTMLElement,
  host: Host,
  initial: TranscriptView,
  options: ReaderOptions = {},
): MountedReader {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let view = initial;
  let segments: ViewSegment[] = [...(initial.page?.segments ?? [])];
  let next: number | null = initial.page?.next_page_start ?? null;
  let query = '';
  let expanded = !host.inline;
  let busy = false;
  let alive = true;
  /** A look at a running job that failed; the job's own status is untouched. */
  let trouble: { readonly message: string; readonly stalled: boolean } | null = null;

  const section = el('section', { class: 'reader', attrs: { 'aria-live': 'polite' } });
  clear(root);
  root.appendChild(section);

  if (options.announce === true) {
    const id = 'job_id' in view.ref ? `job_id ${view.ref.job_id}` : `read_id ${view.ref.read_id}`;
    host.noteOpened(
      `The user attached an Audivo transcript (${id}). Read it with read_transcript and that id ` +
        'before answering about it.',
      chipLabel(view.show_title, view.episode_title),
    );
  }

  function header(): HTMLElement {
    const facts = [
      view.duration_sec === null ? null : duration(view.duration_sec),
      languageName(view.language, host.locale),
      creditsLine(view.credits, view.credits_kind),
    ].filter((fact): fact is string => fact !== null);
    return el(
      'header',
      { class: 'reader-header' },
      options.onBack === undefined
        ? null
        : el(
            'button',
            { class: 'link back', attrs: { type: 'button' }, on: { click: options.onBack } },
            '← Transcripts',
          ),
      view.show_title === null ? null : el('p', { class: 'eyebrow' }, view.show_title),
      el('h1', { class: 'title' }, view.episode_title ?? 'Transcript'),
      facts.length === 0 ? null : el('p', { class: 'meta' }, facts.join(' · ')),
    );
  }

  function status(): HTMLElement | null {
    if (view.error !== null || view.status === 'failed') {
      return el(
        'p',
        { class: 'notice failed', attrs: { role: 'alert' } },
        view.error ?? 'This transcription failed.',
      );
    }
    if (view.status === 'cancelled')
      return el('p', { class: 'notice' }, 'This transcription was cancelled.');
    if (!isSettled(view.status)) {
      const label = statusLabel(view.status).text;
      const percent = view.progress_percent;
      const working = el(
        'div',
        { class: 'notice working', attrs: { role: 'status' } },
        el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        percent === null ? `${label}…` : `${label}… ${Math.round(percent)}%`,
        percent === null
          ? null
          : el('progress', { attrs: { max: '100', value: String(Math.round(percent)) } }),
      );
      if (trouble === null) return working;
      return el(
        'div',
        { class: 'notices' },
        working,
        trouble.stalled
          ? el(
              'p',
              { class: 'notice failed', attrs: { role: 'alert' } },
              `${trouble.message} The transcription itself keeps going. `,
              el(
                'button',
                { class: 'link', attrs: { type: 'button' }, on: { click: () => void retry() } },
                'Retry',
              ),
            )
          : el('p', { class: 'notice' }, 'Lost touch with Audivo. Checking again shortly.'),
      );
    }
    if (view.oversized) {
      return el(
        'p',
        { class: 'notice' },
        'This transcript is too long to show here. Ask in the chat for the parts you need.',
      );
    }
    return null;
  }

  function lines(): HTMLElement {
    const shown =
      query.trim() === ''
        ? segments
        : segments.filter((segment) =>
            segment.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
          );
    const visible = expanded || query.trim() !== '' ? shown : shown.slice(0, INLINE_SEGMENTS);
    return el(
      'ol',
      { class: 'segments' },
      ...visible.map((segment) =>
        el(
          'li',
          { class: 'segment' },
          el('span', { class: 'ts' }, clock(segment.start)),
          el('p', { class: 'line' }, highlight(segment.text, query)),
        ),
      ),
    );
  }

  function toolbar(): HTMLElement | null {
    if (segments.length === 0) return null;
    const input = el('input', {
      class: 'search-input',
      attrs: {
        type: 'search',
        placeholder: 'Search this transcript',
        'aria-label': 'Search this transcript',
        value: query,
      },
      on: {
        input: (event) => {
          query = (event.target as HTMLInputElement).value;
          renderBody();
        },
      },
    });
    return el('div', { class: 'toolbar' }, input);
  }

  function footer(): HTMLElement | null {
    const searching = query.trim() !== '';
    const parts: HTMLElement[] = [];
    if (searching) {
      const matches = segments.filter((s) =>
        s.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ).length;
      parts.push(
        el(
          'p',
          { class: 'hint' },
          `${matches} ${matches === 1 ? 'line matches' : 'lines match'}${next === null ? '' : ' in the part loaded so far'}.`,
        ),
      );
    }
    if (!expanded && segments.length > INLINE_SEGMENTS && !searching) {
      parts.push(
        el(
          'button',
          { class: 'button', attrs: { type: 'button' }, on: { click: () => void open() } },
          'Open the full transcript',
        ),
      );
    } else if (next !== null) {
      parts.push(
        el(
          'button',
          {
            class: 'button',
            attrs: { type: 'button', ...(busy ? { disabled: '' } : {}) },
            on: { click: () => void loadMore() },
          },
          busy ? 'Loading…' : 'Load more',
        ),
      );
      if (searching) {
        parts.push(
          el(
            'button',
            {
              class: 'link',
              attrs: { type: 'button', ...(busy ? { disabled: '' } : {}) },
              on: { click: () => void loadAll() },
            },
            'Search the whole transcript',
          ),
        );
      }
    }
    return parts.length === 0 ? null : el('div', { class: 'reader-footer' }, ...parts);
  }

  const bodySlot = el('div', { class: 'reader-body' });

  function renderBody(): void {
    clear(bodySlot);
    append(bodySlot, lines(), footer());
  }

  function render(): void {
    clear(section);
    append(section, header(), status(), toolbar(), bodySlot);
    renderBody();
  }

  async function open(): Promise<void> {
    if (!(await host.expand())) {
      expanded = true;
      renderBody();
    }
  }

  async function fetchPage(pageStart: number): Promise<boolean> {
    const outcome = await host.callTool('read_transcript', {
      ...refArgs(view.ref),
      page_start: pageStart,
    });
    if (!alive) return false;
    if (!outcome.ok || outcome.view?.kind !== 'transcript' || outcome.view.page === null) {
      section.appendChild(
        el(
          'p',
          { class: 'notice failed', attrs: { role: 'alert' } },
          outcome.ok ? 'This page could not be loaded.' : outcome.message,
        ),
      );
      return false;
    }
    segments = [...segments, ...outcome.view.page.segments];
    next = outcome.view.page.next_page_start;
    return true;
  }

  async function loadMore(): Promise<void> {
    if (busy || next === null) return;
    busy = true;
    renderBody();
    await fetchPage(next);
    busy = false;
    if (alive) renderBody();
  }

  async function loadAll(): Promise<void> {
    if (busy) return;
    busy = true;
    renderBody();
    for (let pages = 0; next !== null && pages < LOAD_ALL_PAGE_LIMIT; pages += 1) {
      if (!(await fetchPage(next))) break;
    }
    busy = false;
    if (alive) renderBody();
  }

  /**
   * Looks at a running job until it settles. The view in hand is fresh, from
   * the call that rendered it or the library's own read, so the first look
   * waits an interval. `immediately` is Retry's: the person asked for it.
   */
  async function wait(immediately = false): Promise<void> {
    let failures = 0;
    let retryAfter: number | undefined;
    let first = true;
    while (alive && !isSettled(view.status) && 'job_id' in view.ref) {
      if (!(first && immediately)) await sleep(pollDelay(failures, retryAfter));
      first = false;
      if (!alive) return;
      const outcome = await host.callTool('read_transcript', { job_id: view.ref.job_id });
      if (!alive) return;
      if (!outcome.ok) {
        failures += 1;
        retryAfter = outcome.retryAfterSeconds;
        const stalled = failures >= POLL_FAILURES_BEFORE_RETRY;
        trouble = { message: outcome.message, stalled };
        render();
        if (stalled) return;
        continue;
      }
      failures = 0;
      retryAfter = undefined;
      trouble = null;
      if (outcome.view?.kind === 'transcript') {
        view = outcome.view;
        segments = [...(view.page?.segments ?? [])];
        next = view.page?.next_page_start ?? null;
      }
      render();
    }
  }

  async function retry(): Promise<void> {
    if (trouble === null || !trouble.stalled) return;
    trouble = { ...trouble, stalled: false };
    render();
    await wait(true);
  }

  render();
  void wait();
  return {
    displayModeChanged(inline) {
      if (!inline && !expanded) {
        expanded = true;
        renderBody();
      }
    },
    destroy() {
      alive = false;
    },
  };
}

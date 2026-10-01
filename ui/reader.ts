/**
 * The reader: one transcript, from `transcribe` or opened from the library.
 *
 * A job still running is waited on through `read_transcript`, twenty seconds
 * a call (the hosted server's ceiling), until it ends. A finished one shows
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

/** The pause between waits on a running job, beyond the wait each call already makes. */
export const POLL_PAUSE_MS = 1_500;

export type ReaderOptions = {
  /** Show a back control, for a reader opened from the library. */
  readonly onBack?: () => void;
  /** Mention the transcript to the conversation: true when the user opened it themselves. */
  readonly announce?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

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

  const section = el('section', { class: 'reader', attrs: { 'aria-live': 'polite' } });
  clear(root);
  root.appendChild(section);

  if (options.announce === true) {
    const id = 'job_id' in view.ref ? `job_id ${view.ref.job_id}` : `read_id ${view.ref.read_id}`;
    host.noteOpened(
      `The user opened a transcript in the Audivo app (${id}); read_transcript with that id reads it.`,
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
      return el(
        'div',
        { class: 'notice working', attrs: { role: 'status' } },
        el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        percent === null ? `${label}…` : `${label}… ${Math.round(percent)}%`,
        percent === null
          ? null
          : el('progress', { attrs: { max: '100', value: String(Math.round(percent)) } }),
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

  async function wait(): Promise<void> {
    while (alive && !isSettled(view.status) && 'job_id' in view.ref) {
      const outcome = await host.callTool('read_transcript', {
        job_id: view.ref.job_id,
        wait_seconds: 20,
      });
      if (!alive) return;
      if (!outcome.ok) {
        view = { ...view, status: 'failed', error: outcome.message };
      } else if (outcome.view?.kind === 'transcript') {
        view = outcome.view;
        segments = [...(view.page?.segments ?? [])];
        next = view.page?.next_page_start ?? null;
      }
      render();
      if (!isSettled(view.status)) await sleep(POLL_PAUSE_MS);
    }
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

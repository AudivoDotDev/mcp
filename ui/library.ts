/**
 * The library: the account's recent transcripts, and a way to find a show
 * and transcribe one of its episodes.
 *
 * Spending happens in one place, after the person has confirmed the cost the
 * episode list estimated; the host may ask again, since `transcribe` is
 * annotated destructive. Everything else here only reads.
 */
import type {
  EpisodesView,
  LibraryItem,
  LibraryView,
  ShowsView,
  TranscriptRef,
  TranscriptView,
} from '../src/view.js';
import type { Host } from './bridge.js';
import { append, clear, el } from './dom.js';
import { creditsLine, duration, shortDate, statusLabel } from './format.js';

export type LibraryOptions = {
  /** Open one transcript in the reader. */
  readonly onOpen: (ref: TranscriptRef) => void;
  /** A transcription the user just started, to show in the reader. */
  readonly onTranscribed: (view: TranscriptView) => void;
};

function row(item: LibraryItem, options: LibraryOptions, locale: string | undefined): HTMLElement {
  const status = statusLabel(item.status);
  const facts = [
    item.show_title,
    shortDate(item.created_at, locale),
    creditsLine(item.credits, item.status === 'cached' ? 'charged' : null),
  ].filter((fact): fact is string => fact !== null && fact !== '');
  return el(
    'li',
    {},
    el(
      'button',
      { class: 'item', attrs: { type: 'button' }, on: { click: () => options.onOpen(item.ref) } },
      el('span', { class: 'item-title' }, item.episode_title ?? 'Untitled episode'),
      el('span', { class: 'item-meta' }, facts.join(' · ')),
      el('span', { class: `chip ${status.tone}` }, status.text),
    ),
  );
}

export function mountLibrary(
  root: HTMLElement,
  host: Host,
  view: LibraryView,
  options: LibraryOptions,
): void {
  const results = el('div', { class: 'results' });
  const input = el('input', {
    class: 'search-input',
    attrs: {
      type: 'search',
      name: 'q',
      placeholder: 'Find a podcast to transcribe',
      'aria-label': 'Find a podcast to transcribe',
      maxlength: '200',
    },
  });

  function notice(text: string, tone = ''): HTMLElement {
    return el(
      'p',
      { class: `notice ${tone}`.trim(), attrs: tone === 'failed' ? { role: 'alert' } : {} },
      text,
    );
  }

  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const q = input.value.trim();
    if (q === '') return;
    clear(results);
    results.appendChild(notice('Searching…'));
    const outcome = await host.callTool('search_shows', { q, limit: 8 });
    clear(results);
    if (!outcome.ok) return void results.appendChild(notice(outcome.message, 'failed'));
    const shows = outcome.view?.kind === 'shows' ? (outcome.view as ShowsView).shows : [];
    if (shows.length === 0) {
      return void results.appendChild(
        notice(
          'No podcasts with a public feed matched. Shows only on Spotify or YouTube can’t be transcribed here.',
        ),
      );
    }
    results.appendChild(
      el(
        'ul',
        { class: 'list' },
        ...shows.map((show) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                class: 'item',
                attrs: { type: 'button' },
                on: { click: () => void episodes(show) },
              },
              el('span', { class: 'item-title' }, show.title),
              show.author === null ? null : el('span', { class: 'item-meta' }, show.author),
            ),
          ),
        ),
      ),
    );
  }

  async function episodes(show: ShowsView['shows'][number]): Promise<void> {
    clear(results);
    results.appendChild(notice('Loading episodes…'));
    const outcome = await host.callTool('list_episodes', {
      show_id: show.show_id,
      feed_url: show.feed_url,
      ...(show.itunes_id === null ? {} : { itunes_id: show.itunes_id }),
      limit: 20,
    });
    clear(results);
    if (!outcome.ok) return void results.appendChild(notice(outcome.message, 'failed'));
    const list = outcome.view?.kind === 'episodes' ? (outcome.view as EpisodesView).episodes : [];
    append(
      results,
      el('h2', { class: 'subhead' }, show.title),
      list.length === 0
        ? notice('This show has no episodes Audivo can transcribe.')
        : el('ul', { class: 'list' }, ...list.map((episode) => episodeRow(episode))),
    );
  }

  function episodeRow(episode: EpisodesView['episodes'][number]): HTMLElement {
    const facts = [
      episode.published_at === null ? null : shortDate(episode.published_at, host.locale),
      episode.duration_sec === null ? null : duration(episode.duration_sec),
      episode.is_cached ? 'already transcribed' : null,
    ].filter((fact): fact is string => fact !== null && fact !== '');
    const action = el('div', { class: 'actions' });
    const item = el(
      'li',
      { class: 'episode' },
      el('span', { class: 'item-title' }, episode.title ?? 'Untitled episode'),
      el('span', { class: 'item-meta' }, facts.join(' · ')),
      action,
    );

    function idle(): void {
      clear(action);
      action.appendChild(
        el(
          'button',
          { class: 'button', attrs: { type: 'button' }, on: { click: confirm } },
          'Transcribe',
        ),
      );
    }

    function confirm(): void {
      clear(action);
      const cost = creditsLine(episode.estimated_credits, 'estimated');
      append(
        action,
        el(
          'span',
          { class: 'confirm' },
          cost === null ? 'Transcribe this episode?' : `Transcribe for ${cost}?`,
        ),
        el(
          'button',
          {
            class: 'button primary',
            attrs: { type: 'button' },
            on: { click: () => void transcribe() },
          },
          'Transcribe',
        ),
        el('button', { class: 'link', attrs: { type: 'button' }, on: { click: idle } }, 'Cancel'),
      );
    }

    async function transcribe(): Promise<void> {
      clear(action);
      action.appendChild(el('span', { class: 'confirm' }, 'Starting…'));
      const outcome = await host.callTool('transcribe', { episode_id: episode.episode_id });
      if (!outcome.ok) {
        idle();
        action.prepend(notice(outcome.message, 'failed'));
        return;
      }
      if (outcome.view?.kind === 'transcript') options.onTranscribed(outcome.view);
    }

    idle();
    return item;
  }

  const form = el(
    'form',
    { class: 'search', attrs: { role: 'search' }, on: { submit: (event) => void search(event) } },
    input,
    el('button', { class: 'button', attrs: { type: 'submit' } }, 'Search'),
  );

  clear(root);
  root.appendChild(
    el(
      'section',
      { class: 'library' },
      el('header', {}, el('h1', { class: 'title' }, 'Transcripts')),
      form,
      results,
      view.items.length === 0
        ? notice('No transcripts yet. Find a podcast above, or ask in the chat for an episode.')
        : el('ul', { class: 'list' }, ...view.items.map((item) => row(item, options, host.locale))),
    ),
  );
}

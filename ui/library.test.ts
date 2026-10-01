// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryView } from '../src/view.js';
import { mountLibrary } from './library.js';
import { fakeHost, settle, transcriptView } from './testing.js';

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('main');
  document.body.appendChild(root);
});

const LIBRARY: LibraryView = {
  kind: 'library',
  next_cursor: null,
  items: [
    {
      ref: { read_id: 'job_cached00000000aa' },
      episode_id: 'ep_abcdefghijklmnop',
      show_title: 'Hard Fork',
      episode_title: '<script>alert(1)</script>',
      status: 'cached',
      created_at: '2026-09-30T10:00:00Z',
      credits: 2,
    },
    {
      ref: { job_id: 'job_abcdefghijklmnop' },
      episode_id: 'ep_bbbbbbbbbbbbbbbb',
      show_title: null,
      episode_title: null,
      status: 'transcribing',
      created_at: '2026-09-29T10:00:00Z',
      credits: 66,
    },
  ],
};

const button = (label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) as
    HTMLButtonElement | undefined;

/** A list row, found by its title: its text also holds its details. */
const row = (title: string) =>
  [...root.querySelectorAll('button.item')].find(
    (b) => b.querySelector('.item-title')?.textContent === title,
  ) as HTMLButtonElement | undefined;

async function submitSearch(q: string) {
  const input = root.querySelector('input')!;
  input.value = q;
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
}

describe('the library', () => {
  it('lists each transcript with its titles as text, its state, and opens it', () => {
    const onOpen = vi.fn();
    const { host } = fakeHost(() => ({ ok: true, view: undefined }));
    mountLibrary(root, host, LIBRARY, { onOpen, onTranscribed: vi.fn() });
    const items = [...root.querySelectorAll('.item')];
    expect(items.map((item) => item.querySelector('.item-title')!.textContent)).toEqual([
      '<script>alert(1)</script>',
      'Untitled episode',
    ]);
    expect(root.querySelector('script')).toBeNull();
    expect(items.map((item) => item.querySelector('.chip')!.textContent)).toEqual([
      'Ready',
      'Transcribing',
    ]);
    (items[1] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith({ job_id: 'job_abcdefghijklmnop' });
  });

  it('finds a show, lists its episodes, and spends nothing until the cost is confirmed', async () => {
    const onTranscribed = vi.fn();
    const { host, calls } = fakeHost(({ name }) => {
      if (name === 'search_shows') {
        return {
          ok: true,
          view: {
            kind: 'shows',
            shows: [
              {
                show_id: 'sh_abcdefghijklmnop',
                feed_url: 'https://f.example/rss',
                itunes_id: 7,
                title: 'Hard Fork',
                author: 'NYT',
              },
            ],
          },
        };
      }
      if (name === 'list_episodes') {
        return {
          ok: true,
          view: {
            kind: 'episodes',
            show_id: 'sh_abcdefghijklmnop',
            next_cursor: null,
            episodes: [
              {
                episode_id: 'ep_abcdefghijklmnop',
                title: 'On AI',
                published_at: '2026-09-28T00:00:00Z',
                duration_sec: 3600,
                is_cached: false,
                estimated_credits: 60,
              },
            ],
          },
        };
      }
      return { ok: true, view: transcriptView({ status: 'queued', page: null }) };
    });
    mountLibrary(root, host, { ...LIBRARY, items: [] }, { onOpen: vi.fn(), onTranscribed });

    await submitSearch('hard fork');
    row('Hard Fork')!.click();
    await settle();
    expect(calls.at(-1)).toEqual({
      name: 'list_episodes',
      args: {
        show_id: 'sh_abcdefghijklmnop',
        feed_url: 'https://f.example/rss',
        itunes_id: 7,
        limit: 20,
      },
    });

    // The first press asks; only the second spends.
    button('Transcribe')!.click();
    expect(root.querySelector('.confirm')!.textContent).toBe('Transcribe for about 60 credits?');
    expect(calls.map((call) => call.name)).not.toContain('transcribe');
    button('Cancel')!.click();
    expect(calls.map((call) => call.name)).not.toContain('transcribe');

    button('Transcribe')!.click();
    [...root.querySelectorAll('button.primary')]
      .find((b) => b.textContent === 'Transcribe')!
      .dispatchEvent(new Event('click'));
    await settle();
    expect(calls.at(-1)).toEqual({
      name: 'transcribe',
      args: { episode_id: 'ep_abcdefghijklmnop' },
    });
    expect(onTranscribed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcript' }));
  });

  it('says plainly when nothing matched, and why a show may be missing', async () => {
    const { host } = fakeHost(() => ({ ok: true, view: { kind: 'shows', shows: [] } }));
    mountLibrary(root, host, LIBRARY, { onOpen: vi.fn(), onTranscribed: vi.fn() });
    await submitSearch('nothing');
    expect(root.querySelector('.results')!.textContent).toContain('Spotify or YouTube');
  });

  it('shows a refusal in its own words, and names no plan', async () => {
    const { host } = fakeHost(() => ({
      ok: false,
      message: 'Your Audivo account doesn’t have enough credits for this episode.',
      reference: 'req_1',
    }));
    mountLibrary(root, host, LIBRARY, { onOpen: vi.fn(), onTranscribed: vi.fn() });
    await submitSearch('x');
    const alert = root.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain('enough credits');
    expect(alert).not.toMatch(/upgrade|plan|subscribe|\$/i);
  });
});

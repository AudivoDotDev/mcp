/** A fake host for the views' suites: records every call, answers from a script. */
import type { TranscriptView, ViewSegment } from '../src/view.js';
import type { Host, Outcome } from './bridge.js';

export type Call = { readonly name: string; readonly args: Record<string, unknown> };

export function fakeHost(
  answer: (call: Call, index: number) => Outcome | Promise<Outcome>,
  options: { readonly inline?: boolean; readonly canExpand?: boolean } = {},
) {
  const calls: Call[] = [];
  const notes: string[] = [];
  let expands = 0;
  const host: Host = {
    async callTool(name, args) {
      const call = { name, args };
      calls.push(call);
      return answer(call, calls.length - 1);
    },
    async expand() {
      expands += 1;
      return options.canExpand === true;
    },
    noteOpened(text) {
      notes.push(text);
    },
    locale: 'en-US',
    inline: options.inline ?? true,
  };
  return { host, calls, notes, expands: () => expands };
}

export function lines(count: number, from = 0): ViewSegment[] {
  return Array.from({ length: count }, (_u, i) => ({
    start: (from + i) * 5,
    end: (from + i) * 5 + 4,
    text: `Line ${from + i} about credits and transcripts.`,
  }));
}

export function transcriptView(overrides: Partial<TranscriptView> = {}): TranscriptView {
  return {
    kind: 'transcript',
    ref: { job_id: 'job_abcdefghijklmnop' },
    episode_id: 'ep_abcdefghijklmnop',
    show_title: 'Hard Fork',
    episode_title: 'An episode about AI',
    status: 'completed',
    duration_sec: 3120,
    language: 'en',
    credits: 52,
    credits_kind: 'settled',
    progress_percent: null,
    page: { page_start: 0, segments: lines(10), segments_total: 30, next_page_start: 10 },
    oversized: false,
    error: null,
    ...overrides,
  };
}

/** Lets pending promise chains run, so a view can finish reacting to an answer. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

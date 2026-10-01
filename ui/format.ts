/** How the app words numbers, times and states. Pure, so it is tested without a page. */

/** `1:02:03` past an hour, `2:03` under it: a transcript timestamp. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `52 min`, `1 h 4 min`, `45 s`. */
export function duration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function credits(amount: number): string {
  return `${amount} ${amount === 1 ? 'credit' : 'credits'}`;
}

/** What a cost figure means, said briefly next to it. */
export function creditsLine(
  amount: number | null,
  kind: 'settled' | 'charged' | 'reserved' | 'estimated' | null,
): string | null {
  if (amount === null) return null;
  switch (kind) {
    case 'reserved':
      return `up to ${credits(amount)}`;
    case 'estimated':
      return `about ${credits(amount)}`;
    default:
      return credits(amount);
  }
}

/** A short date in the user's locale: `Sep 30`, or `Sep 30, 2025` from another year. */
export function shortDate(iso: string, locale?: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A BCP-47 code as the user's language names it, or the code itself. */
export function languageName(code: string | null, locale?: string): string | null {
  if (code === null || code === '') return null;
  try {
    return (
      new Intl.DisplayNames(locale === undefined ? undefined : [locale], {
        type: 'language',
      }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

export type Tone = 'ready' | 'working' | 'failed' | 'muted';

/** The API's states, as the app says them. */
export function statusLabel(status: string): { readonly text: string; readonly tone: Tone } {
  switch (status) {
    case 'completed':
    case 'cached':
      return { text: 'Ready', tone: 'ready' };
    case 'validating':
    case 'queued':
      return { text: 'Queued', tone: 'working' };
    case 'downloading':
      return { text: 'Downloading', tone: 'working' };
    case 'transcribing':
    case 'merging':
      return { text: 'Transcribing', tone: 'working' };
    case 'failed':
      return { text: 'Failed', tone: 'failed' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
    default:
      return { text: status, tone: 'muted' };
  }
}

/** Whether a state is the end of a job: nothing more will happen to it. */
export function isSettled(status: string): boolean {
  return ['completed', 'cached', 'failed', 'cancelled'].includes(status);
}

/**
 * A deep link's app-relative path (`/jobs/job_…` or `/reads/job_…`) as the
 * transcript it names, or `undefined` for anything else.
 */
export function refFromPath(
  path: string,
): { readonly job_id: string } | { readonly read_id: string } | undefined {
  const match = /^\/(jobs|reads)\/(job_[A-Za-z0-9]{16,32})\/?$/.exec(path);
  if (match === null) return undefined;
  return match[1] === 'jobs' ? { job_id: match[2]! } : { read_id: match[2]! };
}

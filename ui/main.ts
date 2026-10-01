/**
 * The Audivo app's entry: connect to the host, match its look, and show
 * whichever view the tool result asks for (ADR-0036).
 *
 * `transcribe` opens the reader; `list_transcripts` (also ChatGPT's sidebar
 * and conversation-tab entrypoint) opens the library, from which a
 * transcript opens in the reader with a way back. A deep link
 * (`/jobs/job_…`, `/reads/job_…`) opens that transcript directly.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
import type { LibraryView, TranscriptRef, TranscriptView, View } from '../src/view.js';
import { outcomeOf, type Host, type ToolResult } from './bridge.js';
import { el, clear } from './dom.js';
import { refFromPath } from './format.js';
import { mountLibrary } from './library.js';
import { mountReader, type MountedReader } from './reader.js';

type HostContext = ReturnType<App['getHostContext']>;

const root = document.getElementById('app')!;
const app = new App(
  { name: 'Audivo', version: '0.4.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);

let context: HostContext;
let reader: MountedReader | undefined;
let library: LibraryView | undefined;
let rendered = false;

function applyContext(next: HostContext): void {
  context = { ...context, ...next };
  if (next?.theme !== undefined) applyDocumentTheme(next.theme);
  if (next?.styles?.variables !== undefined) applyHostStyleVariables(next.styles.variables);
  if (next?.styles?.css?.fonts !== undefined) applyHostFonts(next.styles.css.fonts);
  document.documentElement.dataset.mode = context?.displayMode ?? 'inline';
}

const host: Host = {
  async callTool(name, args) {
    try {
      return outcomeOf((await app.callServerTool({ name, arguments: args })) as ToolResult);
    } catch {
      return {
        ok: false,
        message: 'Audivo couldn’t be reached. Try again in a moment.',
        reference: undefined,
      };
    }
  },
  async expand() {
    if (!(context?.availableDisplayModes ?? []).includes('fullscreen')) return false;
    try {
      const { mode } = await app.requestDisplayMode({ mode: 'fullscreen' });
      return mode === 'fullscreen';
    } catch {
      return false;
    }
  },
  noteOpened(text) {
    void app.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => {});
  },
  get locale() {
    return context?.locale;
  },
  get inline() {
    return (context?.displayMode ?? 'inline') === 'inline';
  },
};

function message(text: string, reference?: string): void {
  reader?.destroy();
  reader = undefined;
  clear(root);
  root.appendChild(
    el(
      'section',
      { class: 'empty' },
      el('p', { class: 'notice failed', attrs: { role: 'alert' } }, text),
      reference === undefined ? null : el('p', { class: 'hint' }, `Reference: ${reference}`),
    ),
  );
}

function showReader(view: TranscriptView, fromLibrary: boolean): void {
  reader?.destroy();
  rendered = true;
  reader = mountReader(root, host, view, {
    announce: fromLibrary,
    ...(library === undefined ? {} : { onBack: () => showLibrary(library!) }),
  });
}

function showLibrary(view: LibraryView): void {
  reader?.destroy();
  reader = undefined;
  rendered = true;
  library = view;
  mountLibrary(root, host, view, {
    onOpen: (ref) => void open(ref),
    onTranscribed: (transcript) => showReader(transcript, false),
  });
}

async function open(ref: TranscriptRef): Promise<void> {
  reader?.destroy();
  reader = undefined;
  clear(root);
  root.appendChild(el('p', { class: 'notice' }, 'Opening the transcript…'));
  const outcome = await host.callTool('read_transcript', { ...ref });
  if (!outcome.ok) return message(outcome.message, outcome.reference);
  if (outcome.view?.kind === 'transcript') showReader(outcome.view, true);
}

function show(view: View | undefined): void {
  if (view?.kind === 'transcript') showReader(view, false);
  else if (view?.kind === 'library') showLibrary(view);
}

function followDeepLink(): void {
  const link = context?.['openai/deepLink'] as { url?: unknown } | undefined;
  const ref = typeof link?.url === 'string' ? refFromPath(link.url) : undefined;
  if (ref !== undefined) void open(ref);
}

app.ontoolresult = (result) => {
  const outcome = outcomeOf(result as ToolResult);
  if (!outcome.ok) message(outcome.message, outcome.reference);
  else show(outcome.view);
};
app.onhostcontextchanged = (next) => {
  const before = context?.['openai/deepLink'];
  applyContext(next as HostContext);
  if (next !== undefined && 'openai/deepLink' in next && next['openai/deepLink'] !== before) {
    followDeepLink();
  } else if (next?.displayMode !== undefined) {
    reader?.displayModeChanged(next.displayMode === 'inline');
  }
};
app.onteardown = async () => {
  reader?.destroy();
  return {};
};

const opener = () => context?.toolInfo?.tool.name;

await app.connect();
applyContext(app.getHostContext());
if (!rendered) {
  clear(root);
  root.appendChild(
    el(
      'p',
      { class: 'notice', attrs: { role: 'status' } },
      opener() === 'list_transcripts' ? 'Loading your transcripts…' : 'Transcribing…',
    ),
  );
}
followDeepLink();

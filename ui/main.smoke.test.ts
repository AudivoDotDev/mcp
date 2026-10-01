// @vitest-environment happy-dom
/**
 * The app's whole start, against a host that speaks the MCP Apps protocol
 * over `postMessage` the way ChatGPT and Claude do: the handshake, the first
 * render from the tool result, and a page fetched back through the server.
 * The views have their own suites; this is the wiring between them and a host.
 */
import { describe, expect, it } from 'vitest';
import { lines, settle, transcriptView } from './testing.js';

type Message = {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
};

describe('the app in a host', () => {
  it('connects, renders what the host hands it, and pages through the server', async () => {
    const root = document.createElement('main');
    root.id = 'app';
    document.body.appendChild(root);

    const sent: Message[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const parent = {
      postMessage(message: Message) {
        sent.push(message);
        queueMicrotask(() => respond(message));
      },
    };
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    const deliver = (data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: parent as never }));

    function respond(message: Message): void {
      if (message.id === undefined) return;
      if (message.method === 'ui/initialize') {
        deliver({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            hostInfo: { name: 'suite-host', version: '0' },
            hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } },
            hostContext: {
              theme: 'dark',
              displayMode: 'fullscreen',
              availableDisplayModes: ['inline', 'fullscreen'],
              locale: 'en-US',
              'openai/interactionCursor': 'default',
              toolInfo: { tool: { name: 'transcribe', inputSchema: { type: 'object' } } },
            },
          },
        });
      }
      if (message.method === 'tools/call') {
        toolCalls.push(message.params ?? {});
        deliver({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: '{}' }],
            _meta: {
              'audivo/view': transcriptView({
                page: {
                  page_start: 10,
                  segments: lines(5, 10),
                  segments_total: 15,
                  next_page_start: null,
                },
              }),
            },
          },
        });
      }
    }

    await import('./main.js');
    await settle();

    // The handshake happened, and the host's theme was taken.
    expect(sent.map((m) => m.method)).toContain('ui/initialize');
    expect(sent.map((m) => m.method)).toContain('ui/notifications/initialized');
    expect(document.documentElement.dataset.mode).toBe('fullscreen');
    // The person's cursor preference in ChatGPT Desktop.
    expect(document.documentElement.style.getPropertyValue('--cursor-interaction')).toBe('default');

    // The first render comes from the tool result, not from a second call.
    deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        content: [{ type: 'text', text: '{}' }],
        _meta: { 'audivo/view': transcriptView() },
      },
    });
    await settle();
    expect(document.querySelector('.title')?.textContent).toBe('An episode about AI');
    expect(document.querySelectorAll('.segment')).toHaveLength(10);
    expect(toolCalls).toEqual([]);

    // A later page goes back through the server, by the host.
    const more = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Load more',
    )!;
    more.click();
    for (let i = 0; i < 5; i += 1) await settle();
    // (The bridge also attaches a progress token, which the host may use.)
    expect(toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_transcript',
        arguments: { job_id: 'job_abcdefghijklmnop', page_start: 10 },
      }),
    ]);
    expect(document.querySelectorAll('.segment')).toHaveLength(15);

    // From the library, opening a transcript attaches it to the conversation:
    // a chip labelled for the person, text with ids alone for the model.
    deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        content: [{ type: 'text', text: '{}' }],
        _meta: {
          'audivo/view': {
            kind: 'library',
            next_cursor: null,
            items: [
              {
                ref: { job_id: 'job_abcdefghijklmnop' },
                episode_id: 'ep_abcdefghijklmnop',
                show_title: 'Hard Fork',
                episode_title: 'An episode about AI',
                status: 'completed',
                created_at: '2026-09-30T10:00:00Z',
                credits: 52,
              },
            ],
          },
        },
      },
    });
    await settle();
    (document.querySelector('button.item') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i += 1) await settle();
    const attached = sent.find((m) => m.method === 'ui/update-model-context');
    const block = (attached?.params?.content as Record<string, unknown>[] | undefined)?.[0];
    expect(block?._meta).toEqual({ 'openai/title': 'Hard Fork: An episode about AI' });
    expect(String(block?.text)).toContain('job_id job_abcdefghijklmnop');
    expect(String(block?.text)).not.toContain('Hard Fork');
  });
});

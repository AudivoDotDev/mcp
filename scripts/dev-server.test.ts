import { describe, expect, it } from 'vitest';
import {
  createDevProxy,
  isServerSource,
  restartPolicy,
  type ChildEvents,
  type InFlight,
  type RestartPolicy,
} from './dev-server.js';

type Line = Record<string, unknown>;

/** A server the proxy launched: what it was sent, and a way to answer. */
type FakeServer = {
  readonly received: Line[];
  readonly events: ChildEvents;
  killed: boolean;
  say(message: Line): void;
};

function harness(policy: (inFlight: readonly InFlight[]) => RestartPolicy = () => 'fail') {
  const toClient: Line[] = [];
  const servers: FakeServer[] = [];
  const seen: InFlight[][] = [];
  let now = 0;
  const proxy = createDevProxy({
    spawn: (events) => {
      const server: FakeServer = {
        received: [],
        events,
        killed: false,
        say: (message) => events.line(JSON.stringify(message)),
      };
      servers.push(server);
      return {
        send: (line) => void server.received.push(JSON.parse(line) as Line),
        kill: () => {
          server.killed = true;
        },
      };
    },
    toClient: (line) => void toClient.push(JSON.parse(line) as Line),
    log: () => {},
    now: () => now,
    policy: (inFlight) => {
      seen.push([...inFlight]);
      return policy(inFlight);
    },
  });
  proxy.start();
  const send = (message: Line) => proxy.fromClient(JSON.stringify(message));
  const latest = () => servers[servers.length - 1]!;
  return {
    proxy,
    toClient,
    servers,
    seen,
    send,
    latest,
    tick: (ms: number) => {
      now += ms;
    },
    /** A connected session: the client's handshake, answered by the first server. */
    connect() {
      send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 'x' } });
      latest().say({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    /** The new server answers the proxy's replayed handshake. */
    answerReplay() {
      const replay = latest().received.find((message) => message.method === 'initialize')!;
      latest().say({ jsonrpc: '2.0', id: replay.id, result: { capabilities: {} } });
    },
  };
}

const call = (id: number, tool: string): Line => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: tool, arguments: {} },
});

describe('the dev server proxy', () => {
  it('passes the first session straight through, both ways', () => {
    const h = harness();
    h.connect();
    h.send(call(1, 'search_shows'));
    h.latest().say({ jsonrpc: '2.0', id: 1, result: { content: [] } });

    expect(h.servers).toHaveLength(1);
    expect(h.latest().received.map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(h.toClient.map((message) => message.id)).toEqual([0, 1]);
  });

  it('restarts on a change, replaying the handshake the client already made', () => {
    const h = harness();
    h.connect();
    h.proxy.sourceChanged(['transcribe.ts']);

    const [old, fresh] = h.servers;
    expect(old!.killed).toBe(true);
    expect(fresh!.received).toEqual([
      expect.objectContaining({ method: 'initialize', params: { protocolVersion: 'x' } }),
    ]);

    // A request that arrives mid-restart waits for the new server to be ready.
    h.send(call(2, 'search_shows'));
    expect(fresh!.received).toHaveLength(1);

    h.answerReplay();
    expect(fresh!.received.map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    // The replay's answer is the proxy's own; the client hears that the tools changed.
    expect(h.toClient.slice(1)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    ]);
  });

  it('drops anything a replaced server says after it was replaced', () => {
    const h = harness();
    h.connect();
    h.proxy.sourceChanged(['server.ts']);
    h.servers[0]!.say({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
    h.servers[0]!.events.exit('SIGTERM');

    expect(h.toClient).toHaveLength(1); // the first handshake's answer, and nothing since
  });

  it('keeps the session when a save breaks startup, and recovers on the next request', () => {
    const h = harness();
    h.connect();
    h.proxy.sourceChanged(['tools.ts']);
    h.send(call(3, 'search_shows'));
    h.latest().events.exit('exit code 1'); // a syntax error: it died before answering the replay

    expect(h.toClient.at(-1)).toMatchObject({
      id: 3,
      error: { message: expect.stringContaining('failed to start') },
    });

    // Fixed and saved (or retried): the next request starts a server again.
    h.send(call(4, 'search_shows'));
    expect(h.servers).toHaveLength(3);
    h.answerReplay();
    expect(h.latest().received.at(-1)).toMatchObject({ id: 4, method: 'tools/call' });
  });

  it('asks the policy only about what is running, and fails it on "fail"', () => {
    const h = harness(() => 'fail');
    h.connect();
    h.send(call(5, 'transcribe'));
    h.tick(1500);
    h.proxy.sourceChanged(['transcribe.ts']);

    expect(h.seen).toEqual([
      [{ id: 5, method: 'tools/call', tool: 'transcribe', movesAudio: false, ageMs: 1500 }],
    ]);
    expect(h.toClient.at(-1)).toMatchObject({ id: 5, error: { message: expect.any(String) } });
    h.answerReplay();
    expect(h.latest().received.some((message) => message.id === 5)).toBe(false);
  });

  it('sends running requests again to the new server on "replay"', () => {
    const h = harness(() => 'replay');
    h.connect();
    h.send(call(6, 'quote'));
    h.proxy.sourceChanged(['tools.ts']);
    h.answerReplay();

    expect(h.latest().received.at(-1)).toMatchObject({ id: 6, method: 'tools/call' });
    expect(h.toClient.some((message) => message.id === 6)).toBe(false);
  });

  it('finishes running requests on the old code on "wait", letting a cancel through', () => {
    const h = harness(() => 'wait');
    h.connect();
    h.send(call(7, 'transcribe'));
    h.proxy.sourceChanged(['transcribe.ts']);
    expect(h.servers).toHaveLength(1);

    h.send(call(8, 'search_shows')); // new work waits for the new code
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    expect(h.servers[0]!.received.at(-1)).toMatchObject({ method: 'notifications/cancelled' });

    h.servers[0]!.say({ jsonrpc: '2.0', id: 7, result: { content: [] } });
    expect(h.servers).toHaveLength(2);
    h.answerReplay();
    expect(h.latest().received.at(-1)).toMatchObject({ id: 8 });
  });
});

describe('restartPolicy', () => {
  const running = (tool: string, args: Line): Line => ({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  /** What the policy is shown for one running call, through the proxy itself. */
  function shown(call: Line): InFlight {
    const h = harness();
    h.connect();
    h.send(call);
    h.proxy.sourceChanged(['tools.ts']);
    return h.seen[0]![0]!;
  }

  it('marks the calls that upload audio, the way transcribe routes them', () => {
    const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const apple = 'https://podcasts.apple.com/us/podcast/x/id1?i=1000600000000';
    expect(shown(running('transcribe', { path: '/tmp/a.m4a' })).movesAudio).toBe(true);
    expect(shown(running('transcribe', { url: youtube })).movesAudio).toBe(true);
    expect(shown(running('upload_audio', { path: '/tmp/a.m4a' })).movesAudio).toBe(true);
    expect(shown(running('transcribe', { url: apple })).movesAudio).toBe(false);
    expect(shown(running('transcribe', { episode_id: 'ep_aaaaaaaaaaaaaaaa' })).movesAudio).toBe(
      false,
    );
    expect(shown(running('confirm', {})).movesAudio).toBe(false);
  });

  it('replays everything that resolves to the same job, and lets uploads finish', () => {
    const call = (movesAudio: boolean): InFlight => ({
      id: 1,
      method: 'tools/call',
      tool: 'transcribe',
      movesAudio,
      ageMs: 0,
    });
    expect(restartPolicy([call(false)])).toBe('replay');
    expect(restartPolicy([call(false), call(false)])).toBe('replay');
    // One upload in the batch is enough: replaying it could start a second job.
    expect(restartPolicy([call(false), call(true)])).toBe('wait');
  });
});

describe('isServerSource', () => {
  it('restarts for server code, not for tests or their fakes', () => {
    expect(isServerSource('transcribe.ts')).toBe(true);
    expect(isServerSource('contract/types.ts')).toBe(true);
    expect(isServerSource('transcribe.test.ts')).toBe(false);
    expect(isServerSource('testing/fake-api.ts')).toBe(false);
    expect(isServerSource('notes.md')).toBe(false);
  });
});

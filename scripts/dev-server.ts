/**
 * A development server that picks up edits to `src/` without a build and
 * without reconnecting the client. Run it as `npm run dev:server`; the README's
 * Development section has the Claude Code line.
 *
 * It is a proxy. The client talks to it; it runs `src/bin.ts` through tsx and
 * forwards every line both ways. A stdio session is one handshake, so when a
 * source file changes a plain restart would leave the new process waiting for
 * an `initialize` the client already sent. Instead the proxy starts a fresh
 * server, replays the client's recorded `initialize` into it, and tells the
 * client `notifications/tools/list_changed`, so a changed description or a new
 * tool is read again too. A save that breaks startup does not end the session:
 * requests are answered with an error saying so, and the next request or save
 * tries again.
 *
 * Development only: `files` in package.json keeps `scripts/` out of the
 * published package.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { youtubeVideoId } from '../src/youtube-url.js';

type JsonRpcId = string | number;

type Message = {
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

type Request = Message & { readonly id: JsonRpcId; readonly method: string };

/** One running server, as the proxy drives it. */
export type Child = {
  send(line: string): void;
  kill(): void;
};

/** What a server reports back: each stdout line, and its end, once. */
export type ChildEvents = {
  readonly line: (line: string) => void;
  readonly exit: (detail: string) => void;
};

/** A request the old server has not answered yet, as a restart policy sees it. */
export type InFlight = {
  readonly id: JsonRpcId;
  readonly method: string;
  /** For `tools/call`: which tool. */
  readonly tool?: string;
  /**
   * Whether the call uploads audio: `upload_audio`, or a `transcribe` of a
   * file path or a YouTube link. Sent again, it uploads again — a new
   * `upload_id`, so a new idempotency key, and a second job if the first has
   * not finished.
   */
  readonly movesAudio: boolean;
  /** How long the old server has been working on it. */
  readonly ageMs: number;
};

export type RestartPolicy = 'wait' | 'fail' | 'replay';

export type DevProxyDeps = {
  readonly spawn: (events: ChildEvents) => Child;
  readonly toClient: (line: string) => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly policy: (inFlight: readonly InFlight[]) => RestartPolicy;
};

export type DevProxy = {
  start(): void;
  fromClient(line: string): void;
  sourceChanged(files: readonly string[]): void;
  stop(): void;
};

/**
 * Ids the proxy's own replayed `initialize` carries. A string, where clients
 * number their requests, so the answer can never be mistaken for one of theirs.
 */
const REINIT_ID_PREFIX = 'audivo-dev-reinit-';

/** JSON-RPC's internal error: the request was fine, the server was not there. */
const SERVER_UNAVAILABLE = -32603;

type Pending = { readonly request: Request; readonly line: string; readonly startedAt: number };

export function createDevProxy(deps: DevProxyDeps): DevProxy {
  let child: Child | undefined;
  // Bumped on every launch; events from a replaced server carry an old value
  // and are dropped, so a killed server's last words never reach the client.
  let generation = 0;
  let state: 'ready' | 'starting' | 'draining' | 'broken' = 'ready';
  // The client's own `initialize`, replayed into every server after the first.
  let handshake: { readonly params: unknown; initialized: boolean } | undefined;
  // Client lines that arrived while no server could take them.
  let held: string[] = [];
  // Requests the current server has not answered, by serialized id, so that
  // `1` and `"1"` stay two requests.
  const inFlight = new Map<string, Pending>();
  let reloadStartedAt = 0;

  function launch(): void {
    const mine = ++generation;
    child = deps.spawn({
      line: (line) => {
        if (mine === generation) fromServer(line);
      },
      exit: (detail) => {
        if (mine === generation) serverExited(detail);
      },
    });
    if (handshake === undefined) {
      // No client has connected yet: its own `initialize` will do.
      state = 'ready';
      flush();
      return;
    }
    state = 'starting';
    child.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: `${REINIT_ID_PREFIX}${mine}`,
        method: 'initialize',
        params: handshake.params,
      }),
    );
  }

  function restart(): void {
    reloadStartedAt = deps.now();
    const old = child;
    child = undefined;
    // Launch first, so the old server's exit arrives under a stale generation.
    launch();
    old?.kill();
  }

  function fromServer(line: string): void {
    const message = parse(line);
    if (message !== undefined && isResponse(message) && isReplayId(message.id)) {
      // The replayed handshake's answer. The client had its own long ago.
      if (handshake?.initialized) child?.send(notification('notifications/initialized'));
      state = 'ready';
      deps.toClient(notification('notifications/tools/list_changed'));
      deps.log(`reloaded in ${deps.now() - reloadStartedAt} ms`);
      flush();
      return;
    }
    if (message !== undefined && isResponse(message)) {
      inFlight.delete(key(message.id));
      deps.toClient(line);
      if (state === 'draining' && inFlight.size === 0) restart();
      return;
    }
    deps.toClient(line);
  }

  function serverExited(detail: string): void {
    const reason =
      state === 'starting'
        ? `The development server failed to start (${detail}); its error is in the MCP log. Fix it and save, or call again to retry.`
        : `The development server stopped (${detail}); its error is in the MCP log. Call again to restart it.`;
    child = undefined;
    state = 'broken';
    for (const pending of inFlight.values()) answerWithError(pending.request.id, reason);
    inFlight.clear();
    for (const line of held) {
      const message = parse(line);
      if (message !== undefined && isRequest(message)) answerWithError(message.id, reason);
    }
    held = [];
    deps.log(reason);
  }

  function fromClient(line: string): void {
    if (line.trim() === '') return;
    const message = parse(line);
    const request = message !== undefined && isRequest(message);
    if (request && message.method === 'initialize') {
      handshake = { params: message.params, initialized: false };
    }
    if (message?.method === 'notifications/initialized' && handshake !== undefined) {
      handshake.initialized = true;
    }
    switch (state) {
      case 'ready':
        forward(line, message);
        return;
      case 'starting':
        held.push(line);
        return;
      case 'draining':
        // Only new requests wait for the new code. A cancellation, or an
        // answer to something the server asked, belongs to the old server —
        // holding a cancel for the request being drained would wait forever.
        if (request) held.push(line);
        else forward(line, message);
        return;
      case 'broken':
        // Nothing is listening. A request is worth another try (the fix may be
        // saved already, or the crash was a one-off); a notification is not.
        if (!request) return;
        held.push(line);
        deps.log('starting the server again for a request');
        restart();
        return;
    }
  }

  function forward(line: string, message: Message | undefined): void {
    if (message !== undefined && isRequest(message)) {
      inFlight.set(key(message.id), { request: message, line, startedAt: deps.now() });
    }
    child?.send(line);
  }

  function flush(): void {
    const lines = held;
    held = [];
    for (const line of lines) forward(line, parse(line));
  }

  function sourceChanged(files: readonly string[]): void {
    deps.log(`${files.join(', ')} changed`);
    if (state === 'draining') return; // already restarting once the old server is idle
    if (state !== 'ready' || inFlight.size === 0) {
      restart();
      return;
    }
    const now = deps.now();
    const running = [...inFlight.values()].map((pending) => view(pending, now));
    const decision = deps.policy(running);
    if (decision === 'wait') {
      state = 'draining';
      deps.log(`restarting once ${inFlight.size} running request(s) finish`);
      return;
    }
    if (decision === 'fail') {
      for (const pending of inFlight.values()) {
        answerWithError(
          pending.request.id,
          'The development server restarted to load a change while this was running. Call again.',
        );
      }
    } else {
      held = [...[...inFlight.values()].map((pending) => pending.line), ...held];
    }
    inFlight.clear();
    restart();
  }

  function answerWithError(id: JsonRpcId, message: string): void {
    deps.toClient(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: SERVER_UNAVAILABLE, message } }),
    );
  }

  return {
    start: launch,
    fromClient,
    sourceChanged,
    stop() {
      generation += 1;
      child?.kill();
      child = undefined;
    },
  };
}

/**
 * A source change worth a restart: TypeScript under `src/` that the server
 * runs. Tests and their fakes are not loaded by it, so saving one does not
 * interrupt a session. `file` is relative to `src/`, as `fs.watch` reports it.
 */
export function isServerSource(file: string): boolean {
  const posix = file.split(path.sep).join('/');
  return posix.endsWith('.ts') && !posix.endsWith('.test.ts') && !posix.startsWith('testing/');
}

/**
 * A source file changed while the old server is still working on requests.
 * What the restart does with them:
 *
 * - `'replay'`: restart now and send each again to the new server. Safe for
 *   almost every call. A `transcribe` of an episode or link sends the same
 *   body, so the same idempotency key and the same job; `confirm` repeats its
 *   own `idempotency_key`; the rest only read.
 * - `'wait'`: finish them on the old code, holding new requests, then restart.
 *   Nothing is repeated, but the reload waits as long as they take.
 * - `'fail'`: restart now and answer each with an error. Not used here.
 *
 * The exception to replay is a call that uploads audio. Sent again, it is a
 * new upload, and while the first job is still running the API has nothing to
 * join it to, so it would transcribe — and charge for — the same audio twice.
 * Those finish on the old code. Everything else replays, so a save takes
 * effect at once.
 */
export function restartPolicy(inFlight: readonly InFlight[]): RestartPolicy {
  return inFlight.some((request) => request.movesAudio) ? 'wait' : 'replay';
}

function view(pending: Pending, now: number): InFlight {
  const call =
    pending.request.method === 'tools/call' ? toolCall(pending.request.params) : undefined;
  return {
    id: pending.request.id,
    method: pending.request.method,
    ...(call === undefined ? {} : { tool: call.name }),
    movesAudio: call !== undefined && movesAudio(call.name, call.arguments),
    ageMs: now - pending.startedAt,
  };
}

function toolCall(params: unknown): { name: string; arguments: unknown } | undefined {
  if (typeof params !== 'object' || params === null || !('name' in params)) return undefined;
  if (typeof params.name !== 'string') return undefined;
  return { name: params.name, arguments: 'arguments' in params ? params.arguments : undefined };
}

/** The tools' own routing: `transcribe` downloads exactly what `youtubeVideoId` accepts. */
function movesAudio(tool: string, args: unknown): boolean {
  if (tool === 'upload_audio') return true;
  if (tool !== 'transcribe' || typeof args !== 'object' || args === null) return false;
  if ('path' in args && args.path !== undefined) return true;
  return 'url' in args && typeof args.url === 'string' && youtubeVideoId(args.url) !== null;
}

function parse(line: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

function isRequest(message: Message): message is Request {
  return typeof message.method === 'string' && isId(message.id);
}

function isResponse(message: Message): message is Message & { readonly id: JsonRpcId } {
  return (
    message.method === undefined && isId(message.id) && ('result' in message || 'error' in message)
  );
}

function isId(id: unknown): id is JsonRpcId {
  return typeof id === 'string' || typeof id === 'number';
}

function isReplayId(id: JsonRpcId): boolean {
  return typeof id === 'string' && id.startsWith(REINIT_ID_PREFIX);
}

function key(id: JsonRpcId): string {
  return JSON.stringify(id);
}

function notification(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method });
}

// --- Wiring: a real server process, stdio, and a watch on src/ -------------------------

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = path.join(ROOT, 'src');

/** Editors save in bursts (write, rename, touch); one restart per burst. */
const DEBOUNCE_MS = 200;

function spawnServer(events: ChildEvents): Child {
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts'], {
    cwd: ROOT,
    env: process.env,
    // stderr straight through: the server's own logs and any startup error
    // land in the client's MCP log, which is where the error message points.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let ended = false;
  const end = (detail: string) => {
    if (ended) return;
    ended = true;
    events.exit(detail);
  };
  createInterface({ input: server.stdout }).on('line', events.line);
  // `close`, not `exit`: it comes after stdout is drained, so a last answer
  // written just before a crash still reaches the client.
  server.on('close', (code, signal) => end(signal ?? `exit code ${code}`));
  server.on('error', (error) => end(error.message));
  // A write racing a server that just died; its `close` reports the death.
  server.stdin.on('error', () => {});
  return {
    send: (line) => {
      if (server.stdin.writable) server.stdin.write(`${line}\n`);
    },
    kill: () => server.kill(),
  };
}

function watchSource(onChange: (files: readonly string[]) => void): () => void {
  let changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(SOURCE, { recursive: true }, (_event, file) => {
    if (file === null || !isServerSource(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed].sort();
      changed = new Set();
      onChange(files);
    }, DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const proxy = createDevProxy({
    spawn: spawnServer,
    toClient: (line) => process.stdout.write(`${line}\n`),
    log: (line) => process.stderr.write(`audivo-dev: ${line}\n`),
    now: Date.now,
    policy: restartPolicy,
  });
  proxy.start();
  const unwatch = watchSource((files) => proxy.sourceChanged(files));
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => proxy.fromClient(line));
  const stop = () => {
    unwatch();
    proxy.stop();
    process.exit(0);
  };
  // The client closing stdin is how a stdio session ends.
  input.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

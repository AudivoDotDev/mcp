# Audivo MCP server

[![npm](https://img.shields.io/npm/v/@audivo/mcp)](https://www.npmjs.com/package/@audivo/mcp)
[![CI](https://github.com/AudivoDotDev/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AudivoDotDev/mcp/actions/workflows/ci.yml)

Podcast transcripts for Claude, ChatGPT, Codex, Cursor, and any other
[MCP](https://modelcontextprotocol.io) client, backed by the [Audivo API](https://docs.audivo.dev).
Ask for an episode; get the transcript back.

> Transcribe the latest episode of Acquired and summarise it.

Two ways to connect. The hosted endpoint serves ten tools. The local server serves the same ten, with
`transcribe` also taking a file on your machine or a YouTube link, plus `upload_audio` and
`youtube_search`.

|               | Hosted                                                            | Local                                                                       |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Where it runs | Audivo's servers                                                  | Your machine, spawned by the client                                         |
| Transport     | Streamable HTTP at `https://api.audivo.dev/mcp`                   | stdio via `npx -y @audivo/mcp@latest`                                       |
| Credential    | Sign in with OAuth, or `Authorization: Bearer hk_live_…`          | `AUDIVO_API_KEY` environment variable                                       |
| Good for      | Claude on the web and desktop, ChatGPT, anything that takes a URL | Claude Code, Codex, Cursor, VS Code, and every client that spawns a process |
| YouTube       | No                                                                | Yes, downloaded on your machine with yt-dlp                                 |

## Tools

| Tool              | What it does                                                          | Spends credits                      |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `transcribe`      | **The default.** One episode in, its transcript out, a page at a time | **Yes**, about one per audio minute |
| `search_shows`    | Find shows by name, host, or topic                                    | No                                  |
| `chart_shows`     | The current chart for a category                                      | No                                  |
| `list_episodes`   | A show's episodes, newest first                                       | No                                  |
| `quote`           | Price a selection of many episodes before anything runs               | No                                  |
| `confirm`         | Turn a quote into a job group                                         | **Yes**, up to the quote's ceiling  |
| `group_status`    | Where a group's jobs are, and which transcripts are ready             | No                                  |
| `list_groups`     | Your recent groups                                                    | No                                  |
| `cancel_group`    | Stop what has not started and release its credits                     | No                                  |
| `read_transcript` | A job's transcript, a page at a time; waits for a running job         | No                                  |
| `upload_audio`    | Announce and upload a file from this machine                          | No (local only)                     |
| `youtube_search`  | Find an episode on YouTube when it has no podcast feed                | No (local only)                     |

### `transcribe`

Pass one episode: an Apple Podcasts link, `feed_url` with `guid`, an `episode_id` from
`list_episodes`, or an `upload_id` — and on the local server, a YouTube link or an absolute `path`.

- An episode that is already transcribed comes back at once.
- A fresh one becomes a job. `transcribe` waits for it inside the call: up to 20 seconds on the
  hosted server, whose gateway allows 29, and 50 by default on the local one, which reports progress
  to clients that ask for it. If it is still running, the answer is the `job_id` and
  `read_transcript` waits the rest.
- The transcript comes a page at a time, about 40,000 characters each (roughly 50 minutes of speech).
  Each page names the exact call for the next one.
- `max_credits` refuses the call, before anything is spent, if it could cost more. A job holds its
  ceiling (the estimate plus 25%) and settles at the audio it measured, never above.
- The same call twice returns the same job, never a second charge: the idempotency key is derived
  from the request.

For many episodes at once — a chart, a back catalogue — use `quote` and then `confirm`, which
refuses unless the model restates the quote's total.

## Local: run it with `npx`

You need an API key from the [Audivo dashboard](https://dash.audivo.dev). Keys are shown once. Set the
key in the environment the client starts the server with, then add the server.

**Claude Code** (or install the [Audivo plugin](https://github.com/AudivoDotDev/skills), which adds
this server and the skill together)

```bash
claude mcp add --scope user audivo -e AUDIVO_API_KEY=hk_live_... -- npx -y @audivo/mcp@latest
```

**Codex**

```bash
codex mcp add audivo --env AUDIVO_API_KEY=hk_live_... -- npx -y @audivo/mcp@latest
```

**Cursor, Claude Desktop, Windsurf, and other JSON-configured clients**

```json
{
  "mcpServers": {
    "audivo": {
      "command": "npx",
      "args": ["-y", "@audivo/mcp@latest"],
      "env": { "AUDIVO_API_KEY": "hk_live_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "audivo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@audivo/mcp@latest"],
      "env": { "AUDIVO_API_KEY": "hk_live_..." }
    }
  }
}
```

Keep files that contain a real key out of Git and shared chats.

### Updating

`@latest` makes npx look the package up on npm each time the client starts the server, so a new
release arrives with your next session. To get it in the session you are in, restart the server: in
Claude Code, `/mcp`, choose `audivo`, then **Reconnect**. A spec without `@latest` works too, but
a bare `@audivo/mcp` resolves to a copy in the current project first, when there is one. The hosted
server at `https://api.audivo.dev/mcp` is kept current by Audivo.

### Environment

| Variable              | Required | Meaning                                                                                                                             |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AUDIVO_API_KEY`      | Yes      | Your API key. `Bearer ` in front of it is accepted and normalised.                                                                  |
| `AUDIVO_API_BASE_URL` | No       | The API origin. Defaults to `https://api.audivo.dev`. Must be a public `https` origin: no userinfo, no loopback or private address. |
| `AUDIVO_YTDLP_PATH`   | No       | A yt-dlp binary to use for YouTube, instead of one on `PATH` or the managed copy.                                                   |
| `AUDIVO_CACHE_DIR`    | No       | Where the managed yt-dlp is kept. Defaults to your user cache directory (`~/Library/Caches/audivo-mcp`, `~/.cache/audivo-mcp`, …).  |

The server writes nothing to stdout except protocol messages. Log lines go to stderr as JSON, and the
key never appears in them.

## YouTube (local server only)

When a show has no public RSS feed — many exist only on YouTube — `search_shows` finds nothing.
On the local server, `youtube_search` finds the episode and `transcribe` takes its link:

> Find the Costco episode of Acquired on YouTube and transcribe it

`transcribe` downloads the video's audio on your machine with [yt-dlp](https://github.com/yt-dlp/yt-dlp),
audio only and with no transcoding, uploads it to Audivo as your own upload, and transcribes it. The
transcript is private to your account.

yt-dlp is found in this order: `AUDIVO_YTDLP_PATH`; a `yt-dlp` on your `PATH`; otherwise the project's
official standalone binary for your platform, downloaded once from its GitHub releases into your user
cache directory and checked against that release's `SHA2-256SUMS` before it is made executable. The
package has no install script: nothing is downloaded until the first YouTube call. A managed copy
that stops working is updated to the latest release once and the call retried; a yt-dlp you
installed yourself is never touched. yt-dlp is given the Node running this server as its JavaScript
runtime.

You run the download, on your machine, under your own account; you are responsible for having the
rights to transcribe what you download, as with any upload. Audivo's servers never fetch from
YouTube, which is why the hosted server does not offer any of this.

## Upload your own audio

A recording you made, an interview, or any file you already have on disk:

> Transcribe /Users/alex/Downloads/interview.m4a

`transcribe` with `path` announces the file to Audivo (its hash, size, content type, and duration),
uploads the bytes straight to Audivo's storage with the signed URL the announcement returns, and
transcribes it. `upload_audio` does only the first two steps and returns an `upload_id`, for when you
want to quote several uploads together. The `path` must be absolute.

Limits: 1 byte to 5 GiB, up to 10 hours, and one of these content types: `audio/mpeg`, `audio/mp3`,
`audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/aac`, `audio/x-aac`, `audio/ogg`, `audio/opus`,
`audio/flac`, `audio/x-flac`, `audio/wav`, `audio/x-wav`, `audio/webm`. An upload is kept for 7
days, and its transcript is private to your account; each account may hold up to 10 GiB across 100
unexpired uploads at a time. See the [uploads guide](https://docs.audivo.dev/uploads).

## Hosted: point a client at the URL

| Setting        | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| MCP URL        | `https://api.audivo.dev/mcp`                                      |
| Transport      | Streamable HTTP                                                   |
| Authentication | OAuth (sign in to Audivo), or `Authorization: Bearer hk_live_...` |

Clients that support MCP authorization — Claude, ChatGPT, Claude Code, VS Code — need only the URL:
they open an Audivo sign-in page, you approve the connection, and it appears under **Connected apps**
in the dashboard, where you can revoke it. For example, in Claude Code:

```bash
claude mcp add --transport http --scope user audivo https://api.audivo.dev/mcp
```

For clients that take a fixed header instead, or for automation, send an API key:

```bash
claude mcp add --transport http --scope user audivo https://api.audivo.dev/mcp \
  --header "Authorization: Bearer hk_live_..."
```

Per-client instructions are in the [connection guide](https://docs.audivo.dev/mcp-server). The hosted
server is this package's `lambda` export, deployed by Audivo.

## How it works

- **Stateless.** Every tool call is one or a few typed calls on the public API with the caller's own
  credential. The server keeps no table, no cache, and no copy of a credential beyond the call in
  flight.
- **Fenced.** Show names, episode and video titles, descriptions, and transcript text are
  publisher-authored. Each reaches the model inside a fence marked as untrusted content, with a
  per-response nonce, so a podcast cannot smuggle instructions into a session.
- **Bounded.** `transcribe` spends within the job's ceiling and the caller's `max_credits`; `confirm`
  compares the total the model states with the total the quote carried and refuses on a mismatch
  without sending anything. The API applies both checks on its side too.
- **Typed by the contract.** `src/contract/types.ts` is generated from the published OpenAPI spec in
  `contract/openapi.yaml`; a test fails the build when the two drift.
- **Local only.** `upload_audio`, `youtube_search`, and the file and YouTube inputs of `transcribe`
  run on your machine; the hosted server never sees your files and never fetches from third-party
  sites.

## Development

```bash
npm ci
npm test            # vitest
npm run typecheck
npm run lint
npm run build       # dist/
```

To pick up a spec change: `npm run contract:sync` fetches the published spec and regenerates the
types. Run it locally against a key with:

```bash
AUDIVO_API_KEY=hk_live_... node dist/bin.js
```

## Releasing

Bump `version` in `package.json`, both version fields in `server.json`, and `SERVER_INFO` in
`src/server.ts` (a test fails until they agree), add a `CHANGELOG.md` entry, commit, then tag
`v<version>` and push the tag. The release workflow publishes to npm with provenance and lists the
release in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.AudivoDotDev/mcp`.

## License

[MIT](LICENSE)

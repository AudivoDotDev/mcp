# Audivo MCP server

[![npm](https://img.shields.io/npm/v/@audivo/mcp)](https://www.npmjs.com/package/@audivo/mcp)
[![CI](https://github.com/AudivoDotDev/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AudivoDotDev/mcp/actions/workflows/ci.yml)

Podcast search, episode discovery, pricing, and transcripts for Claude, Codex, Cursor, and any other
[MCP](https://modelcontextprotocol.io) client, backed by the [Audivo API](https://docs.audivo.dev).

Two ways to connect, same nine tools:

|               | Hosted                                                                           | Local                                                                       |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Where it runs | Audivo's servers                                                                 | Your machine, spawned by the client                                         |
| Transport     | Streamable HTTP at `https://api.audivo.dev/mcp`                                  | stdio via `npx -y @audivo/mcp`                                              |
| Credential    | `Authorization: Bearer hk_live_…` header                                         | `AUDIVO_API_KEY` environment variable                                       |
| Good for      | Claude on the web, ChatGPT, Claude Desktop connectors, anything that takes a URL | Claude Code, Codex, Cursor, VS Code, and every client that spawns a process |

You need an API key from the [Audivo dashboard](https://audivo.dev). Keys are shown once.

## Tools

| Tool              | What it does                                              | Spends credits                           |
| ----------------- | --------------------------------------------------------- | ---------------------------------------- |
| `search_shows`    | Find shows by name, host, or topic                        | No                                       |
| `chart_shows`     | The current chart for a category                          | No                                       |
| `list_episodes`   | A show's episodes, newest first                           | No                                       |
| `quote`           | Price a selection of episodes before anything runs        | No                                       |
| `confirm`         | Turn a quote into a job group                             | **Yes**, up to the quote's ceiling       |
| `group_status`    | Where a group's jobs are, and which transcripts are ready | No                                       |
| `list_groups`     | Your recent groups                                        | No                                       |
| `cancel_group`    | Stop what has not started and release its credits         | No                                       |
| `read_transcript` | A finished transcript, fenced for the model               | Only a cached read you have not paid for |

`confirm` is the one tool that spends. It refuses unless the model restates the quote's total, and it
takes an idempotency key so a retry cannot spend twice. Ask the user before calling it.

## Local: run it with `npx`

Set the key in the environment the client starts the server with, then add the server.

**Claude Code**

```bash
claude mcp add --scope user audivo -e AUDIVO_API_KEY=hk_live_... -- npx -y @audivo/mcp
```

**Codex**

```bash
codex mcp add audivo --env AUDIVO_API_KEY=hk_live_... -- npx -y @audivo/mcp
```

**Cursor, Claude Desktop, Windsurf, and other JSON-configured clients**

```json
{
  "mcpServers": {
    "audivo": {
      "command": "npx",
      "args": ["-y", "@audivo/mcp"],
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
      "args": ["-y", "@audivo/mcp"],
      "env": { "AUDIVO_API_KEY": "hk_live_..." }
    }
  }
}
```

Keep files that contain a real key out of Git and shared chats.

### Environment

| Variable              | Required | Meaning                                                                                                                             |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AUDIVO_API_KEY`      | Yes      | Your API key. `Bearer ` in front of it is accepted and normalised.                                                                  |
| `AUDIVO_API_BASE_URL` | No       | The API origin. Defaults to `https://api.audivo.dev`. Must be a public `https` origin: no userinfo, no loopback or private address. |

The server writes nothing to stdout except protocol messages. Log lines go to stderr as JSON, and the
key never appears in them.

## Hosted: point a client at the URL

| Setting        | Value                               |
| -------------- | ----------------------------------- |
| MCP URL        | `https://api.audivo.dev/mcp`        |
| Transport      | Streamable HTTP                     |
| Authentication | `Authorization: Bearer hk_live_...` |

For example, in Claude Code:

```bash
claude mcp add --transport http --scope user audivo https://api.audivo.dev/mcp \
  --header "Authorization: Bearer hk_live_..."
```

Per-client instructions for the hosted server, including ChatGPT and Claude on the web, are in the
[connection guide](https://docs.audivo.dev/mcp). The hosted server is this package's `lambda` export,
deployed by Audivo.

## How it works

- **Stateless.** Every tool call is one typed call on the public API with the caller's own key. The
  server keeps no table, no cache, and no copy of a credential beyond the call in flight.
- **Fenced.** Show names, episode titles, descriptions, and transcript text are publisher-authored.
  Each reaches the model inside a fence marked as untrusted content, with a per-response nonce, so a
  podcast cannot smuggle instructions into a session.
- **Gated.** `confirm` compares the total the model states with the total the quote carried and
  refuses on a mismatch without sending anything. The API applies the same check on its side.
- **Typed by the contract.** `src/contract/types.ts` is generated from the published OpenAPI spec in
  `contract/openapi.yaml`; a test fails the build when the two drift.

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

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, then tag `v<version>` and push
the tag. The release workflow publishes to npm with provenance.

## License

[MIT](LICENSE)

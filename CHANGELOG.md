# Changelog

## 0.3.0

- **`transcribe`, the default tool**: one episode in, its transcript out. It makes the API's
  single-episode submit with no quote first, waits for the job inside the call (20 seconds on the
  hosted server, 50 by default locally, with progress notifications to clients that ask), and
  returns the transcript a page at a time with the exact call for the next page. `max_credits` caps
  the spend; the idempotency key is derived from the request, so the same call never charges twice.
- **Local server: YouTube.** `transcribe` takes a YouTube link and `youtube_search` finds one. The
  audio is downloaded on your machine with yt-dlp — yours if it is on `PATH` or named by
  `AUDIVO_YTDLP_PATH`, otherwise the official standalone release, fetched once and checked against
  its `SHA2-256SUMS` — uploaded as your own, and transcribed. The hosted server offers none of this.
- **Local server: files.** `transcribe` takes an absolute `path` and uploads and transcribes it in one
  call.
- `read_transcript` returns pages (about 40,000 characters each) instead of a 12,000-character
  preview, takes `page_start`, and with `job_id` can `wait_seconds` for a running job.
- Contract 0.13.0: `upload_id` and `max_credits` on `POST /v1/transcripts`, and the four codes they
  bring — `upload_not_found`, `upload_not_received`, `upload_mismatch`, `max_credits_exceeded`.
- Server instructions tell every client that `transcribe` is the call to reach for.
- Listed in the official MCP Registry as `io.github.AudivoDotDev/mcp`, with the hosted endpoint as a
  remote. The hosted endpoint accepts OAuth: clients that support MCP authorization connect with the
  URL alone.

## 0.2.0

- Contract 0.12.0: `quote` accepts `uploads: [{ upload_id }]` as a third selection alongside `shows` and `chart`.
- `upload_audio`, a local-only tool: announces a file on the caller's machine to Audivo, PUTs it to the presigned URL that comes back, and returns an `upload_id` to quote. Local server only; the hosted endpoint does not register it.
- `upload_quota_exceeded`, a new error an account can hit on `createUpload` when it already holds 10 GiB or 100 unexpired uploads.
- `search_shows`'s description now points a caller at an empty result toward `upload_audio` or `POST /v1/uploads` for audio it already holds, since Audivo never fetches Spotify- or YouTube-only shows itself.
- The local server gains two runtime dependencies, `file-type` (container detection) and `music-metadata` (duration), used only by `upload_audio`; the hosted handler does not load them.

## 0.1.0

First public release.

- Nine tools over the Audivo API: `search_shows`, `chart_shows`, `list_episodes`, `quote`, `confirm`, `group_status`, `list_groups`, `cancel_group`, `read_transcript`.
- Local server over stdio: `npx -y @audivo/mcp` with `AUDIVO_API_KEY` in the environment.
- The hosted server's Lambda handler, exported as `@audivo/mcp/lambda`.
- Every publisher-authored string reaches the model fenced as untrusted content, and `confirm` refuses to spend unless the model restates the quote's total.

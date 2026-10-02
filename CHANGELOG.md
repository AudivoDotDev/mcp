# Changelog

## 0.4.2

Fewer requests while waiting, and a wait that survives a throttle:

- **The reader card looks at a running job every 20 seconds**, one request a look, instead of
  holding 20-second waits open back to back. A failed look no longer marks the job failed: the card
  keeps the job's last status, says it lost touch, backs off, and after four failures in a row
  offers **Retry**. Only the server says a job failed.
- **The hosted server's waits look every 10 seconds**, not every 3: two requests per 20-second
  slice, not seven. A look the API refuses for a reason that passes (a throttle, a moment it did
  not answer) ends the wait with the job's last status and how to keep waiting, instead of failing
  a call whose job was accepted.
- **`Retry-After` is relayed** as `retry_after_seconds` on the error a model reads, so it waits as
  long as the API asked instead of guessing. A throttle asking for two seconds or less is waited
  out once by the server itself before it answers.

And an episode nobody has transcribed yet can be transcribed by its id (contract 0.16.0):

- **`transcribe` takes `feed_url` and `itunes_id` beside `episode_id`**, as `list_episodes` took
  them. An id alone only worked for an episode Audivo had already transcribed, so the path a model
  takes for a new one (list, then transcribe) was refused with `episode_not_found`. The library's
  own Transcribe button sends them too.

## 0.4.1

Checked against OpenAI's MCP extensions specification and SDK source:

- Opening a transcript from the library attaches it to the ChatGPT composer as a chip labelled with
  the show and episode (`openai/title`, which ChatGPT keeps out of model input). The text the model
  reads names the transcript by id alone, so publisher titles still reach a model only fenced.
- Deep links in the older `{ path, query }` form open the transcript they name, as OpenAI's SDK
  accepts them.
- Tools that render the app also carry the flat `ui/resourceUri` key, which the MCP Apps standard's
  own helper writes for older hosts.
- Controls follow ChatGPT Desktop's cursor preference (`openai/interactionCursor`).

## 0.4.0

- **An app, for clients that render MCP Apps** (ChatGPT, Claude and others): `transcribe` shows a
  transcript reader — titles, duration, cost, the transcript with timestamps, search within it,
  more pages on demand — and a new `list_transcripts` tool shows the account's recent transcripts.
  ChatGPT also offers that library in its sidebar and as a tab beside a conversation. The app is one
  self-contained page: it loads nothing from any domain, and its data travels in each result's
  `_meta`, which hosts give the app and never the model. Clients without MCP Apps get the same text
  as before.
- **`list_transcripts`**: the account's recent transcripts, newest first, each with its show and
  episode titles (fenced) and the `job_id` or `read_id` that `read_transcript` takes.
- `transcribe` is annotated destructive: it spends credits, which cannot be undone.
- A cache hit's next page is read through `read_transcript` with the read's `read_id`, which spends
  nothing, instead of by repeating `transcribe`.
- The hosted server declares that its tools need a signed-in account (OAuth `securitySchemes`), and
  every tool gives clients short status text while it runs.
- Results and errors no longer show the model a request id; the app receives it instead.
- Hosted tool descriptions name only tools the hosted server has.
- Contract 0.15.0: `show_title` and `episode_title` on jobs, group members and reads, and `read_id`
  on reads.
- `undici` 8.11.2, which fixes the high-severity advisories reported against 8.10.0.

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

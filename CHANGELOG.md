# Changelog

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

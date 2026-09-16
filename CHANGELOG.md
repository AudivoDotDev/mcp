# Changelog

## 0.1.0

First public release.

- Nine tools over the Audivo API: `search_shows`, `chart_shows`, `list_episodes`, `quote`, `confirm`, `group_status`, `list_groups`, `cancel_group`, `read_transcript`.
- Local server over stdio: `npx -y @audivo/mcp` with `AUDIVO_API_KEY` in the environment.
- The hosted server's Lambda handler, exported as `@audivo/mcp/lambda`.
- Every publisher-authored string reaches the model fenced as untrusted content, and `confirm` refuses to spend unless the model restates the quote's total.

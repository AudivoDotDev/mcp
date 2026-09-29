/**
 * The package surface, for anyone embedding the server rather than running
 * it: the server factory and the Lambda-shaped handler, the tool tables — the
 * hosted ten, the local-only two, and the local server's whole list — the API
 * client, the base URL guard, the wait policies, and the local server's
 * configuration.
 */
export {
  API_PATHS,
  createApiClient,
  type ApiClient,
  type ApiFetch,
  type ApiFetchInit,
  type ApiFetchResponse,
  type ApiOperation,
} from './api-client.js';
export { BaseUrlError, assertApiBaseUrl, type BaseUrlErrorCode } from './base-url.js';
export {
  CLI_ENV,
  CliConfigError,
  DEFAULT_API_BASE_URL,
  configFromEnv,
  SERVED_TOOLS,
  serve,
  type CliConfig,
  type StdioOptions,
} from './cli.js';
export { ERROR_TYPES, McpToolError } from './errors.js';
export {
  LOCAL_TOOLS,
  localCatalog,
  localTools,
  servedTools,
  type LocalToolOptions,
} from './local-tools.js';
export { HOSTED_WAIT, LOCAL_WAIT, transcribeTool, type WaitPolicy } from './transcribe.js';
export { renderUpload } from './render.js';
export {
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  createHandler,
  createMcpServer,
  type Logger,
  type McpDeps,
  type McpHandler,
} from './server.js';
export { TOOLS, type AnyToolDefinition, type ToolContext } from './tools.js';

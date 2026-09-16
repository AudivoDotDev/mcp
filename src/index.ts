/**
 * The package surface, for anyone embedding the server rather than running
 * it: the server factory and the Lambda-shaped handler, the tool table, the
 * API client, the base URL guard, and the local server's configuration.
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
  serve,
  type CliConfig,
  type StdioOptions,
} from './cli.js';
export { ERROR_TYPES, McpToolError } from './errors.js';
export {
  SERVER_INFO,
  createHandler,
  createMcpServer,
  type Logger,
  type McpDeps,
  type McpHandler,
} from './server.js';
export { TOOLS, type AnyToolDefinition, type ToolContext } from './tools.js';

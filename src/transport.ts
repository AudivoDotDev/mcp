import { fetch as undiciFetch } from 'undici';
import type { ApiFetch } from './api-client.js';

/** undici's `fetch`, pinned, narrowed to the four fields the API client sends. */
export const undiciTransport: ApiFetch = (url, init) =>
  undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: init.signal,
  });

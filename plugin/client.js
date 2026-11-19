import { CacheError } from '../src/identity.js';

/** One HTTP attempt per call; a lost mutation response is never replayed. */
export class CacheClient {
  constructor({ endpoint, tokenEnv, requestTimeoutMs }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new CacheError('InvalidInput', 'endpoint must be an HTTP(S) origin without credentials or a path');
    }
    this.endpoint = url.origin;
    this.token = process.env[tokenEnv];
    this.timeoutMs = requestTimeoutMs;
  }
  async request(path, data, signal) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    let response, value;
    try {
      response = await fetch(this.endpoint + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: combined,
        redirect: 'error',
      });
      value = await response.json();
    } catch (cause) {
      throw new CacheError('TransportUnknown', 'Cache request did not return a complete response; inspect the service before starting a new rollout', { cause: cause.name });
    }
    if (!response.ok) throw new CacheError(value?.error?.code ?? 'HTTPError', value?.error?.message ?? `HTTP ${response.status}`);
    return value;
  }
  async check(backend) {
    const value = await this.request('/health');
    const expected = backend === 'layerfs' ? 'LayerFSBackend' : 'LocalBackend';
    if (value.status !== 'ok' || value.backend !== expected || typeof value.baseRef !== 'string') {
      throw new CacheError('BackendMismatch', `Expected ${expected}; check endpoint and explicit backend configuration`);
    }
  }
}

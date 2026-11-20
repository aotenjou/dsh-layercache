import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CacheError } from './identity.js';

export async function serve(cache, {
  host = '127.0.0.1',
  port = 8088,
  token,
  maxBodyBytes = 8 * 1024 * 1024
} = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    throw new CacheError('InvalidInput', 'A token is required when listening beyond loopback');
  }
  await cache.ready;
  const active = new Set();
  const handler = async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      if (token) {
        const expected = Buffer.from(`Bearer ${token}`);
        const actual = Buffer.from(req.headers.authorization ?? '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return send(401, { error: { code: 'Unauthorized', message: 'Bearer token required' } });
        }
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { status: 'ok', backend: cache.backend.constructor.name, baseRef: cache.baseRef });
      }
      if (req.method === 'GET' && url.pathname === '/v1/tools') {
        return send(200, { tools: cache.registry.describe() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/resources') {
        return send(200, { resources: cache.resourceState() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/stats') {
        return send(200, cache.stats());
      }
      if (req.method === 'GET' && url.pathname === '/v1/tree') {
        return send(200, await cache.tree(url.searchParams.get('task') || undefined));
      }
      const postRoutes = ['/v1/run', '/v1/prune', '/v1/prepare', '/v1/resources/refresh', '/v1/rollouts', '/v1/rollouts/close'];
      if (req.method === 'POST' && postRoutes.includes(url.pathname)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxBodyBytes) {
            send(413, { error: { code: 'TooLarge', message: 'Request exceeds server body limit' } });
            req.resume();
            return;
          }
          chunks.push(chunk);
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { throw new CacheError('InvalidInput', 'Request body must be JSON'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new CacheError('InvalidInput', 'Request body must be an object');
        }
        if (url.pathname === '/v1/prepare') {
          return send(200, cache.prepare(data.task, data.candidate_tools));
        }
        if (url.pathname === '/v1/resources/refresh') {
          return send(200, await cache.refreshResources(data.resources));
        }
        if (url.pathname === '/v1/run') {
          return send(200, await cache.run(data.task, data.history, {
            rollout: data.rollout,
            candidateTools: data.candidate_tools
          }));
        }
        if (url.pathname === '/v1/rollouts') {
          return send(200, cache.openRollout(data.task, data.candidate_tools));
        }
        if (url.pathname === '/v1/rollouts/close') {
          await cache.closeRollout(data.rollout);
          return send(200, { closed: true });
        }
        if (data.before !== undefined && !Number.isFinite(data.before)) {
          throw new CacheError('InvalidInput', 'before must be a millisecond timestamp');
        }
        return send(200, await cache.prune({
          before: data.before,
          scope: data.task ? cache.scope(data.task) : undefined
        }));
      }
      send(404, { error: { code: 'NotFound', message: 'Unknown route' } });
    } catch (error) {
      if (res.writableEnded) return;
      const invalid = ['InvalidInput', 'ReadOnlyViolation', 'InvalidResource', 'UndeclaredResourceDependency'].includes(error.code);
      const conflict = [
        'Capacity', 'UnknownRollout', 'RolloutFailed', 'Closed',
        'ResourceExpired', 'ResourceUnavailable', 'ResourceChanged',
        'CheckpointExpired'
      ].includes(error.code);
      send(invalid ? 400 : conflict ? 409 : 500, {
        error: {
          code: error.code ?? 'InternalError',
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {})
        }
      });
    }
  };
  const server = createServer((req, res) => {
    const work = handler(req, res);
    active.add(work);
    work.finally(() => active.delete(work));
  });
  server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...active]);
    }
  };
}

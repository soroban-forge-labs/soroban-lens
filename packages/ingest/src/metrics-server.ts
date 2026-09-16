import { createServer, type Server } from 'node:http';
import type { IngestMetrics } from './metrics.js';

/** Opt-in endpoint. Binding failure rejects startup rather than losing monitoring silently. */
export async function startMetricsServer(
  metrics: IngestMetrics,
  port = 9090,
  host = '127.0.0.1',
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : metrics.render());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

export async function closeMetricsServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

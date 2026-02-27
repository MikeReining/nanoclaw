/**
 * Minimal HTTP server for GET /health. Used by Fly.io and Docker HEALTHCHECK to detect a dead loop.
 * Returns 200 while lastSuccessfulTickAt is null (just booted) or when last success was < 15 min ago;
 * returns 500 when no successful tick in 15+ minutes.
 */
import http from 'http';

import { getLastSuccessfulTickAt } from './support/support-heartbeat.js';
import { logger } from './logger.js';

const HEALTH_STALE_MS = 15 * 60 * 1000;

export function startHealthServer(port: number): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      const last = getLastSuccessfulTickAt();
      if (last === null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', boot: true }));
        return;
      }
      const ageMs = Date.now() - last.getTime();
      if (ageMs > HEALTH_STALE_MS) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', lastSuccessfulTickAt: last.toISOString(), ageMs }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', lastSuccessfulTickAt: last.toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info({ port }, 'Health server listening');
      resolve();
    });
  });
}

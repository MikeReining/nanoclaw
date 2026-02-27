/**
 * AutoSupportClaw entry: health server on 8080, then support-triage heartbeat.
 * Single process: HTTP server for GET /health (Fly/Docker), then heartbeat loop.
 * Usage: npm run support  (or tsx src/support-index.ts)
 */
import { startHealthServer } from './health-server.js';
import { startSupportHeartbeat } from './support/support-heartbeat.js';
import { logger } from './logger.js';

const HEALTH_PORT = 8080;

async function main(): Promise<void> {
  logger.info('NanoClaw support-triage mode starting');
  await startHealthServer(HEALTH_PORT);
  await startSupportHeartbeat();
}

main().catch((err) => {
  logger.fatal({ err }, 'Support index failed');
  process.exit(1);
});

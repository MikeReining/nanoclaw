/**
 * AutoSupportClaw entry: run support-triage heartbeat only.
 * Load Brain from /app/brain (mount), poll Gmail (GMAIL_REFRESH_TOKEN), triage → switchboard.
 * Usage: npm run support  (or tsx src/support-index.ts)
 */
import { startSupportHeartbeat } from './support/support-heartbeat.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  logger.info('NanoClaw support-triage mode starting');
  await startSupportHeartbeat();
}

main().catch((err) => {
  logger.fatal({ err }, 'Support index failed');
  process.exit(1);
});

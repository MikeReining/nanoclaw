/**
 * Support heartbeat: poll Gmail unread → triage each thread → switchboard → log memory.
 */
import type { gmail_v1 } from 'googleapis';

import {
  GROK_API_KEY,
  HEARTBEAT_INTERVAL_MS,
  BRAIN_PATH,
  getTenantConfig,
  SHOPIFY_ACCESS_TOKEN,
} from './config.js';
import { createGmailClient, listUnreadThreadIds, getThread } from './gmail-support.js';
import { logger } from '../logger.js';
import { getMemorySummary, appendMemoryLog } from './memory.js';
import { runTriage } from './triage.js';
import { runSwitchboard, performEscalation } from './switchboard.js';
import fs from 'fs';
import path from 'path';

export async function runOneHeartbeatTick(
  gmail: gmail_v1.Gmail,
): Promise<'ok' | 'no_tick'> {
  const threadIds = await listUnreadThreadIds(gmail, 20);
  if (threadIds.length === 0) {
    return 'no_tick';
  }

  const memorySummary = getMemorySummary();
  let processed = 0;

  for (const threadId of threadIds) {
    const thread = await getThread(gmail, threadId);
    if (!thread || thread.messages.length === 0) continue;

    try {
      const triage = await runTriage(thread, memorySummary, GROK_API_KEY);
      await runSwitchboard(gmail, thread, triage);

      const action = triage?.action ?? 'escalate';
      const entry = `- Thread ${threadId} (${thread.subject}): action=${action}${triage?.escalation_reason ? `; escalation_reason=${triage.escalation_reason}` : ''}`;
      appendMemoryLog(entry);
      processed++;
    } catch (err) {
      logger.error({ err, threadId }, 'Heartbeat tick error for thread');
      await performEscalation(gmail, thread, {
        scenario: 'system',
        error_details: err instanceof Error ? err.message : String(err),
        remediation_steps: 'Check logs and reply manually.',
      });
      appendMemoryLog(`- Thread ${threadId} (${thread.subject}): action=escalate; escalation_reason=Heartbeat error`);
      processed++;
    }
  }

  logger.info({ processed, total: threadIds.length }, 'Heartbeat tick completed');
  return 'ok';
}

export async function startSupportHeartbeat(): Promise<void> {
  const hasBrain = fs.existsSync(path.join(BRAIN_PATH, 'skills', 'support-triage', 'SKILL.md'));
  if (!hasBrain) {
    logger.error(
      { brainPath: BRAIN_PATH },
      'Brain support-triage skill not found at BRAIN_PATH/skills/support-triage/SKILL.md',
    );
    process.exit(1);
  }

  const gmail = await createGmailClient();
  if (!gmail) {
    logger.error('Gmail client not available. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.');
    process.exit(1);
  }

  const tenant = getTenantConfig();
  const storeUrl = tenant?.shopify_store_url ?? '(none)';
  const shopifyEnabled = Boolean(
    tenant?.shopify_store_url && SHOPIFY_ACCESS_TOKEN,
  );
  logger.info(
    `[TENANT] Loaded for store ${storeUrl} | Shopify enabled: ${shopifyEnabled} (token injected at boot) | Gmail poll: ${HEARTBEAT_INTERVAL_MS}ms`,
  );

  logger.info(
    { intervalMs: HEARTBEAT_INTERVAL_MS },
    'Support heartbeat started (polling unread Gmail)',
  );

  const tick = async () => {
    try {
      const result = await runOneHeartbeatTick(gmail);
      if (result === 'no_tick') {
        logger.info('HEARTBEAT_OK (no unread threads)');
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick error');
    }
    const nextMin = Math.round(HEARTBEAT_INTERVAL_MS / 60000);
    logger.info({ nextPollInMinutes: nextMin }, 'Idle until next poll (agent is running)');
    setTimeout(tick, HEARTBEAT_INTERVAL_MS);
  };

  // Fire the first tick immediately (no await — lets scheduled ticks run)
  tick();

  // Keep the Node process alive forever so the scheduled ticks can run
  await new Promise<never>(() => {});
}

/**
 * Support heartbeat: poll Gmail recent (time-based) → Ledger check → triage → switchboard → markProcessed.
 * Idempotency and "from support" checks ensure we never miss or double-process messages.
 * Observability: 8-min tick timeout, admin dead-man's switch ping, lastSuccessfulTickAt for /health.
 */
import type { gmail_v1 } from 'googleapis';

import {
  GROK_API_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TICK_TIMEOUT_MS,
  BRAIN_PATH,
  getTenantConfig,
  getTenantId,
  SHOPIFY_ACCESS_TOKEN,
  GMAIL_NEWER_THAN_DAYS,
  GMAIL_MAX_THREADS_PER_POLL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} from './config.js';
import { createGmailClient, listRecentThreadIds, getThread } from './gmail-support.js';
import { logger } from '../logger.js';
import { getMemorySummary, appendMemoryLog } from './memory.js';
import { runTriage } from './triage.js';
import { runSwitchboard, performEscalation } from './switchboard.js';
import { hasProcessed, markProcessed } from './ledger.js';
import fs from 'fs';
import path from 'path';

/** For /health: last time a tick completed successfully (no timeout, no unhandled throw). null until first success. */
let lastSuccessfulTickAt: Date | null = null;

export function getLastSuccessfulTickAt(): Date | null {
  return lastSuccessfulTickAt;
}

/** Extract email address from "From" header (e.g. "Name <u@x.com>" or "u@x.com"). */
function emailFromFromHeader(from: string): string {
  const m = from.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return from.trim().toLowerCase();
}

/** Match <!-- test_id: UUID --> in email body; strip it and return [sanitizedBody, testId or null]. */
function extractAndStripTestId(body: string): { body: string; testId: string | null } {
  const re = /<!--\s*test_id:\s*([a-f0-9-]+)\s*-->/i;
  const m = body.match(re);
  if (!m) return { body, testId: null };
  const testId = m[1].trim();
  const sanitized = body.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { body: sanitized, testId };
}

/**
 * Run one heartbeat tick. Pass optional signal to abort fetch/LLM calls on timeout.
 * Gmail API (googleapis) does not natively accept AbortSignal; we rely on the 8-minute
 * Promise.race in the caller to bound Gmail calls (best-effort abort for network layer).
 */
export async function runOneHeartbeatTick(
  gmail: gmail_v1.Gmail,
  signal?: AbortSignal,
): Promise<'ok' | 'no_tick'> {
  const threadIds = await listRecentThreadIds(gmail, {
    newerThanDays: GMAIL_NEWER_THAN_DAYS,
    maxResults: GMAIL_MAX_THREADS_PER_POLL,
  });
  if (threadIds.length === 0) {
    return 'no_tick';
  }

  let supportEmail: string;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    supportEmail = (profile.data.emailAddress || '').trim().toLowerCase();
  } catch (err) {
    logger.error({ err }, 'Failed to get Gmail profile for support-email check');
    return 'no_tick';
  }

  const tenantId = getTenantId();
  const memorySummary = getMemorySummary();
  let processed = 0;

  for (const threadId of threadIds) {
    const thread = await getThread(gmail, threadId);
    if (!thread || thread.messages.length === 0) continue;

    const latestMessage = thread.messages[thread.messages.length - 1];
    const messageId = latestMessage?.messageId?.trim();
    if (!messageId) {
      logger.debug({ threadId }, 'Skipping thread: no messageId on latest message');
      continue;
    }

    const fromEmail = emailFromFromHeader(latestMessage.from);
    
    // Force-process test emails regardless of "from support" origin
    const hasTestMarker = latestMessage.body.includes('AUTOCLAW-TEST-ID') || latestMessage.body.includes('test_id:');
    if (hasTestMarker) {
      logger.info({ threadId }, 'Test email detected — forcing processing');
      // fall through to normal processing
    } else if (fromEmail && supportEmail && fromEmail === supportEmail) {
      logger.info({ threadId }, 'Skipping thread: latest message is from support');
      continue;
    }

    if (hasProcessed(tenantId, messageId)) {
      logger.debug({ threadId, messageId }, 'Skipping thread: already processed (Ledger)');
      continue;
    }

    // E2E test correlation: strip <!-- test_id: UUID --> from body before sending to LLM; persist test_id in Ledger.
    const latestIdx = thread.messages.length - 1;
    const latestMsg = thread.messages[latestIdx];
    const { body: sanitizedBody, testId: extractedTestId } = extractAndStripTestId(latestMsg.body);
    thread.messages[latestIdx] = { ...latestMsg, body: sanitizedBody };

    try {
      const triage = await runTriage(thread, memorySummary, GROK_API_KEY, signal);
      const outcome = await runSwitchboard(gmail, thread, triage, signal);
      markProcessed(tenantId, messageId, thread.threadId, outcome.action, outcome.escalationReason ?? undefined, {
        testId: extractedTestId ?? undefined,
        tags: undefined,
      });
      const entry = `- Thread ${threadId} (${thread.subject}): action=${outcome.action}${outcome.escalationReason ? `; escalation_reason=${outcome.escalationReason}` : ''}`;
      appendMemoryLog(entry);
      processed++;
    } catch (err) {
      logger.error({ err, threadId }, 'Heartbeat tick error for thread');
      await performEscalation(gmail, thread, {
        scenario: 'system',
        error_details: err instanceof Error ? err.message : String(err),
        remediation_steps: 'Check logs and reply manually.',
      }, signal);
      markProcessed(tenantId, messageId, thread.threadId, 'escalated', 'Heartbeat error', {
        testId: extractedTestId ?? undefined,
        tags: undefined,
      });
      appendMemoryLog(`- Thread ${threadId} (${thread.subject}): action=escalate; escalation_reason=Heartbeat error`);
      processed++;
    }
  }

  logger.info({ processed, total: threadIds.length }, 'Heartbeat tick completed');
  return processed > 0 ? 'ok' : 'no_tick';
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
    {
      intervalMs: HEARTBEAT_INTERVAL_MS,
      tickTimeoutMs: HEARTBEAT_TICK_TIMEOUT_MS,
      newerThanDays: GMAIL_NEWER_THAN_DAYS,
      maxThreads: GMAIL_MAX_THREADS_PER_POLL,
    },
    'Support heartbeat started (polling recent Gmail, Ledger-based)',
  );

  const telegramEnabled = Boolean(TELEGRAM_BOT_TOKEN?.trim() && TELEGRAM_CHAT_ID?.trim());
  if (telegramEnabled) {
    logger.info(
      { chatIdLength: TELEGRAM_CHAT_ID!.length },
      'Telegram escalation alerts: enabled',
    );
  } else {
    const missing = [];
    if (!TELEGRAM_BOT_TOKEN?.trim()) missing.push('TELEGRAM_BOT_TOKEN');
    if (!TELEGRAM_CHAT_ID?.trim()) missing.push('TELEGRAM_CHAT_ID');
    logger.warn(
      { missing },
      'Telegram escalation alerts: disabled (set in .env and restart to receive escalation alerts)',
    );
  }

  const tick = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TICK_TIMEOUT_MS);
    try {
      const result = await Promise.race([
        runOneHeartbeatTick(gmail, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Heartbeat tick timed out')));
        }),
      ]);
      clearTimeout(timeoutId);
      if (result === 'no_tick') {
        logger.info('HEARTBEAT_OK (no recent threads or all skipped)');
      }
      const adminUrl = process.env.ADMIN_HEALTHCHECK_URL;
      if (adminUrl?.trim()) {
        fetch(adminUrl).catch((err) => logger.warn({ err, url: adminUrl }, 'Admin healthcheck ping failed'));
      }
      lastSuccessfulTickAt = new Date();
    } catch (err) {
      clearTimeout(timeoutId);
      const timedOut = controller.signal.aborted;
      if (timedOut) {
        logger.error({ err }, 'Heartbeat tick timed out; next tick in 10 min');
      } else {
        logger.error({ err }, 'Heartbeat tick error');
      }
    } finally {
      const intervalSec = Math.round(HEARTBEAT_INTERVAL_MS / 1000);
      if (intervalSec < 60) {
        logger.info({ nextPollInSeconds: intervalSec }, 'Idle until next poll (agent is running)');
      } else {
        logger.info({ nextPollInMinutes: Math.round(HEARTBEAT_INTERVAL_MS / 60000) }, 'Idle until next poll (agent is running)');
      }
      setTimeout(tick, HEARTBEAT_INTERVAL_MS);
    }
  };

  tick();

  await new Promise<never>(() => {});
}

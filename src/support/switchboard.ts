/**
 * Switchboard: route triage result → ignore (archive), escalate (draft + mark handled + Telegram), shopify_lookup, auto_reply.
 * Escalation = getOrCreateEscalationLabel → createSmartDraft → markThreadHandled → sendTelegramEscalationAlert (never send live to customer).
 */
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GROK_API_KEY,
  getTenantConfig,
  getTenantId,
  SHOPIFY_ACCESS_TOKEN,
} from './config.js';
import { logger } from '../logger.js';
import type { TriageResult } from './triage.js';
import type { SupportThread, EscalationData } from './gmail-support.js';
import {
  archiveThread,
  sendReply,
  createSmartDraft,
  markThreadHandled,
  getOrCreateEscalationLabel,
} from './gmail-support.js';
import { runKbReader, runReplyGenerator } from './auto-reply-pipeline.js';
import { lookupOrder } from './shopify-client.js';
import type { gmail_v1 } from 'googleapis';

const TELEGRAM_API = 'https://api.telegram.org';

async function sendTelegram(
  text: string,
  parseMode: 'Markdown' | undefined = 'Markdown',
  signal?: AbortSignal,
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn('Telegram env missing, skipping escalation send');
    return false;
  }
  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: { chat_id: string; text: string; parse_mode?: string } = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
  };
  if (parseMode) body.parse_mode = parseMode;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) {
        logger.info('Escalation sent to Telegram');
        return true;
      }
      const resBody = await res.text();
      lastErr = new Error(`Telegram ${res.status}: ${resBody}`);
      if (res.status === 429 || res.status >= 500) {
        const backoff = [1000, 3000, 8000][attempt] ?? 8000;
        await new Promise((r) => setTimeout(r, backoff));
      } else break;
    } catch (err) {
      lastErr = err;
      const backoff = [1000, 3000, 8000][attempt] ?? 8000;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  logger.error({ err: lastErr }, 'Telegram send failed after retries');
  return false;
}

/**
 * Send escalation alert to Telegram with inline keyboard buttons.
 * URL-encoded emoji ensures deep links work reliably.
 */
async function sendTelegramEscalationAlert(
  short_reason: string,
  subject: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const urlEncodedLabelLink = 'https://mail.google.com/mail/u/0/#label/%F0%9F%9A%A8%20AutoSupport%20Escalation';
  const urlEncodedThreadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
  
  const text = `🚨 ESCALATION REQUIRED

Reason: ${short_reason}

Draft ready in thread.

🔗 Open Thread: ${urlEncodedThreadLink}
🔗 Open Escalations: ${urlEncodedLabelLink}`;

  // Inline keyboard with URL buttons
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔗 View Draft', url: urlEncodedThreadLink },
      ],
      [
        { text: '🏷️ Open Escalations', url: urlEncodedLabelLink },
      ],
    ],
  };

  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: {
    chat_id: string;
    text: string;
    parse_mode?: string;
    reply_markup?: unknown;
  } = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };

  // Only add keyboard if we have the required Telegram env vars
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    body.reply_markup = keyboard;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) {
        logger.info('Escalation sent to Telegram');
        return true;
      }
      const resBody = await res.text();
      lastErr = new Error(`Telegram ${res.status}: ${resBody}`);
      if (res.status === 429 || res.status >= 500) {
        const backoff = [1000, 3000, 8000][attempt] ?? 8000;
        await new Promise((r) => setTimeout(r, backoff));
      } else break;
    } catch (err) {
      lastErr = err;
      const backoff = [1000, 3000, 8000][attempt] ?? 8000;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  logger.error({ err: lastErr }, 'Telegram send failed after retries');
  return false;
}

/**
 * Send a fallback escalation alert when Gmail API calls fail.
 * Logs technical details for debugging, notifies user to check inbox manually.
 */
async function sendTelegramEscalationFallback(
  threadId: string,
  errorDetails: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const urlEncodedThreadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
  
  const text = `🚨 Escalation Failed: We encountered a Gmail API error.

Please check your inbox manually for the thread.

Technical details: ${errorDetails}

🔗 Open Thread: ${urlEncodedThreadLink}`;

  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: {
    chat_id: string;
    text: string;
    parse_mode?: string;
  } = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok;
  } catch (err) {
    logger.error({ err, threadId }, 'Telegram fallback alert failed');
    return false;
  }
}

export type EscalationOptions =
  | {
      scenario: 'system';
      error_details: string;
      remediation_steps: string;
      short_reason?: string;
    }
  | {
      scenario: 'customer';
      escalationData: EscalationData;
      short_reason: string;
    };

/**
 * Terminal state for every escalation: getOrCreateEscalationLabel → createSmartDraft → markThreadHandled → sendTelegramEscalationAlert.
 * Call from switchboard and from heartbeat catch. Never sends live to customer.
 */
export async function performEscalation(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  options: EscalationOptions,
  signal?: AbortSignal,
): Promise<void> {
  const last = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
  const subject = thread.subject || '(no subject)';
  const to = last?.from ?? '';
  const messageId = last?.messageId ?? '';
  const tenantId = getTenantId();
  const short_reason =
    options.scenario === 'system'
      ? (options.short_reason ?? options.error_details)
      : options.short_reason;

  try {
    // Step 1: Get or create the escalation label (tenant-scoped cache)
    const labelId = await getOrCreateEscalationLabel(gmail, tenantId);
    if (!labelId) {
      logger.warn({ threadId: thread.threadId }, 'Escalation: failed to get label ID, proceeding without label');
    }

    // Step 2: Create the smart draft with proper threading
    if (last && messageId && to) {
      const escalationData: EscalationData =
        options.scenario === 'system'
          ? {
              isConfigError: true,
              reason: options.error_details,
            }
          : options.escalationData;

      const draftCreated = await createSmartDraft(
        gmail,
        thread.threadId,
        messageId,
        escalationData,
        subject,
        to,
      );

      if (!draftCreated) {
        logger.warn({ threadId: thread.threadId }, 'Escalation: draft creation failed');
        // Send fallback alert to notify user
        await sendTelegramEscalationFallback(thread.threadId, 'Draft creation failed', signal);
      } else {
        // Step 3: Mark thread as handled (only if labelId was obtained)
        if (labelId) {
          await markThreadHandled(gmail, thread.threadId, labelId);
        } else {
          // Fallback: just add STARRED if we couldn't get the label
          await markThreadHandledLegacyFallback(gmail, thread.threadId);
        }
      }
    } else {
      logger.warn({ threadId: thread.threadId }, 'Escalation: no last message, skipping draft');
    }

    // Step 4: Send Telegram alert with inline keyboard
    const telegramSuccess = await sendTelegramEscalationAlert(
      short_reason,
      subject,
      thread.threadId,
      signal,
    );

    if (!telegramSuccess) {
      logger.warn({ threadId: thread.threadId }, 'Escalation: Telegram alert failed');
    }

    logger.info({ threadId: thread.threadId }, 'Escalation terminal state completed');
  } catch (err) {
    // Fail loud: log technical details but don't crash the heartbeat loop
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, threadId: thread.threadId }, 'Escalation failed with error');

    // Send fallback alert to notify user to check manually
    await sendTelegramEscalationFallback(
      thread.threadId,
      errorMessage,
      signal,
    );
  }
}

/**
 * Fallback: just add STARRED label when we can't get the escalation label.
 * Legacy function maintained for error recovery scenarios.
 */
async function markThreadHandledLegacyFallback(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<void> {
  try {
    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: { addLabelIds: ['STARRED'] },
    });
    logger.info({ threadId }, 'Thread marked handled (STARRED fallback)');
  } catch (err) {
    logger.error({ err, threadId }, 'markThreadHandledLegacyFallback failed');
    throw err;
  }
}

const CUSTOMER_PLACEHOLDER_DRAFT =
  "Thank you for your message. We're looking into this and will get back to you shortly.";

/** Outcome of switchboard for Ledger recording. */
export interface SwitchboardOutcome {
  action: 'ignore' | 'auto_reply' | 'shopify_lookup' | 'escalated';
  escalationReason?: string | null;
}

/** Run switchboard: perform action for this thread based on triage result. Returns outcome for Ledger. */
export async function runSwitchboard(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  triage: TriageResult | null,
  signal?: AbortSignal,
): Promise<SwitchboardOutcome> {
  // Invalid triage → escalate (draft + mark handled + Telegram)
  if (!triage) {
    await performEscalation(gmail, thread, {
      scenario: 'system',
      error_details: 'Triage output invalid.',
      remediation_steps: 'Review and reply manually.',
    }, signal);
    return { action: 'escalated', escalationReason: 'Triage output invalid.' };
  }

  switch (triage.action) {
    case 'ignore':
      await archiveThread(gmail, thread.threadId);
      logger.info({ threadId: thread.threadId }, 'Switchboard: ignored (archived)');
      return { action: 'ignore' };

    case 'escalate': {
      const reason = triage.escalation_reason || triage.reason;
      await performEscalation(gmail, thread, {
        scenario: 'customer',
        escalationData: {
          isConfigError: false,
          reason: reason,
          suggestedReply: CUSTOMER_PLACEHOLDER_DRAFT,
        },
        short_reason: reason,
      }, signal);
      logger.info({ threadId: thread.threadId }, 'Switchboard: escalated (draft + handled + Telegram)');
      return { action: 'escalated', escalationReason: reason };
    }

    case 'shopify_lookup': {
      const tenant = getTenantConfig();
      const storeUrl = tenant?.shopify_store_url;
      const accessToken = SHOPIFY_ACCESS_TOKEN.trim();
      if (!storeUrl || !accessToken) {
        logger.warn(
          { hasStoreUrl: Boolean(storeUrl), hasAccessToken: Boolean(accessToken) },
          'Switchboard: shopify_lookup skipped — store URL or SHOPIFY_ACCESS_TOKEN missing; escalating',
        );
        const reason = !storeUrl
          ? 'Shopify store URL not configured (copy tenant.json.example to tenant.json or set TENANT_OVERRIDE_SHOPIFY_STORE_URL).'
          : 'SHOPIFY_ACCESS_TOKEN not set. Parent Web Dashboard must perform OAuth and inject token at container boot.';
        await performEscalation(gmail, thread, {
          scenario: 'system',
          error_details: reason,
          remediation_steps: 'Configure Shopify (Web Dashboard OAuth → inject token) or reply manually.',
        }, signal);
        return { action: 'escalated', escalationReason: reason };
      }
      const lookup = await lookupOrder(
        storeUrl,
        accessToken,
        triage.extracted_order_number,
        triage.extracted_email ?? thread.messages[0]?.from ?? null,
      );
      if (lookup.escalation_needed || !lookup.success) {
        const reason = lookup.reason || 'Shopify lookup failed.';
        await performEscalation(gmail, thread, {
          scenario: 'system',
          error_details: reason,
          remediation_steps: 'Review and check Shopify manually.',
          short_reason: reason,
        }, signal);
        return { action: 'escalated', escalationReason: reason };
      }
      const kbContent = runKbReader(triage.target_files);
      const orderContext =
        lookup.order != null
          ? JSON.stringify({ success: lookup.success, order: lookup.order, reason: lookup.reason, flags: lookup.flags }, null, 2)
          : null;
      const { body, escalate } = await runReplyGenerator(
        thread,
        triage,
        kbContent,
        GROK_API_KEY,
        orderContext,
        signal,
      );
      if (escalate || !body.trim()) {
        const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
        await performEscalation(gmail, thread, {
          scenario: 'customer',
          escalationData: {
            isConfigError: false,
            reason: reason,
            suggestedReply: body.trim() || CUSTOMER_PLACEHOLDER_DRAFT,
          },
          short_reason: reason,
        }, signal);
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup → auto_reply escalated (no send)');
        return { action: 'escalated', escalationReason: reason };
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        await archiveThread(gmail, thread.threadId);
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup reply sent from support address');
        return { action: 'shopify_lookup' };
      }
      await performEscalation(gmail, thread, {
        scenario: 'system',
        error_details: 'Gmail send failed.',
        remediation_steps: 'Review draft and send manually.',
      }, signal);
      logger.error({ threadId: thread.threadId }, 'Switchboard: shopify_lookup send failed → escalated');
      return { action: 'escalated', escalationReason: 'Gmail send failed.' };
    }

    case 'auto_reply': {
      const kbContent = runKbReader(triage.target_files);
      const { body, escalate } = await runReplyGenerator(
        thread,
        triage,
        kbContent,
        GROK_API_KEY,
        undefined,
        signal,
      );
      if (escalate || !body.trim()) {
        const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
        await performEscalation(gmail, thread, {
          scenario: 'customer',
          escalationData: {
            isConfigError: false,
            reason: reason,
            suggestedReply: body.trim() || CUSTOMER_PLACEHOLDER_DRAFT,
          },
          short_reason: reason,
        }, signal);
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply → escalated (no send)');
        return { action: 'escalated', escalationReason: reason };
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        await archiveThread(gmail, thread.threadId);
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply sent from support address');
        return { action: 'auto_reply' };
      }
      await performEscalation(gmail, thread, {
        scenario: 'system',
        error_details: 'Gmail send failed.',
        remediation_steps: 'Review draft and send manually.',
      }, signal);
      logger.error({ threadId: thread.threadId }, 'Switchboard: auto_reply send failed → escalated');
      return { action: 'escalated', escalationReason: 'Gmail send failed.' };
    }
  }
}

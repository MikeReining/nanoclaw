/**
 * Switchboard: route triage result → no_reply (label only, no Telegram), escalate (Holding Reply + Telegram), shopify_lookup, auto_reply.
 * no_reply = apply Claw: NoReply label, leave unread, NO Telegram ping (pure noise).
 * escalate = send Holding Reply + Telegram escalation (legitimate question KB can't answer).
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
  sendReply,
  createSmartDraft,
  markThreadHandled,
  getOrCreateEscalationLabel,
  applyExclusiveStatusLabel,
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
      logger.warn(
        { status: res.status, telegramResponseBody: resBody },
        'Telegram API error (check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; ensure you started a chat with the bot)',
      );
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
 * Uses standard Gmail URLs (default browser/session routing). Multi-account disclaimer in body.
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID = owner/merchant chat (not the customer).
 */
async function sendTelegramEscalationAlert(
  short_reason: string,
  subject: string,
  threadId: string,
  customerEmail: string,
  customerSnippet: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn(
      'Telegram env missing (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset), skipping escalation alert — draft still created in Gmail',
    );
    return false;
  }

  const threadLink = `https://mail.google.com/mail/#inbox/${threadId}`;
  const labelLink = `https://mail.google.com/mail/#label/%F0%9F%A6%9E%20Claw:%20Escalated`;

  const snippetSafe = customerSnippet.replace(/`/g, "'").slice(0, 100);
  const snippetDisplay = snippetSafe + (customerSnippet.length > 100 ? '...' : '');

  const text = `🔴 ESCALATION REQUIRED

Reason: ${short_reason}

Customer: ${customerEmail}
Snippet: "${snippetDisplay}"

Draft ready in thread.

_Note: If you have multiple Gmail accounts, links may open your default browser inbox._`;

  // Inline keyboard with URL buttons (no raw URLs in message body)
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔗 View Draft', url: threadLink },
      ],
      [
        { text: '🏷️ Open Escalations', url: labelLink },
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
    // Plain text so customer snippet and reason don't need Markdown escaping
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
      logger.warn(
        { status: res.status, telegramResponseBody: resBody },
        'Telegram escalation alert API error (check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; ensure you started a chat with the bot)',
      );
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
  logger.error(
    { err: lastErr },
    'Telegram escalation alert failed after retries — see telegramResponseBody above for API error details',
  );
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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn(
      'Telegram env missing (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset), skipping fallback alert',
    );
    return false;
  }

  const threadLink = `https://mail.google.com/mail/#inbox/${threadId}`;

  const text = `🚨 Escalation Failed: We encountered a Gmail API error.

Please check your inbox manually for the thread.

Technical details: ${errorDetails}

_Note: If you have multiple Gmail accounts, links may open your default browser inbox._`;

  const keyboard = {
    inline_keyboard: [[{ text: '🔗 View Draft', url: threadLink }]],
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
    reply_markup: keyboard,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const resBody = await res.text();
      logger.warn(
        { status: res.status, telegramResponseBody: resBody, threadId },
        'Telegram fallback alert API error',
      );
    }
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
    logger.info({ threadId: thread.threadId }, 'Sending escalation alert to Telegram');
    const customerEmail = last?.from ?? '';
    const customerSnippet = last?.body ?? '';
    const telegramSuccess = await sendTelegramEscalationAlert(
      short_reason,
      subject,
      thread.threadId,
      customerEmail,
      customerSnippet,
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
  action: 'no_reply' | 'auto_reply' | 'shopify_lookup' | 'escalated';
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
    case 'no_reply':
      // Pure noise: apply label, leave unread, NO Telegram ping
      await applyExclusiveStatusLabel(gmail, thread.threadId, 'Claw: NoReply');
      logger.info({ threadId: thread.threadId }, 'Switchboard: no_reply (noise — no Telegram ping)');
      return { action: 'no_reply' };

    case 'escalate': {
      // Hold reply: send polite customer-facing message, THEN escalate
      const reason = triage.escalation_reason || triage.reason;
      const holdingReply = "Thanks for reaching out! I don't have the definitive answer on this right now, so I've flagged this for our human team to review. They will follow up with you shortly.";
      
      try {
        const sent = await sendReply(gmail, thread, holdingReply);
        if (sent) {
          logger.info({ threadId: thread.threadId }, 'Switchboard: Holding reply sent for escalation');
        }
      } catch (err) {
        logger.error({ err, threadId: thread.threadId }, 'Failed to send holding reply');
      }
      
      await markThreadHandled(gmail, thread.threadId);
      await sendTelegramEscalationAlert(
        reason,
        thread.subject,
        thread.threadId,
        thread.messages[0]?.from ?? 'unknown',
        thread.messages[thread.messages.length - 1]?.body ?? '',
        signal,
      );
      await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
      logger.info({ threadId: thread.threadId }, 'Switchboard: escalated with Holding Reply + Telegram');
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
        await markThreadHandled(gmail, thread.threadId);
        await sendTelegramEscalationAlert(
          reason,
          thread.subject,
          thread.threadId,
          thread.messages[0]?.from ?? 'unknown',
          thread.messages[thread.messages.length - 1]?.body ?? '',
          signal,
        );
        await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
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
        await markThreadHandled(gmail, thread.threadId);
        await sendTelegramEscalationAlert(
          reason,
          thread.subject,
          thread.threadId,
          thread.messages[0]?.from ?? 'unknown',
          thread.messages[thread.messages.length - 1]?.body ?? '',
          signal,
        );
        await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
        return { action: 'escalated', escalationReason: reason };
      }
      const kbContent = runKbReader(triage.target_files);
      const orderContext =
        lookup.order != null
          ? JSON.stringify({ success: lookup.success, order: lookup.order, reason: lookup.reason, flags: lookup.flags }, null, 2)
          : null;
      const { body, escalate, holdingReply } = await runReplyGenerator(
        thread,
        triage,
        kbContent,
        GROK_API_KEY,
        orderContext,
        signal,
      );
      if (escalate) {
        if (holdingReply) {
          // Model sent Holding Reply with ESCALATE_WITH_REPLY prefix
          // The body variable already has the cleaned Holding Reply text
          logger.info({ threadId: thread.threadId }, 'Reply-generator sent Holding Reply');
          
          // Send the body (which contains the Holding Reply)
          const sent = await sendReply(gmail, thread, body);
          if (sent) {
            logger.info({ threadId: thread.threadId }, 'Holding Reply sent before escalation');
          }
          
          await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
          
          await sendTelegramEscalationAlert(
            triage.escalation_reason || triage.reason || 'KB was silent',
            thread.subject,
            thread.threadId,
            thread.messages[0]?.from ?? 'unknown',
            thread.messages[thread.messages.length - 1]?.body ?? '',
            signal,
          );
          logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup → Holding Reply escalated');
          return { action: 'escalated', escalationReason: triage.escalation_reason || triage.reason || 'KB was silent' };
        } else {
          // Model declined to reply; escalate normally
          const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
          await markThreadHandled(gmail, thread.threadId);
          await sendTelegramEscalationAlert(
            reason,
            thread.subject,
            thread.threadId,
            thread.messages[0]?.from ?? 'unknown',
            thread.messages[thread.messages.length - 1]?.body ?? '',
            signal,
          );
          await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
          logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup → escalated');
          return { action: 'escalated', escalationReason: reason };
        }
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        // State machine: scrub old labels, apply Claw:Replied
        await applyExclusiveStatusLabel(gmail, thread.threadId, 'Claw: Replied');
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup reply sent (Claw:Replied applied)');
        return { action: 'shopify_lookup' };
      }
      await markThreadHandled(gmail, thread.threadId);
      await sendTelegramEscalationAlert(
        'Gmail send failed',
        thread.subject,
        thread.threadId,
        thread.messages[0]?.from ?? 'unknown',
        thread.messages[thread.messages.length - 1]?.body ?? '',
        signal,
      );
      await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
      logger.error({ threadId: thread.threadId }, 'Switchboard: shopify_lookup send failed → escalated');
      return { action: 'escalated', escalationReason: 'Gmail send failed.' };
    }

    case 'auto_reply': {
      const kbContent = runKbReader(triage.target_files);
      const { body, escalate, holdingReply } = await runReplyGenerator(
        thread,
        triage,
        kbContent,
        GROK_API_KEY,
        undefined,
        signal,
      );
      if (escalate) {
        if (holdingReply) {
          // Model sent Holding Reply with ESCALATE_WITH_REPLY prefix
          // The body variable already has the cleaned Holding Reply text
          logger.info({ threadId: thread.threadId }, 'Reply-generator sent Holding Reply');
          
          // Send the body (which contains the Holding Reply)
          const sent = await sendReply(gmail, thread, body);
          if (sent) {
            logger.info({ threadId: thread.threadId }, 'Holding Reply sent before escalation');
          }
          
          await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
          
          await sendTelegramEscalationAlert(
            triage.escalation_reason || triage.reason || 'KB was silent',
            thread.subject,
            thread.threadId,
            thread.messages[0]?.from ?? 'unknown',
            thread.messages[thread.messages.length - 1]?.body ?? '',
            signal,
          );
          logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply → Holding Reply escalated');
          return { action: 'escalated', escalationReason: triage.escalation_reason || triage.reason || 'KB was silent' };
        } else {
          const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
          await markThreadHandled(gmail, thread.threadId);
          await sendTelegramEscalationAlert(
            reason,
            thread.subject,
            thread.threadId,
            thread.messages[0]?.from ?? 'unknown',
            thread.messages[thread.messages.length - 1]?.body ?? '',
            signal,
          );
          await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
          logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply → escalated');
          return { action: 'escalated', escalationReason: reason };
        }
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        // State machine: scrub old labels, apply Claw:Replied
        await applyExclusiveStatusLabel(gmail, thread.threadId, 'Claw: Replied');
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply sent (Claw:Replied applied)');
        return { action: 'auto_reply' };
      }
      await markThreadHandled(gmail, thread.threadId);
      await sendTelegramEscalationAlert(
        'Gmail send failed',
        thread.subject,
        thread.threadId,
        thread.messages[0]?.from ?? 'unknown',
        thread.messages[thread.messages.length - 1]?.body ?? '',
        signal,
      );
      await applyExclusiveStatusLabel(gmail, thread.threadId, '🦞 Claw: Escalated');
      logger.error({ threadId: thread.threadId }, 'Switchboard: auto_reply send failed → escalated');
      return { action: 'escalated', escalationReason: 'Gmail send failed.' };
    }
  }
}

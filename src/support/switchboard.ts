/**
 * Switchboard: route triage result → ignore (archive), escalate (draft + mark handled + Telegram), shopify_lookup, auto_reply.
 * Escalation = createSmartDraft → markThreadHandled → sendTelegramEscalationAlert (never send live to customer).
 */
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GROK_API_KEY,
  getTenantConfig,
  SHOPIFY_ACCESS_TOKEN,
} from './config.js';
import { logger } from '../logger.js';
import type { TriageResult } from './triage.js';
import type { SupportThread } from './gmail-support.js';
import {
  archiveThread,
  sendReply,
  createSmartDraft,
  markThreadHandled,
} from './gmail-support.js';
import { runKbReader, runReplyGenerator } from './auto-reply-pipeline.js';
import { lookupOrder } from './shopify-client.js';
import type { gmail_v1 } from 'googleapis';

const TELEGRAM_API = 'https://api.telegram.org';

async function sendTelegram(text: string, parseMode: 'Markdown' | undefined = 'Markdown'): Promise<boolean> {
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

/** WOW alert format: plain text with Gmail deep link. */
async function sendTelegramEscalationAlert(
  short_reason: string,
  subject: string,
  threadId: string,
): Promise<boolean> {
  const text = `🚨 ESCALATION REQUIRED\nReason: ${short_reason}\nThread: ${subject}\nDraft prepared in Gmail.\n🔗 Open in Gmail: https://mail.google.com/mail/u/0/#inbox/${threadId}`;
  return sendTelegram(text, undefined);
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
      draftBody: string;
      short_reason: string;
    };

/**
 * Terminal state for every escalation: createSmartDraft → markThreadHandled → sendTelegramEscalationAlert.
 * Call from switchboard and from heartbeat catch. Never sends live to customer.
 */
export async function performEscalation(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  options: EscalationOptions,
): Promise<void> {
  const last = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
  const subject = thread.subject || '(no subject)';
  const to = last?.from ?? '';
  const messageId = last?.messageId ?? '';

  const draftBody =
    options.scenario === 'system'
      ? `**[INTERNAL ESCALATION NOTE - DO NOT SEND TO CUSTOMER]**\n\nReason: ${options.error_details}\nFix: ${options.remediation_steps}`
      : options.draftBody;

  const short_reason =
    options.scenario === 'system'
      ? (options.short_reason ?? options.error_details)
      : options.short_reason;

  if (last && messageId && to) {
    await createSmartDraft(gmail, thread.threadId, messageId, draftBody, subject, to);
  } else {
    logger.warn({ threadId: thread.threadId }, 'Escalation: no last message, skipping draft');
  }

  await markThreadHandled(gmail, thread.threadId);
  await sendTelegramEscalationAlert(short_reason, subject, thread.threadId);
  logger.info({ threadId: thread.threadId }, 'Escalation terminal state completed');
}

const CUSTOMER_PLACEHOLDER_DRAFT =
  "Thank you for your message. We're looking into this and will get back to you shortly.";

/** Run switchboard: perform action for this thread based on triage result. */
export async function runSwitchboard(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  triage: TriageResult | null,
): Promise<void> {
  // Invalid triage → escalate (draft + mark handled + Telegram)
  if (!triage) {
    await performEscalation(gmail, thread, {
      scenario: 'system',
      error_details: 'Triage output invalid.',
      remediation_steps: 'Review and reply manually.',
    });
    return;
  }

  switch (triage.action) {
    case 'ignore':
      await archiveThread(gmail, thread.threadId, true);
      logger.info({ threadId: thread.threadId }, 'Switchboard: ignored (archived)');
      break;

    case 'escalate': {
      const reason = triage.escalation_reason || triage.reason;
      await performEscalation(gmail, thread, {
        scenario: 'customer',
        draftBody: CUSTOMER_PLACEHOLDER_DRAFT,
        short_reason: reason,
      });
      logger.info({ threadId: thread.threadId }, 'Switchboard: escalated (draft + handled + Telegram)');
      break;
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
        });
        break;
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
          scenario: 'customer',
          draftBody: CUSTOMER_PLACEHOLDER_DRAFT,
          short_reason: reason,
        });
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup → escalated');
        break;
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
      );
      if (escalate || !body.trim()) {
        const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
        await performEscalation(gmail, thread, {
          scenario: 'customer',
          draftBody: body.trim() || CUSTOMER_PLACEHOLDER_DRAFT,
          short_reason: reason,
        });
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup → auto_reply escalated (no send)');
        break;
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        await archiveThread(gmail, thread.threadId, true);
        logger.info({ threadId: thread.threadId }, 'Switchboard: shopify_lookup reply sent from support address');
      } else {
        await performEscalation(gmail, thread, {
          scenario: 'system',
          error_details: 'Gmail send failed.',
          remediation_steps: 'Review draft and send manually.',
        });
        logger.error({ threadId: thread.threadId }, 'Switchboard: shopify_lookup send failed → escalated');
      }
      break;
    }

    case 'auto_reply': {
      const kbContent = runKbReader(triage.target_files);
      const { body, escalate } = await runReplyGenerator(
        thread,
        triage,
        kbContent,
        GROK_API_KEY,
      );
      if (escalate || !body.trim()) {
        const reason = triage.escalation_reason || triage.reason || 'Reply-generator chose to escalate or returned no body';
        await performEscalation(gmail, thread, {
          scenario: 'customer',
          draftBody: body.trim() || CUSTOMER_PLACEHOLDER_DRAFT,
          short_reason: reason,
        });
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply → escalated (no send)');
        break;
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        await archiveThread(gmail, thread.threadId, true);
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply sent from support address');
      } else {
        await performEscalation(gmail, thread, {
          scenario: 'system',
          error_details: 'Gmail send failed.',
          remediation_steps: 'Review draft and send manually.',
        });
        logger.error({ threadId: thread.threadId }, 'Switchboard: auto_reply send failed → escalated');
      }
      break;
    }
  }
}

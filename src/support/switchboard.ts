/**
 * Switchboard: route triage result → ignore (archive), escalate (Telegram), shopify_lookup (placeholder), auto_reply (kb-reader → reply-generator → send).
 */
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GROK_API_KEY } from './config.js';
import { logger } from '../logger.js';
import type { TriageResult } from './triage.js';
import type { SupportThread } from './gmail-support.js';
import { archiveThread, sendReply } from './gmail-support.js';
import { runKbReader, runReplyGenerator } from './auto-reply-pipeline.js';
import type { gmail_v1 } from 'googleapis';

const TELEGRAM_API = 'https://api.telegram.org';

async function sendTelegram(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.warn('Telegram env missing, skipping escalation send');
    return false;
  }
  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'Markdown',
        }),
      });
      if (res.ok) {
        logger.info('Escalation sent to Telegram');
        return true;
      }
      const body = await res.text();
      lastErr = new Error(`Telegram ${res.status}: ${body}`);
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

function escapeMarkdown(s: string): string {
  return s.replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}

/** Run switchboard: perform action for this thread based on triage result. */
export async function runSwitchboard(
  gmail: gmail_v1.Gmail,
  thread: SupportThread,
  triage: TriageResult | null,
): Promise<void> {
  // Invalid triage → escalate per ADAPTER-SPEC
  if (!triage) {
    const text = `🚨 **ESCALATION REQUIRED** 🚨\n\n**Reason:** Triage output invalid.\n**Thread:** ${escapeMarkdown(thread.subject)}\n\n*Action: Review manually.*`;
    await sendTelegram(text);
    return;
  }

  switch (triage.action) {
    case 'ignore':
      await archiveThread(gmail, thread.threadId, true);
      logger.info({ threadId: thread.threadId }, 'Switchboard: ignored (archived)');
      break;

    case 'escalate': {
      const reason = triage.escalation_reason || triage.reason;
      const email = triage.extracted_email || thread.messages[0]?.from || '';
      const shortSummary = thread.messages
        .map((m) => `${m.from}: ${m.body.slice(0, 150)}...`)
        .join('\n');
      const text = `🚨 **ESCALATION REQUIRED** 🚨\n\n**Reason:** ${escapeMarkdown(reason)}\n**Customer Sentiment:** ${triage.sentiment}\n**Customer:** ${escapeMarkdown(email)}\n\n**Context Summary:**\n${escapeMarkdown(shortSummary)}\n\n*Action Needed: Review & reply manually.*`;
      await sendTelegram(text);
      logger.info({ threadId: thread.threadId }, 'Switchboard: escalated to Telegram');
      break;
    }

    case 'shopify_lookup':
      logger.info(
        { threadId: thread.threadId, order: triage.extracted_order_number },
        'Switchboard: shopify_lookup (placeholder — prepare tool call later)',
      );
      break;

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
        const email = triage.extracted_email || thread.messages[0]?.from || '';
        const shortSummary = thread.messages
          .map((m) => `${m.from}: ${m.body.slice(0, 150)}...`)
          .join('\n');
        const text = `🚨 **ESCALATION REQUIRED** 🚨\n\n**Reason:** ${escapeMarkdown(reason)}\n**Customer Sentiment:** ${triage.sentiment}\n**Customer:** ${escapeMarkdown(email)}\n\n**Context Summary:**\n${escapeMarkdown(shortSummary)}\n\n*Action Needed: Review & reply manually.*`;
        await sendTelegram(text);
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply → escalated (no send)');
        break;
      }
      const sent = await sendReply(gmail, thread, body);
      if (sent) {
        await archiveThread(gmail, thread.threadId, true);
        logger.info({ threadId: thread.threadId }, 'Switchboard: auto_reply sent from support address');
      } else {
        const text = `🚨 **SEND FAILED** 🚨\n\n**Thread:** ${escapeMarkdown(thread.subject)}\n**Customer:** ${escapeMarkdown(thread.messages[0]?.from || '')}\n\nGmail send failed. Review and reply manually.`;
        await sendTelegram(text);
        logger.error({ threadId: thread.threadId }, 'Switchboard: auto_reply send failed → escalated');
      }
      break;
    }
  }
}

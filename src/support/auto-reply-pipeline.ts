/**
 * Auto-reply pipeline: kb-reader (read target_files) → reply-generator (Grok) → body or escalate.
 * Used by switchboard for action === 'auto_reply'.
 */
import fs from 'fs';
import path from 'path';

import { BRAIN_PATH } from './config.js';
import { grokComplete } from './grok.js';
import { logger } from '../logger.js';
import type { SupportThread } from './gmail-support.js';
import type { TriageResult } from './triage.js';

const KB_DIR = 'knowledge-base';
const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+\.md$/;

/**
 * Read targeted KB files and return concatenated content for reply-generator.
 * Only reads files under knowledge-base/ with safe names (no path traversal).
 */
export function runKbReader(targetFiles: string[]): string {
  if (targetFiles.length === 0) {
    return '(No specific KB files requested; use general FAQ and brand-voice.)';
  }
  const kbRoot = path.join(BRAIN_PATH, KB_DIR);
  const parts: string[] = [];
  for (const file of targetFiles) {
    if (!SAFE_FILENAME.test(file)) {
      logger.warn({ file }, 'Kb-reader: skipping unsafe filename');
      continue;
    }
    const full = path.join(kbRoot, file);
    if (!full.startsWith(path.resolve(kbRoot))) {
      logger.warn({ file }, 'Kb-reader: path traversal blocked');
      continue;
    }
    try {
      const content = fs.readFileSync(full, 'utf-8');
      parts.push(`## ${file}\n\n${content}`);
    } catch (err) {
      logger.warn({ path: full, err }, 'Kb-reader: could not read file');
    }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : '(No KB content loaded.)';
}

/**
 * Extract the email body from reply-generator model output.
 * Removes <thinking> blocks and markdown/code fences; detects explicit escalation.
 */
function extractReplyBody(raw: string): { body: string; escalate: boolean } {
  let text = raw.trim();
  // Remove <thinking>...</thinking> blocks
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  // If model explicitly says to escalate, do not send
  const escalatePhrases = [
    /do not send/i,
    /do not send the reply/i,
    /trigger an escalation/i,
    /escalate instead/i,
    /ESCALATE\b/i,
    /I am escalating/i,
  ];
  for (const re of escalatePhrases) {
    if (re.test(text)) {
      return { body: '', escalate: true };
    }
  }
  // Strip optional markdown code fence around body
  const fence = /^```(?:text|plain)?\s*\n?([\s\S]*?)\n?```\s*$/m;
  const m = text.match(fence);
  if (m) text = m[1].trim();
  text = text.trim();
  if (!text) {
    return { body: '', escalate: true };
  }
  return { body: text, escalate: false };
}

/**
 * Run reply-generator: SOUL + skill + thread + triage + kb content [+ optional Shopify order context] → one reply body or escalate.
 */
export async function runReplyGenerator(
  thread: SupportThread,
  triage: TriageResult,
  kbContent: string,
  grokApiKey: string,
  orderContext?: string | null,
): Promise<{ body: string; escalate: boolean }> {
  const skillPath = path.join(BRAIN_PATH, 'skills', 'reply-generator', 'SKILL.md');
  let skillContent: string;
  try {
    skillContent = fs.readFileSync(skillPath, 'utf-8');
  } catch (err) {
    logger.error({ path: skillPath, err }, 'Reply-generator SKILL.md not found');
    return { body: '', escalate: true };
  }

  const soulPath = path.join(BRAIN_PATH, 'SOUL.md');
  const soul = fs.readFileSync(soulPath, 'utf-8');

  const threadBlob = thread.messages
    .map(
      (m) =>
        `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`,
    )
    .join('\n---\n');

  const triageJson = JSON.stringify(
    {
      category: triage.category,
      action: triage.action,
      sentiment: triage.sentiment,
      flags: triage.flags,
      reason: triage.reason,
      target_files: triage.target_files,
      extracted_order_number: triage.extracted_order_number,
      extracted_email: triage.extracted_email,
    },
    null,
    2,
  );

  const orderBlock =
    orderContext?.trim() ?
      `\n## Shopify order data (use for tracking, status, line items)\n${orderContext}\n`
    : '';

  const userContent = `You are generating a single customer reply. Output ONLY the raw email body (plain text), or state ESCALATE and do not send.

## Triage JSON
${triageJson}

## Knowledge base content (use exact policy quotes where relevant)
${kbContent}
${orderBlock}
## Full thread (subject: ${thread.subject})
${threadBlob}

Generate the reply body now. No explanations; just the email text the customer will see, or the word ESCALATE if you must escalate.`;

  const systemContent = `${soul}\n\n---\n\n${skillContent}`;

  try {
    const text = await grokComplete(systemContent, userContent, grokApiKey, 1024);
    return extractReplyBody(text);
  } catch (err) {
    logger.error({ err, threadId: thread.threadId }, 'Reply-generator Grok call failed');
    return { body: '', escalate: true };
  }
}

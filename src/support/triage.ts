/**
 * Support-triage: load Brain (SOUL + skill), call Grok, return strict JSON per SKILL.md.
 */
import fs from 'fs';
import path from 'path';

import { BRAIN_PATH } from './config.js';
import { grokComplete } from './grok.js';
import { logger } from '../logger.js';
import type { SupportThread } from './gmail-support.js';
import { getMemorySummary } from './memory.js';

export interface TriageResult {
  category: string;
  action: 'auto_reply' | 'shopify_lookup' | 'escalate' | 'ignore';
  target_files: string[];
  extracted_order_number: string | null;
  extracted_email: string | null;
  requires_shopify_lookup: boolean;
  confidence: number;
  sentiment: string;
  reason: string;
  flags: string[];
  escalation_reason: string | null;
}

function loadFile(relPath: string): string {
  const full = path.join(BRAIN_PATH, relPath);
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch (err) {
    logger.warn({ path: full, err }, 'Could not load brain file');
    return '';
  }
}

function parseTriageJson(raw: string): TriageResult | null {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m;
  const m = text.match(fence);
  if (m) text = m[1].trim();
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const action = obj.action as string;
    if (
      !['auto_reply', 'shopify_lookup', 'escalate', 'ignore'].includes(action)
    ) {
      logger.warn({ action }, 'Invalid triage action');
      return null;
    }
    const result: TriageResult = {
      category: String(obj.category ?? 'other'),
      action: action as TriageResult['action'],
      target_files: Array.isArray(obj.target_files)
        ? obj.target_files.map(String)
        : [],
      extracted_order_number:
        obj.extracted_order_number != null
          ? String(obj.extracted_order_number)
          : null,
      extracted_email:
        obj.extracted_email != null ? String(obj.extracted_email) : null,
      requires_shopify_lookup: Boolean(obj.requires_shopify_lookup),
      confidence: Number(obj.confidence) || 0,
      sentiment: String(obj.sentiment ?? 'neutral'),
      reason: String(obj.reason ?? ''),
      flags: Array.isArray(obj.flags) ? obj.flags.map(String) : [],
      escalation_reason:
        obj.escalation_reason != null
          ? String(obj.escalation_reason)
          : null,
    };
    return result;
  } catch (err) {
    logger.warn({ err, raw: raw.slice(0, 300) }, 'Triage JSON parse failed');
    return null;
  }
}

export async function runTriage(
  thread: SupportThread,
  memorySummary: string,
  grokApiKey: string,
  signal?: AbortSignal,
): Promise<TriageResult | null> {
  const soul = loadFile('SOUL.md');
  const skillPath = path.join(BRAIN_PATH, 'skills', 'support-triage', 'SKILL.md');
  let skillContent: string;
  try {
    skillContent = fs.readFileSync(skillPath, 'utf-8');
  } catch (err) {
    logger.error({ path: skillPath, err }, 'Support-triage SKILL.md not found');
    return null;
  }

  const threadBlob = thread.messages
    .map(
      (m) =>
        `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`,
    )
    .join('\n---\n');

  const userContent = `## Memory summary (today / yesterday)\n${memorySummary}\n\n## Thread (subject: ${thread.subject})\n\n${threadBlob}`;

  const systemContent = `${soul}\n\n---\n\n${skillContent}`;

  try {
    const text = await grokComplete(systemContent, userContent, grokApiKey, 1024, signal);
    const result = parseTriageJson(text);
    if (!result) {
      logger.warn({ threadId: thread.threadId }, 'Triage returned invalid JSON → treat as escalate');
    }
    return result;
  } catch (err) {
    logger.error({ err, threadId: thread.threadId }, 'Grok triage call failed');
    return null;
  }
}

/**
 * Support memory: read/write memory/YYYY-MM-DD.md under SUPPORT_MEMORY_DIR (writable).
 */
import fs from 'fs';
import path from 'path';

import { SUPPORT_MEMORY_DIR } from './config.js';
import { logger } from '../logger.js';

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function getMemorySummary(): string {
  const today = dateKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);
  const parts: string[] = [];
  for (const key of [yesterdayKey, today]) {
    const filePath = path.join(SUPPORT_MEMORY_DIR, `${key}.md`);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.trim()) parts.push(`## ${key}\n${content.trim()}`);
    } catch {
      // File may not exist yet
    }
  }
  if (parts.length === 0) return 'No memory entries for today or yesterday.';
  return parts.join('\n\n');
}

export function appendMemoryLog(entry: string): void {
  const today = dateKey(new Date());
  const filePath = path.join(SUPPORT_MEMORY_DIR, `${today}.md`);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = `\n${entry}\n`;
    fs.appendFileSync(filePath, line);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to append memory log');
  }
}

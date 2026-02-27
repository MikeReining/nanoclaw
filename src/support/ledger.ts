/**
 * Enterprise Message Ledger: SQLite-backed source of truth for "has this message been processed?".
 * Decouples processing logic from Gmail read/unread state so we never miss messages the merchant read before the heartbeat.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { logger } from '../logger.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'ledger.db');
  // TODO: Swap driver for Supabase/Postgres when migrating to central analytics.
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      action TEXT,
      escalation_reason TEXT,
      test_id TEXT,
      tags TEXT,
      UNIQUE(tenant_id, gmail_message_id)
    )
  `);
  // Migration: add test_id and tags if missing (e.g. existing DBs from before this schema).
  const columns = (db.prepare('PRAGMA table_info(processed_messages)').all() as { name: string }[]).map((r) => r.name);
  if (!columns.includes('test_id')) {
    db.exec('ALTER TABLE processed_messages ADD COLUMN test_id TEXT');
  }
  if (!columns.includes('tags')) {
    db.exec('ALTER TABLE processed_messages ADD COLUMN tags TEXT');
  }
  logger.info({ dbPath }, 'Message Ledger initialized (WAL mode)');
  return db;
}

/**
 * Returns whether we have already processed this message (any terminal action: reply sent, draft created, escalated, ignored).
 */
export function hasProcessed(tenantId: string, messageId: string): boolean {
  if (!messageId || !tenantId) return false;
  const row = getDb()
    .prepare(
      'SELECT 1 FROM processed_messages WHERE tenant_id = ? AND gmail_message_id = ? LIMIT 1',
    )
    .get(tenantId, normalizeMessageId(messageId)) as { '1'?: number } | undefined;
  return Boolean(row);
}

/**
 * Record that we have processed this message. Idempotent: re-calling updates processed_at, action, escalation_reason, test_id, tags.
 */
export function markProcessed(
  tenantId: string,
  messageId: string,
  threadId: string,
  action: string,
  escalationReason?: string,
  options?: { testId?: string; tags?: string },
): void {
  if (!messageId || !tenantId || !threadId) return;
  const mid = normalizeMessageId(messageId);
  const testId = options?.testId ?? null;
  const tags = options?.tags ?? null;
  getDb()
    .prepare(
      `
    INSERT INTO processed_messages (tenant_id, gmail_message_id, thread_id, action, escalation_reason, test_id, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, gmail_message_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      processed_at = CURRENT_TIMESTAMP,
      action = excluded.action,
      escalation_reason = excluded.escalation_reason,
      test_id = excluded.test_id,
      tags = excluded.tags
  `,
    )
    .run(tenantId, mid, threadId, action, escalationReason ?? null, testId, tags);
}

/** Gmail Message-ID can be with or without angle brackets; normalize for consistent storage. */
function normalizeMessageId(messageId: string): string {
  const t = messageId.trim();
  if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
  return t;
}

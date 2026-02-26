/**
 * Support-triage / AutoSupportClaw config.
 * Brain at /app/brain (ro); memory written to /app/data/memory (writable).
 */
import path from 'path';

const PROJECT_ROOT = process.cwd();

/** Brain root: skills, SOUL, HEARTBEAT, knowledge-base. Mounted at /app/brain in Docker. */
export const BRAIN_PATH = process.env.BRAIN_PATH || path.join(PROJECT_ROOT, 'brain');
/** Writable dir for data, logs, sqlite. Memory files go under data/memory/. */
export const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
/** Memory files: runtime-only, per tenant. Path = SUPPORT_MEMORY_DIR/YYYY-MM-DD.md */
export const SUPPORT_MEMORY_DIR = path.join(DATA_DIR, 'memory');

const DEFAULT_POLL_INTERVAL_MS = 600000; // 10 min production default
const raw = process.env.GMAIL_POLL_INTERVAL_MS;
const parsed = raw != null ? parseInt(raw, 10) : NaN;
/** Gmail poll interval in ms. Set GMAIL_POLL_INTERVAL_MS in .env (e.g. 15000 for local dev). Invalid/missing → 600000. */
export const HEARTBEAT_INTERVAL_MS =
  Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;

export const GROK_API_KEY = process.env.GROK_API_KEY || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
export const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
export const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
export const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

export function hasSupportEnv(): boolean {
  return Boolean(
    GROK_API_KEY &&
      GMAIL_CLIENT_ID &&
      GMAIL_CLIENT_SECRET &&
      GMAIL_REFRESH_TOKEN,
  );
}

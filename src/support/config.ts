/**
 * Support-triage / AutoSupportClaw config.
 * Brain at /app/brain (ro); memory written to /app/data/memory (writable).
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

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
/** Gmail poll interval in ms. Set GMAIL_POLL_INTERVAL_MS in .env (e.g. 15000 for local dev). Invalid/missing → 600000 (prod) or 15000 (dev). */
export const HEARTBEAT_INTERVAL_MS =
  Number.isFinite(parsed) && parsed > 0
    ? parsed
    : (process.env.NODE_ENV === 'development' ? 15000 : 600000);

logger.info(
  {
    intervalSeconds: Math.round(HEARTBEAT_INTERVAL_MS / 1000),
    source: raw != null ? 'env' : 'default',
    envKey: 'GMAIL_POLL_INTERVAL_MS',
  },
  'Gmail poll interval loaded',
);

const newerThanDaysRaw = process.env.GMAIL_NEWER_THAN_DAYS;
const newerThanDaysParsed = newerThanDaysRaw != null ? parseInt(newerThanDaysRaw, 10) : NaN;
/** Time window for Gmail poll: only threads newer than this many days. Default 14. */
export const GMAIL_NEWER_THAN_DAYS =
  Number.isFinite(newerThanDaysParsed) && newerThanDaysParsed >= 1 ? newerThanDaysParsed : 14;

const maxThreadsRaw = process.env.GMAIL_MAX_THREADS_PER_POLL;
const maxThreadsParsed = maxThreadsRaw != null ? parseInt(maxThreadsRaw, 10) : NaN;
/** Max threads to consider per heartbeat tick. Default 50. */
export const GMAIL_MAX_THREADS_PER_POLL =
  Number.isFinite(maxThreadsParsed) && maxThreadsParsed > 0 ? maxThreadsParsed : 50;

const DEFAULT_TICK_TIMEOUT_MS = 480000; // 8 min — bounds each tick so the loop cannot stall
const tickTimeoutRaw = process.env.HEARTBEAT_TICK_TIMEOUT_MS;
const tickTimeoutParsed = tickTimeoutRaw != null ? parseInt(tickTimeoutRaw, 10) : NaN;
/** Per-tick timeout in ms. If a tick exceeds this, it is aborted and the next tick is still scheduled. Default 480000 (8 min). */
export const HEARTBEAT_TICK_TIMEOUT_MS =
  Number.isFinite(tickTimeoutParsed) && tickTimeoutParsed > 0 ? tickTimeoutParsed : DEFAULT_TICK_TIMEOUT_MS;

export const GROK_API_KEY = process.env.GROK_API_KEY || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
export const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
export const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
export const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

/** For local/testing only: override store URL without tenant.json. */
export const TENANT_OVERRIDE_SHOPIFY_STORE_URL = process.env.TENANT_OVERRIDE_SHOPIFY_STORE_URL || '';
/** Shopify: pre-negotiated offline access token (shpat_...) injected at boot by parent Web Dashboard after OAuth. No auth in this process. */
export const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

export interface TenantConfig {
  brand_name?: string;
  shopify_store_url: string;
  support_email?: string;
}

/**
 * Load tenant config: first check TENANT_OVERRIDE_SHOPIFY_STORE_URL, then brain/tenant.json.
 * Returns null if no store URL available (log friendly warning).
 */
export function getTenantConfig(): TenantConfig | null {
  if (TENANT_OVERRIDE_SHOPIFY_STORE_URL.trim()) {
    const url = normalizeStoreUrl(TENANT_OVERRIDE_SHOPIFY_STORE_URL.trim());
    return { shopify_store_url: url };
  }
  const tenantPath = path.join(BRAIN_PATH, 'tenant.json');
  if (!fs.existsSync(tenantPath)) {
    logger.warn(
      'tenant.json not found. Copy brain/tenant.json.example to brain/tenant.json and set shopify_store_url. Shopify lookup disabled.',
    );
    return null;
  }
  try {
    const raw = fs.readFileSync(tenantPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const url = data.shopify_store_url;
    if (typeof url !== 'string' || !url.trim()) {
      logger.warn({ tenantPath }, 'tenant.json missing or empty shopify_store_url. Shopify lookup disabled.');
      return null;
    }
    return {
      brand_name: typeof data.brand_name === 'string' ? data.brand_name : undefined,
      shopify_store_url: normalizeStoreUrl(url.trim()),
      support_email: typeof data.support_email === 'string' ? data.support_email : undefined,
    };
  } catch (err) {
    logger.warn({ err, tenantPath }, 'Failed to read or parse tenant.json. Copy tenant.json.example to tenant.json. Shopify lookup disabled.');
    return null;
  }
}

function normalizeStoreUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return u.origin;
  } catch {
    return trimmed;
  }
}

/**
 * Stable tenant ID for Ledger and multi-tenant readiness. Derived from tenant config; use 'default' when none.
 */
export function getTenantId(): string {
  const tenant = getTenantConfig();
  if (!tenant?.shopify_store_url) return 'default';
  try {
    const u = new URL(
      tenant.shopify_store_url.startsWith('http')
        ? tenant.shopify_store_url
        : `https://${tenant.shopify_store_url}`,
    );
    return u.hostname || 'default';
  } catch {
    return 'default';
  }
}

export function hasSupportEnv(): boolean {
  return Boolean(
    GROK_API_KEY &&
      GMAIL_CLIENT_ID &&
      GMAIL_CLIENT_SECRET &&
      GMAIL_REFRESH_TOKEN,
  );
}

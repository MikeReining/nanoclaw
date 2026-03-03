/**
 * Tenant Settings Module
 * Provides persistent storage for user-configurable settings that control engine behavior.
 * Stored in ledger.db as a separate table from processed_messages.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, getTenantId } from './config.js';
import { logger } from '../logger.js';

let db: Database.Database | null = null;

/** Available persona options */
export type BotPersona = 'Professional & Crisp' | 'Warm & Empathetic' | 'Casual';

/** Subscription tier */
export type SubscriptionTier = 'free' | 'basic' | 'pro' | 'enterprise';

/** Humanizer delay options (seconds) */
export type HumanizerDelay = 0 | 180 | 300 | 600; // Instant, 3min, 5min, 10min

/** Complete settings interface */
export interface TenantSettings {
  tenantId: string;
  
  // Automation & Behavior
  copilotModeEnabled: boolean;
  holdingRepliesEnabled: boolean;
  humanizerDelaySeconds: HumanizerDelay;
  botPersona: BotPersona;
  
  // Email Appearance (Branding)
  customHtmlFooter: string | null;
  watermarkEnabled: boolean;
  
  // Subscription & Metadata
  tier: SubscriptionTier;
  updatedAt: Date;
}

/** Default settings values */
const DEFAULT_SETTINGS: Omit<TenantSettings, 'tenantId' | 'updatedAt'> = {
  copilotModeEnabled: false,
  holdingRepliesEnabled: true,
  humanizerDelaySeconds: 0,
  botPersona: 'Professional & Crisp',
  customHtmlFooter: null,
  watermarkEnabled: true,
  tier: 'free',
};

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'ledger.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/** Initialize tenant_settings table if not exists */
export function initSettingsTable(): void {
  // Use ledger's database initialization to ensure shared db
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      copilot_mode_enabled BOOLEAN DEFAULT 0,
      holding_replies_enabled BOOLEAN DEFAULT 1,
      humanizer_delay_seconds INTEGER DEFAULT 0,
      bot_persona TEXT DEFAULT 'Professional & Crisp',
      custom_html_footer TEXT,
      watermark_enabled BOOLEAN DEFAULT 1,
      tier TEXT DEFAULT 'free',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  logger.info({ dbPath: path.join(DATA_DIR, 'ledger.db') }, 'tenant_settings table initialized (or already exists)');
}

/** Load settings for a tenant. Creates defaults if not exists. */
export function loadTenantSettings(tenantId?: string): TenantSettings {
  const database = getDb();
  const tid = tenantId ?? getTenantId();
  
  const row = database
    .prepare(
      `SELECT 
        copilot_mode_enabled,
        holding_replies_enabled,
        humanizer_delay_seconds,
        bot_persona,
        custom_html_footer,
        watermark_enabled,
        tier,
        updated_at
      FROM tenant_settings 
      WHERE tenant_id = ?`
    )
    .get(tid) as 
      | {
          copilot_mode_enabled: number;
          holding_replies_enabled: number;
          humanizer_delay_seconds: number;
          bot_persona: string;
          custom_html_footer: string | null;
          watermark_enabled: number;
          tier: string;
          updated_at: string;
        }
      | undefined;

  if (!row) {
    // Insert defaults
    database
      .prepare(
        `INSERT INTO tenant_settings (
          tenant_id,
          copilot_mode_enabled,
          holding_replies_enabled,
          humanizer_delay_seconds,
          bot_persona,
          watermark_enabled,
          tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tid,
        DEFAULT_SETTINGS.copilotModeEnabled,
        DEFAULT_SETTINGS.holdingRepliesEnabled,
        DEFAULT_SETTINGS.humanizerDelaySeconds,
        DEFAULT_SETTINGS.botPersona,
        DEFAULT_SETTINGS.watermarkEnabled,
        DEFAULT_SETTINGS.tier
      );
    
    logger.info({ tenantId: tid }, 'Created new tenant settings with defaults');
    return getTenantSettings(tid);
  }

  return {
    tenantId: tid,
    copilotModeEnabled: row.copilot_mode_enabled === 1,
    holdingRepliesEnabled: row.holding_replies_enabled === 1,
    humanizerDelaySeconds: row.humanizer_delay_seconds as HumanizerDelay,
    botPersona: row.bot_persona as BotPersona,
    customHtmlFooter: row.custom_html_footer || null,
    watermarkEnabled: row.watermark_enabled === 1,
    tier: row.tier as SubscriptionTier,
    updatedAt: new Date(row.updated_at),
  };
}

/** Get current tenant settings (auto-detects tenant ID) */
export function getTenantSettings(): TenantSettings;
/** Get settings for specific tenant */
export function getTenantSettings(tenantId: string): TenantSettings;
export function getTenantSettings(tenantId?: string): TenantSettings {
  initSettingsTable();
  return loadTenantSettings(tenantId);
}

/** Update specific settings fields */
export function updateTenantSettings(
  updates: Partial<
    Omit<TenantSettings, 'tenantId' | 'updatedAt' | 'tier'>
  >,
  tenantId?: string
): TenantSettings {
  const database = getDb();
  const tid = tenantId ?? getTenantId();

  const allowedKeys = [
    'copilotModeEnabled',
    'holdingRepliesEnabled',
    'humanizerDelaySeconds',
    'botPersona',
    'customHtmlFooter',
    'watermarkEnabled',
  ];

  const updatesWithKeys = Object.keys(updates)
    .filter((key) => allowedKeys.includes(key))
    .map((key) => {
      const dbKey = key
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '');
      return `${dbKey} = ?`;
    });

  if (updatesWithKeys.length === 0) {
    logger.warn('No valid settings keys provided for update');
    return getTenantSettings(tid);
  }

  const values = Object.values(updates);
  values.push(tid);
  values.push(new Date().toISOString());

  database
    .prepare(
      `UPDATE tenant_settings 
       SET ${updatesWithKeys.join(', ')}, updated_at = ? 
       WHERE tenant_id = ?`
    )
    .run(...values);

  logger.info({ tenantId: tid, updates }, 'Tenant settings updated');
  return getTenantSettings(tid);
}

/** Update subscription tier (admin function) */
export function updateTenantTier(tier: SubscriptionTier, tenantId?: string): TenantSettings {
  const database = getDb();
  const tid = tenantId ?? getTenantId();

  database
    .prepare(`UPDATE tenant_settings SET tier = ?, updated_at = ? WHERE tenant_id = ?`)
    .run(tier, new Date().toISOString(), tid);

  logger.info({ tenantId: tid, tier }, 'Tenant tier updated');
  return getTenantSettings(tid);
}

/** Check if watermark is enforceable (based on tier) */
export function isWatermarkEnforceable(tier: SubscriptionTier): boolean {
  return tier === 'free' || tier === 'basic';
}

/** Check if user can remove watermark */
export function canRemoveWatermark(tier: SubscriptionTier): boolean {
  return !isWatermarkEnforceable(tier);
}

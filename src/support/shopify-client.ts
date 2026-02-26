/**
 * Shopify REST Admin API (2026-01) client for order lookup.
 * Headless worker: uses a pre-negotiated SHOPIFY_ACCESS_TOKEN injected at boot (e.g. by Web Dashboard after OAuth).
 * No OAuth handshakes, no client_credentials — token is provided by parent infrastructure.
 */
import { logger } from '../logger.js';

const API_VERSION = '2026-01';

function ensureHttpsOrigin(storeUrl: string): string {
  const trimmed = storeUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return u.origin;
  } catch {
    return trimmed;
  }
}

export interface ShopifyOrderLookupResult {
  success: boolean;
  order: Record<string, unknown> | null;
  reason: string;
  flags: string[];
  escalation_needed: boolean;
}

async function fetchWithRetry(
  url: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; data?: { orders?: unknown[] }; error?: string }> {
  const headers: Record<string, string> = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };

  const doFetch = async (): Promise<Response> => {
    return fetch(url, { method: 'GET', headers });
  };

  let res = await doFetch();
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await doFetch();
  }

  const text = await res.text();
  let data: { orders?: unknown[] } | undefined;
  try {
    data = text ? (JSON.parse(text) as { orders?: unknown[] }) : undefined;
  } catch {
    // non-JSON response (e.g. HTML error page)
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data,
      error: text.slice(0, 500),
    };
  }

  return { ok: true, status: res.status, data };
}

/**
 * Build orders list URL. REST list supports status, limit; name and email are common filters.
 * Order name: use without # for param (Shopify may store as #1001; we try name=1001).
 */
function buildOrdersUrl(
  baseUrl: string,
  options: { orderNumber?: string | null; email?: string | null },
): string {
  const origin = ensureHttpsOrigin(baseUrl);
  const path = `${origin.replace(/\/$/, '')}/admin/api/${API_VERSION}/orders.json`;
  const params = new URLSearchParams();
  params.set('status', 'any');
  params.set('limit', options.orderNumber ? '1' : '5');
  if (options.orderNumber) {
    const name = String(options.orderNumber).replace(/^#/, '').trim();
    if (name) params.set('name', `#${name}`);
  } else if (options.email) {
    params.set('email', String(options.email).trim());
  }
  const fields = [
    'id',
    'name',
    'financial_status',
    'fulfillment_status',
    'line_items',
    'fulfillments',
    'created_at',
    'updated_at',
    'total_price_set',
    'custom_attributes',
  ];
  params.set('fields', fields.join(','));
  return `${path}?${params.toString()}`;
}

function normalizeOrder(raw: unknown): Record<string, unknown> | null {
  if (raw == null || typeof raw !== 'object') return null;
  return raw as Record<string, unknown>;
}

function buildFlags(order: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const financial = order.financial_status as string | undefined;
  const fulfillment = order.fulfillment_status as string | undefined;
  const lineItems = (order.line_items as unknown[] | undefined) ?? [];
  let finalSaleFound = false;
  let refundEligible = false;
  for (const item of lineItems) {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const attrs = (obj.custom_attributes as unknown[] | undefined) ?? [];
    const attrStrs = attrs
      .filter((a): a is Record<string, unknown> => a != null && typeof a === 'object')
      .map((a) => String((a as { value?: unknown }).value ?? '').toLowerCase());
    if (
      attrStrs.some((s) => s.includes('final sale') || s.includes('no_refund'))
    ) {
      finalSaleFound = true;
    }
  }
  if (financial === 'paid' && !finalSaleFound) refundEligible = true;
  const fulfillments = (order.fulfillments as unknown[] | undefined) ?? [];
  const trackingAvailable = fulfillments.some(
    (f) =>
      f &&
      typeof f === 'object' &&
      Array.isArray((f as Record<string, unknown>).tracking_number),
  );
  const total = (order.total_price_set as Record<string, unknown> | undefined)
    ?.shop_money as Record<string, unknown> | undefined;
  const amount = total?.amount as string | undefined;
  const num = parseFloat(amount ?? '0');
  if (finalSaleFound) flags.push('final_sale_item_found');
  if (refundEligible) flags.push('refund_eligible');
  if (trackingAvailable) flags.push('tracking_available');
  if (num > 100) flags.push('high_value');
  return flags;
}

/**
 * Look up order by order number or customer email.
 * Uses pre-injected SHOPIFY_ACCESS_TOKEN (X-Shopify-Access-Token header). No auth negotiation.
 * Parent web infrastructure (Web Dashboard) performs OAuth and injects the token at container boot.
 */
export async function lookupOrder(
  storeUrl: string,
  accessToken: string,
  orderNumber: string | null,
  email: string | null,
): Promise<ShopifyOrderLookupResult> {
  if (!storeUrl?.trim() || !accessToken?.trim()) {
    return {
      success: false,
      order: null,
      reason: 'Shopify store URL or SHOPIFY_ACCESS_TOKEN missing. Token must be injected at boot by parent infrastructure (Web Dashboard OAuth).',
      flags: [],
      escalation_needed: true,
    };
  }

  const url = buildOrdersUrl(storeUrl, {
    orderNumber: orderNumber?.trim() || null,
    email: email?.trim() || null,
  });

  const result = await fetchWithRetry(url, accessToken);

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      logger.warn({ status: result.status }, 'Shopify API auth failed');
      return {
        success: false,
        order: null,
        reason: 'Shopify API authentication failed. Escalate to owner.',
        flags: [],
        escalation_needed: true,
      };
    }
    return {
      success: false,
      order: null,
      reason: `Shopify API error ${result.status}: ${result.error ?? 'unknown'}`,
      flags: [],
      escalation_needed: true,
    };
  }

  const orders = result.data?.orders ?? [];
  if (orders.length === 0) {
    return {
      success: true,
      order: null,
      reason: 'Order not found.',
      flags: ['clarification_needed'],
      escalation_needed: false,
    };
  }

  // Multiple orders: pick most recent by created_at
  const sorted = [...orders].sort((a, b) => {
    const aDate =
      (a && typeof a === 'object' && (a as Record<string, unknown>).created_at) as
        | string
        | undefined;
    const bDate =
      (b && typeof b === 'object' && (b as Record<string, unknown>).created_at) as
        | string
        | undefined;
    return (bDate ?? '').localeCompare(aDate ?? '');
  });
  const chosen = normalizeOrder(sorted[0]);
  if (!chosen) {
    return {
      success: true,
      order: null,
      reason: 'Order not found.',
      flags: ['clarification_needed'],
      escalation_needed: false,
    };
  }

  const flags = buildFlags(chosen);
  return {
    success: true,
    order: chosen,
    reason: 'Order found.',
    flags,
    escalation_needed: false,
  };
}

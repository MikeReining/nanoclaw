/**
 * Gmail Rate Limiter
 * 
 * Google Gmail API limits:
 * - 300 requests/minute per user (hard limit)
 * - 1000 requests/minute per project (soft limit)
 * 
 * This implementation uses a sliding window token bucket algorithm
 * to safely stay under the 300 req/min limit while allowing bursts
 * for batch operations.
 * 
 * Target: 250 requests/minute (83% of limit to be safe)
 */

export interface RateLimitConfig {
  /** Maximum requests per minute */
  requestsPerMinute: number;
  
  /** Burst allowance (requests allowed above normal rate temporarily) */
  burstAllowance: number;
  
  /** Grace period before resetting the window (ms) */
  windowMs: number;
}

export class GmailRateLimiter {
  private config: RateLimitConfig;
  private tokens: number;
  private lastRefill: number;
  private requestQueue: Array<() => void>;

  constructor(config: RateLimitConfig = {
    requestsPerMinute: 250,
    burstAllowance: 50,
    windowMs: 60000
  }) {
    this.config = config;
    this.tokens = config.requestsPerMinute + config.burstAllowance; // Start with burst
    this.lastRefill = Date.now();
    this.requestQueue = [];
    
    // Auto-refill tokens every second
    this.startAutoRefill();
  }

  /**
   * Acquire permission to send a request
   * Waits if necessary to respect rate limit
   */
  async acquire(): Promise<void> {
    // Wait until we have a token available
    while (!this.hasAvailableToken()) {
      await this.sleep(Math.min(100, this.config.windowMs / this.config.requestsPerMinute));
    }
    
    this.deductToken();
  }

  /**
   * Check if we have available tokens without waiting
   */
  canSend(): boolean {
    this.refillTokens();
    return this.hasAvailableToken();
  }

  /**
   * Get current token count (for monitoring/debugging)
   */
  getTokens(): number {
    this.refillTokens();
    return this.tokens;
  }

  /**
   * Get current wait time (ms) until next token available
   */
  getWaitTime(): number {
    if (this.hasAvailableToken()) return 0;
    
    const tokensPerMs = this.config.requestsPerMinute / this.config.windowMs;
    return Math.ceil(1 / tokensPerMs);
  }

  // ============ PRIVATE HELPERS ============

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    
    if (elapsed >= this.config.windowMs) {
      // Full window passed, reset to max
      this.tokens = this.config.requestsPerMinute + this.config.burstAllowance;
      this.lastRefill = now;
      return;
    }
    
    // Partial refill based on elapsed time
    const tokensToAdd = elapsed * (this.config.requestsPerMinute / this.config.windowMs);
    this.tokens = Math.min(
      this.config.requestsPerMinute + this.config.burstAllowance,
      this.tokens + tokensToAdd
    );
    
    this.lastRefill = now;
  }

  private hasAvailableToken(): boolean {
    return this.tokens >= 1.0;
  }

  private deductToken(): void {
    this.tokens -= 1.0;
  }

  private hasBurstTokens(): boolean {
    return this.tokens > this.config.requestsPerMinute;
  }

  private startAutoRefill(): void {
    setInterval(() => {
      this.refillTokens();
    }, 1000); // Refill every second
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ SINGLETON INSTANCE ============

export const gmailRateLimiter = new GmailRateLimiter({
  requestsPerMinute: 250,
  burstAllowance: 50,
  windowMs: 60000
});

// ============ BATCH PROCESSING HELPER ============

/**
 * Helper to batch Gmail API calls efficiently
 * 
 * Groups 10-20 messages into single API calls where possible
 * to reduce the number of rate-limited requests
 */
export async function batchGmailOperations<TReturn>(
  messages: Array<{ id: string; operation: () => Promise<TReturn> }>,
  limiter: GmailRateLimiter
): Promise<TReturn[]> {
  const results: TReturn[] = [];
  
  // Process in batches of 10
  const batchSize = 10;
  
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    // Wait for rate limit before processing batch
    for (const msg of batch) {
      await limiter.acquire();
    }
    
    // Execute operations in batch (parallel where possible)
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        try {
          return await msg.operation();
        } catch (error) {
          console.error(`Batch operation failed for message ${msg.id}:`, error);
          return null as unknown as TReturn;
        }
      })
    );
    
    results.push(...batchResults);
  }
  
  return results;
}

// ============ USAGE EXAMPLE ============

/*
import { gmailRateLimiter, batchGmailOperations } from './gmail-rate-limiter';

// Example: Process 50 unread emails
const unreadMessages = [/* ... * /];

// Option 1: Standard rate-limited processing
for (const message of unreadMessages) {
  await gmailRateLimiter.acquire();
  await processEmail(message.id);
}

// Option 2: Batch processing (more efficient)
const operations = unreadMessages.map(msg => ({
  id: msg.id,
  operation: () => gmail.users().messages().get({
    userId: 'me',
    id: msg.id
  })
}));

const results = await batchGmailOperations(operations, gmailRateLimiter);
*/

export default GmailRateLimiter;

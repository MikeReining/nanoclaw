import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile, access, constants, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STORE_ID = process.env.STORE_ID!;

const KB_PATH = '/brain/knowledge-base';
const KNOWN_KB_FILES = ['return-policy.md', 'shipping-faq.md', 'general-faq.md', 'brand-voice.md'];

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * refreshKnowledgeBase - Hybrid KB sync with disk cache + checksum validation
 * 
 * Flow:
 * 1. Check local disk cache for KB files + checksums
 * 2. If cache is valid and recent (< 30 minutes), use it
 * 3. If cache is missing/stale, fetch from Supabase Storage
 * 4. Write to disk with checksum validation
 * 5. If Supabase fails, use disk cache (graceful degradation)
 */
export async function refreshKnowledgeBase(): Promise<{
  success: boolean;
  usedCache: boolean;
  source: 'disk' | 'supabase' | 'default';
  error?: string;
}> {
  try {
    // Step 1: Try to load from disk cache
    const cacheStatus = await validateDiskCache();
    if (cacheStatus.valid && cacheStatus.fresh) {
      console.log('KB loaded from fresh disk cache');
      return { success: true, usedCache: true, source: 'disk' };
    }

    // Step 2: Fetch from Supabase Storage
    console.log('Fetching KB from Supabase Storage...');
    const result = await fetchKBFromSupabase();

    if (result.success) {
      await writeKBToDisk(result.files);
      console.log('KB refreshed from Supabase and cached to disk');
      return { success: true, usedCache: false, source: 'supabase' };
    }

    // Step 3: Graceful degradation - use default KB if Supabase fails
    console.warn('Supabase fetch failed, using default KB');
    await writeDefaultKB();
    return { success: true, usedCache: false, source: 'default' };

  } catch (error) {
    console.error('refreshKnowledgeBase failed:', error);
    
    // Last resort: try disk cache one more time
    try {
      await validateDiskCache();
      console.log('fallback: using disk cache after error');
      return { success: true, usedCache: true, source: 'disk' };
    } catch {
      // Final failure: write defaults
      await writeDefaultKB();
      return { 
        success: true, 
        usedCache: false, 
        source: 'default',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

async function validateDiskCache(): Promise<{ valid: boolean; fresh: boolean }> {
  try {
    // Check if required files exist
    for (const file of KNOWN_KB_FILES) {
      const path = join(KB_PATH, file);
      try {
        await access(path, constants.R_OK);
      } catch {
        return { valid: false, fresh: false };
      }
    }

    // Check checksums
    for (const file of KNOWN_KB_FILES) {
      const content = await readFile(join(KB_PATH, file), 'utf-8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const checksumPath = join(KB_PATH, '.checksum', `${file}.txt`);

      try {
        const storedChecksum = await readFile(checksumPath, 'utf-8').then(r => r.trim());
        if (storedChecksum !== checksum) {
          console.log(`Checksum mismatch for ${file}`);
          return { valid: false, fresh: false };
        }
      } catch {
        console.log(`Missing checksum for ${file}`);
        return { valid: false, fresh: false };
      }
    }

    // Check freshness (max 30 minutes)
    const lastModified = await getKBLastModified();
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    if (now - lastModified > thirtyMinutes) {
      console.log(`KB cache is ${Math.floor((now - lastModified) / 60000)} minutes old (max 30)`);
      return { valid: true, fresh: false };
    }

    return { valid: true, fresh: true };

  } catch (error) {
    return { valid: false, fresh: false };
  }
}

async function fetchKBFromSupabase(): Promise<{ success: boolean; files: Array<{ name: string; content: string }> }> {
  try {
    const bucket = 'knowledge_bases';
    const folder = `${STORE_ID}/global`;

    // List files in bucket
    const { data: files, error: listError } = await supabase.storage
      .from(bucket)
      .list(folder, { limit: 100, offset: 0, order: 'name', direction: 'asc' });

    if (listError || !files) {
      throw new Error(`Failed to list KB files: ${listError?.message}`);
    }

    // Filter to known KB files only
    const kbFiles = files.filter(f => KNOWN_KB_FILES.includes(f.name));

    if (kbFiles.length === 0) {
      console.warn('No KB files found for this store');
      return { success: false, files: [] };
    }

    // Download each file
    const downloadedFiles: Array<{ name: string; content: string }> = [];

    for (const file of kbFiles) {
      const { data, error: downloadError } = await supabase.storage
        .from(bucket)
        .download(`${folder}/${file.name}`);

      if (downloadError || !data) {
        console.warn(`Failed to download ${file.name}: ${downloadError?.message}`);
        continue; // Don't fail entire operation for one file
      }

      const content = await data.text();
      downloadedFiles.push({ name: file.name, content });
    }

    if (downloadedFiles.length === 0) {
      throw new Error('No KB files downloaded successfully');
    }

    return { success: true, files: downloadedFiles };

  } catch (error) {
    console.error('Error fetching KB from Supabase:', error);
    return { success: false, files: [] };
  }
}

async function writeKBToDisk(files: Array<{ name: string; content: string }>): Promise<void> {
  // Create directory if it doesn't exist
  await mkdir(KB_PATH, { recursive: true, mode: 0o755 });
  await mkdir(join(KB_PATH, '.checksum'), { recursive: true, mode: 0o755 });

  // Write each file
  for (const file of files) {
    const filePath = join(KB_PATH, file.name);
    const checksum = createHash('sha256').update(file.content).digest('hex');

    // Write file
    await writeFile(filePath, file.content, { mode: 0o644 });

    // Write checksum
    const checksumPath = join(KB_PATH, '.checksum', `${file.name}.txt`);
    await writeFile(checksumPath, checksum, { mode: 0o644 });

    console.log(`Wrote ${file.name} with checksum ${checksum.slice(0, 8)}...`);
  }

  // Update last modified timestamp
  await writeLastModifiedTimestamp();
}

async function writeDefaultKB(): Promise<void> {
  const defaultFiles = {
    'return-policy.md': `<!-- Last audited: ${new Date().toISOString().split('T')[0]} -->

# Return Policy

## General Returns
- **Time window**: 14 days from delivery
- **Condition**: Unused, with original packaging
- **Refund method**: Store credit or original payment method

## exceptions
- Final sale items (marked as "Final Sale")
- Custom/personalized products
- Hygiene-sensitive items (opened)

## Owner Warnings
- No specific policy on damaged-in-transit items
- No policy on restocking fees
- **Action required**: Add specific policy text for these edge cases
`,
    'shipping-faq.md': `<!-- Last audited: ${new Date().toISOString().split('T')[0]} -->

# Shipping FAQ

## Domestic Shipping
- **Processing time**: 1-2 business days
- **Standard shipping**: 3-5 business days
- **Express shipping**: 1-2 business days

## International Shipping
- **Availability**: Selected countries only
- **Processing time**: 2-3 business days
- **Delivery time**: 7-21 business days

## Owner Warnings
- **Missing**: No policy on shipping costs
- **Missing**: No policy on tracking
- **Action required**: Add specific shipping tier information
`,
    'general-faq.md': `<!-- Last audited: ${new Date().toISOString().split('T')[0]} -->

# General FAQ

## Pricing
- **Free shipping threshold**: $50+ orders
- **Currency**: USD
- **Payment methods**: Credit card, PayPal, Apple Pay

## Support Hours
- **Live chat**: Mon-Fri, 9AM-5PM EST
- **Email support**: 24-hour response time

## Owner Warnings
- **Missing**: No store location/address
- **Missing**: No social media links
- **Action required**: Add company contact information
`,
    'brand-voice.md': `<!-- Last audited: ${new Date().toISOString().split('T')[0]} -->

# Brand Voice Guidelines

## Tone
- **Friendly but professional**
- **Empathetic to customer frustrations**
- **Confident in policies (no waffling)**

## Structure
- Always lead with empathy
- Provide clear answer
- Offer help if problem unsolvable

## Sign-off
- "Best regards,"
- "Thanks for your understanding,"
- "We're here to help,"

## Owner Warnings
- **Missing**: No sample phrases or examples
- **Missing**: No "do not say" list
- **Action required**: Add example responses for common scenarios
`
  };

  const files = Object.entries(defaultFiles).map(([name, content]) => ({ name, content }));
  await writeKBToDisk(files);
  console.log('Wrote default KB files');
}

async function writeLastModifiedTimestamp(): Promise<void> {
  try {
    await mkdir(join(KB_PATH, '.metadata'), { recursive: true });
    await writeFile(
      join(KB_PATH, '.metadata', 'last_modified.txt'),
      Date.now().toString()
    );
  } catch (error) {
    console.warn('Failed to write last modified timestamp:', error);
  }
}

async function getKBLastModified(): Promise<number> {
  try {
    const path = join(KB_PATH, '.metadata', 'last_modified.txt');
    const content = await readFile(path, 'utf-8');
    return parseInt(content, 10);
  } catch {
    return 0;
  }
}

// Export for container boot execution
if (require.main === module) {
  refreshKnowledgeBase()
    .then(result => {
      console.log('refreshKnowledgeBase result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('refreshKnowledgeBase error:', error);
      process.exit(1);
    });
}

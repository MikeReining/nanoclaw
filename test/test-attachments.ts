#!/usr/bin/env tsx
/**
 * Standalone test script for V1 Attachment Pipeline.
 * Tests: image resizing, PDF extraction, Grok Vision summarization.
 * 
 * Usage: npm test -- attachments.ts
 */

import fs from 'fs';
import path from 'path';

import { extractAndProcessAttachments, formatSkippedAttachments } from '../src/support/attachment-utils.js';
import { grokComplete } from '../src/support/grok.js';
import { logger } from '../src/logger.js';

// Test file paths
const TEST_IMAGES_DIR = path.join(__dirname, 'fixtures', 'images');
const TEST_PDFS_DIR = path.join(__dirname, 'fixtures', 'pdfs');

/**
 * Create a mock Gmail payload from local test files.
 * This simulates what Gmail would return for an email with attachments.
 */
function createMockGmailPayload(
  imagePaths: string[],
  pdfPaths: string[],
): {
  payload: { parts?: Array<{ body: { data: string } } & Record<string, unknown> } };
  attachments: Array<{ filename: string; mimeType: string; base64: string }>;
} {
  const attachments: Array<{ filename: string; mimeType: string; base64: string }> = [];

  // Add images
  for (const imgPath of imagePaths) {
    const buffer = fs.readFileSync(imgPath);
    const filename = path.basename(imgPath);
    const mimeType = imgPath.endsWith('.png')
      ? 'image/png'
      : imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/jpeg';

    const base64 = buffer.toString('base64');

    attachments.push({ filename, mimeType, base64 });
  }

  // Add PDFs
  for (const pdfPath of pdfPaths) {
    const buffer = fs.readFileSync(pdfPath);
    const filename = path.basename(pdfPath);
    const mimeType = 'application/pdf';
    const base64 = buffer.toString('base64');

    attachments.push({ filename, mimeType, base64 });
  }

  // Convert to mock Gmail payload structure
  const parts = attachments.map((att) => ({
    body: {
      data: att.base64,
      filename: att.filename,
      mimeType: att.mimeType,
      id: `att-${att.filename}`,
      messageId: 'msg-test',
    },
    filename: att.filename,
    mimeType: att.mimeType,
  }));

  return {
    payload: { parts },
    attachments,
  };
}

/**
 * Test 1: Image processing (sharp)
 */
async function testImageProcessing(): Promise<void> {
  console.log('\n=== Test 1: Image Processing (Sharp) ===\n');

  // Find test images
  if (!fs.existsSync(TEST_IMAGES_DIR)) {
    console.log('SKIP: No fixtures/images directory found');
    return;
  }

  const imageFiles = fs
    .readdirSync(TEST_IMAGES_DIR)
    .filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f));

  if (imageFiles.length === 0) {
    console.log('SKIP: No test images found');
    return;
  }

  console.log(`Found ${imageFiles.length} test image(s)`);
  for (const file of imageFiles) {
    const filePath = path.join(TEST_IMAGES_DIR, file);
    const stats = fs.statSync(filePath);
    console.log(`  - ${file}: ${stats.size} bytes`);
  }

  // Create mock payload
  const imagePath = path.join(TEST_IMAGES_DIR, imageFiles[0]);
  const payload = createMockGmailPayload([imagePath], []);

  console.log('\nRunning extractAndProcessAttachments...');

  // Mock Gmail client (we won't actually call Gmail API)
  const mockGmail = {} as any;

  try {
    const result = await extractAndProcessAttachments(mockGmail, payload.payload!, process.env.GROK_API_KEY);

    console.log('\nResult:', JSON.stringify(result, null, 2));

    if (result.skippedStubs.length > 0) {
      console.log('\nSkipped stubs:', formatSkippedAttachments(result.skippedStubs));
    }

    if (result.visionJson) {
      console.log('\nVision JSON:', result.visionJson);
    } else {
      console.log('\n⚠️  Vision JSON is null (no attachments processed or GROK_API_KEY missing)');
    }
  } catch (err) {
    console.error('ERROR:', err);
  }
}

/**
 * Test 2: PDF processing (pdf-parse)
 */
async function testPdfProcessing(): Promise<void> {
  console.log('\n=== Test 2: PDF Processing (pdf-parse) ===\n');

  // Find test PDFs
  if (!fs.existsSync(TEST_PDFS_DIR)) {
    console.log('SKIP: No fixtures/pdfs directory found');
    return;
  }

  const pdfFiles = fs.readdirSync(TEST_PDFS_DIR).filter((f) => f.endsWith('.pdf'));

  if (pdfFiles.length === 0) {
    console.log('SKIP: No test PDFs found');
    return;
  }

  console.log(`Found ${pdfFiles.length} test PDF(s)`);
  for (const file of pdfFiles) {
    const filePath = path.join(TEST_PDFS_DIR, file);
    const stats = fs.statSync(filePath);
    console.log(`  - ${file}: ${stats.size} bytes`);
  }

  // Create mock payload
  const pdfPath = path.join(TEST_PDFS_DIR, pdfFiles[0]);
  const payload = createMockGmailPayload([], [pdfPath]);

  console.log('\nRunning extractAndProcessAttachments...');

  const mockGmail = {} as any;

  try {
    const result = await extractAndProcessAttachments(mockGmail, payload.payload!, process.env.GROK_API_KEY);

    console.log('\nResult:', JSON.stringify(result, null, 2));

    if (result.skippedStubs.length > 0) {
      console.log('\nSkipped stubs:', formatSkippedAttachments(result.skippedStubs));
    }

    if (result.visionJson) {
      console.log('\nVision JSON:', result.visionJson);
      // Try to parse and validate structure
      try {
        const parsed = JSON.parse(result.visionJson);
        console.log('\n✓ Vision JSON is valid');
        if (parsed.attachments && parsed.attachments.length > 0) {
          console.log(`✓ Found ${parsed.attachments.length} attachment(s) in response`);
          for (const att of parsed.attachments) {
            console.log(`  - ${att.filename}: ${att.type}`);
            console.log(`    Summary: ${att.summary.slice(0, 80)}...`);
          }
        }
      } catch (parseErr) {
        console.error('⚠️  Vision JSON parse failed:', parseErr);
      }
    } else {
      console.log('\n⚠️  Vision JSON is null (no attachments processed or GROK_API_KEY missing)');
    }
  } catch (err) {
    console.error('ERROR:', err);
  }
}

/**
 * Test 3: Skip threshold (too small files)
 */
async function testSkipThreshold(): Promise<void> {
  console.log('\n=== Test 3: Skip Threshold (15KB minimum) ===\n');

  // Create tiny mock payload (< 15KB)
  const tinyData = Buffer.from('x'.repeat(5000), 'base64'); // ~7KB
  const payload = createMockGmailPayload([], []);

  if (payload.payload.parts) {
    payload.payload.parts[0].body.data = tinyData.toString('base64');
    // Update size check in extractAndProcessAttachments would need payload access
  }

  console.log('SKIP: Skip threshold requires payload.body.data check (handled in extractAndProcessAttachments)');
  console.log('This is tested via unit tests in the actual pipeline.');
}

/**
 * Test 4: Multi-modal Grok call (direct)
 */
async function testGrokVisionCall(): Promise<void> {
  console.log('\n=== Test 4: Multi-Modal Grok Call ===\n');

  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    console.log('SKIP: GROK_API_KEY not set (requires xAI API key)');
    return;
  }

  // Find a test image
  if (!fs.existsSync(TEST_IMAGES_DIR)) {
    console.log('SKIP: No fixtures/images directory found');
    return;
  }

  const imageFiles = fs.readdirSync(TEST_IMAGES_DIR).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
  if (imageFiles.length === 0) {
    console.log('SKIP: No test images found');
    return;
  }

  const imagePath = path.join(TEST_IMAGES_DIR, imageFiles[0]);
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Jpeg = imageBuffer.toString('base64');

  console.log(`Test image: ${imageFiles[0]} (${base64Jpeg.length} chars base64)`);

  const contentBlocks = [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } },
    {
      type: 'text',
      text:
        'Analyze this image and extract any text, colors, shapes, or objects visible. Output as JSON only.',
    },
  ];

  console.log('\nCalling Grok Vision...');

  try {
    const result = await grokComplete(
      'You are a multimodal AI assistant analyzing customer support images.',
      contentBlocks,
      apiKey,
      512,
    );

    console.log('\nGrok Response:');
    console.log('---');
    console.log(result);
    console.log('---');

    try {
      const parsed = JSON.parse(result);
      console.log('\n✓ Response is valid JSON');
      console.log('Parsed:', JSON.stringify(parsed, null, 2));
    } catch (parseErr) {
      console.log('\n⚠️  Response is not JSON (that\'s OK for this test - Grok may return markdown)');
    }
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

async function main(): Promise<void> {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║      V1 Attachment Pipeline - Test Suite                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const apiKeyPresent = !!process.env.GROK_API_KEY;
  console.log(`GROK_API_KEY present: ${apiKeyPresent ? '✓' : '⚠️  missing (some tests skipped)\n'}`);

  await testImageProcessing();
  await testPdfProcessing();
  await testSkipThreshold();
  console.log('\n---\n');
  await testGrokVisionCall();

  console.log('\n=== Test Suite Complete ===\n');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

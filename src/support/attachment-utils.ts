/**
 * Attachment processing for V1 Multimodal "Eyes".
 * Fetches, filters, and processes email attachments (images + PDFs),
 * then returns a Grok Vision-ready summary.
 * Memory-optimized for 256MB Fly.io containers with jemalloc.
 */

import { gmail_v1 } from 'googleapis';
import sharp from 'sharp';
import pdfParse from 'pdf-parse';
import { summarizeAttachmentsViaVision as grokSummarizeAttachments } from './grok.js';
import { logger } from '../logger.js';

// SaaS Optimization: Constrain Sharp to run safely inside a 256MB container
sharp.cache(false); // Disable caching to save ~50MB of RAM (images are processed once)
sharp.concurrency(1); // Limit to 1 thread to prevent memory spikes

// Disable SIMD instructions in production to force aggressive memory release
if (process.env.NODE_ENV === 'production') {
  sharp.simd(false);
}

const MAX_IMAGE_WIDTH_PX = 1280;
const MIN_ATTACHMENT_BYTES = 15 * 1024; // 15KB threshold to skip email signature logos
const MAX_ATTACHMENTS = 3;
const MAX_PDF_PAGES = 5;
const PDF_TEXT_SPARSITY_THRESHOLD = 120; // Characters per page

const VALID_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
]);

const VALID_PDF_MIME_TYPE = 'application/pdf';

/** Processed image ready for Grok Vision (base64 JPEG) */
interface ProcessedImage {
  filename: string;
  mimeType: string;
  base64Jpeg: string;
}

/** Extracted text from a PDF */
interface ProcessedPdf {
  filename: string;
  text: string;
  isSparse: boolean;
  parseError?: string;
}

/** Stub entry for skipped attachments */
interface SkippedAttachmentStub {
  filename: string;
  mimeType: string;
  reason: string;
}

/** Grok Vision output schema */
interface GrokVisionAttachment {
  filename: string;
  type: 'image' | 'pdf';
  summary: string;
  ocr_text: string;
  key_facts: string[];
}

export interface AttachmentContextResult {
  visionJson: string | null;
  skippedStubs: SkippedAttachmentStub[];
}

/**
 * Fetch attachment data from Gmail and convert Base64 data URL to raw Base64 string.
 */
async function fetchAttachmentData(
  gmail: gmail_v1.Gmail,
  attachment: gmail_v1.Schema$MessagePartBody,
): Promise<string | null> {
  try {
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: attachment.messageId!,
      id: attachment.id!,
    });
    return res.data.data || null;
  } catch (err) {
    return null;
  }
}

/**
 * Process an image: decode Base64, resize to max width 1280px (maintain aspect ratio),
 * re-encode to Base64 JPEG.
 */
async function processImage(
  base64Data: string,
  mimeType: string,
  filename: string,
): Promise<ProcessedImage> {
  const buffer = Buffer.from(base64Data, 'base64');
  
  const resizedBuffer = await sharp(buffer)
    .resize({
      width: MAX_IMAGE_WIDTH_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const base64Jpeg = resizedBuffer.toString('base64');

  return {
    filename,
    mimeType,
    base64Jpeg,
  };
}

/**
 * Extract text from first 5 pages of a PDF.
 * Detect sparsity and append system note if detected.
 */
async function processPdf(
  base64Data: string,
  filename: string,
): Promise<ProcessedPdf> {
  const buffer = Buffer.from(base64Data, 'base64');

  try {
    const pdfData = await pdfParse(buffer, {
      pagesCount: MAX_PDF_PAGES,
    });

    const text = pdfData.text;
    const pageAverage = text.length / pdfData.numpages;
    const isSparse = pageAverage < PDF_TEXT_SPARSITY_THRESHOLD;

    const enrichedText = isSparse
      ? `[System Note: Scanned or image-based PDF detected. Text extraction minimal (${Math.round(pageAverage)} chars/page).]\n\n${text}`
      : text;

    return {
      filename,
      text: enrichedText,
      isSparse,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return {
      filename,
      text: `[System Note: PDF extraction failed - ${errorMessage}].`,
      isSparse: true,
      parseError: errorMessage,
    };
  }
}

/**
 * Generate a text stub for skipped attachments.
 */
function generateSkippedStub(
  filename: string,
  mimeType: string,
  reason: string,
): SkippedAttachmentStub {
  return {
    filename,
    mimeType,
    reason,
  };
}

/**
 * Main entry point: Extract, filter, process attachments, and generate Grok Vision context.
 * Returns processed attachments for Grok Vision, plus stubs for skipped files.
 */
export async function extractAndProcessAttachments(
  gmail: gmail_v1.Gmail,
  payload: gmail_v1.Schema$Message,
  grokApiKey?: string,
): Promise<AttachmentContextResult> {
  const attachments = payload.payload?.parts?.filter(
    (p): p is gmail_v1.Schema$MessagePart & { body: gmail_v1.Schema$MessagePartBody } =>
      !!p.body?.id && !!p.body?.messageId && !!p.body?.data,
  ) || [];

  // Filter: only valid types, above 15KB, limited to 3
  const selected: Array<{
    filename: string;
    mimeType: string;
    base64Data: string;
  }> = [];

  const skippedStubs: SkippedAttachmentStub[] = [];

  for (const part of attachments) {
    const { filename, mimeType, body } = part;
    
    // Skip if no filename
    if (!filename) continue;

    // Determine if valid
    const isImage = VALID_IMAGE_MIME_TYPES.has(mimeType);
    const isPdf = mimeType === VALID_PDF_MIME_TYPE;

    if (!isImage && !isPdf) {
      skippedStubs.push(generateSkippedStub(filename, mimeType, 'Unsupported MIME type'));
      continue;
    }

    // Skip if too small (signature logos)
    if (!body.data || body.data.length < MIN_ATTACHMENT_BYTES * 0.75) {
      // Use 0.75 because Gmail base64 padding may vary
      skippedStubs.push(generateSkippedStub(filename, mimeType, 'File less than 15KB (skipped)'));
      continue;
    }

    if (selected.length >= MAX_ATTACHMENTS) {
      skippedStubs.push(
        generateSkippedStub(filename, mimeType, 'Exceeds V1 processing limit (max 3 attachments)'),
      );
      continue;
    }

    // Fetch raw Base64 (Gmail attachments API can be missing data in parts)
    const rawBase64 = await fetchAttachmentData(gmail, {
      messageId: body.messageId!,
      id: body.id!,
    });

    if (!rawBase64) {
      skippedStubs.push(
        generateSkippedStub(filename, mimeType, 'Failed to fetch attachment data'),
      );
      continue;
    }

    selected.push({
      filename,
      mimeType,
      base64Data: rawBase64,
    });
  }

  // Process images and PDFs in parallel (but sharp's concurrency(1) queues them)
  const processedImages: ProcessedImage[] = [];
  const processedPdfs: ProcessedPdf[] = [];

  for (const item of selected) {
    if (VALID_IMAGE_MIME_TYPES.has(item.mimeType)) {
      const processed = await processImage(item.base64Data, item.mimeType, item.filename);
      processedImages.push(processed);
    } else if (item.mimeType === VALID_PDF_MIME_TYPE) {
      const processed = await processPdf(item.base64Data, item.filename);
      processedPdfs.push(processed);
    }
  }

  // Summarize via Grok Vision (only if we have attachments and API key)
  let visionJson: string | null = null;

  if ((processedImages.length > 0 || processedPdfs.length > 0) && grokApiKey) {
    try {
      visionJson = await grokSummarizeAttachments(
        processedImages.map((img) => ({
          filename: img.filename,
          base64Jpeg: img.base64Jpeg,
        })),
        processedPdfs.map((pdf) => ({
          filename: pdf.filename,
          text: pdf.text,
        })),
        grokApiKey,
      );
    } catch (err) {
      logger.warn({ err }, 'Grok Vision summarization failed, using attachment metadata only');
      // Fall through to return skippedStubs only
    }
  }

  return {
    visionJson,
    skippedStubs,
  };
}

/**
 * Construct a single prompt to Grok that includes all Base64 images and PDF texts.
 * Returns the prompt string ready for xAI's multi-modal API.
 */
export function buildGrokVisionPrompt(
  processedImages: ProcessedImage[],
  processedPdfs: ProcessedPdf[],
): string {
  const imageBlocks: string[] = [];
  const pdfTexts: string[] = [];

  for (const img of processedImages) {
    imageBlocks.push(`--- Image: ${img.filename} (JPEG, ${img.mimeType}) ---`);
  }

  for (const pdf of processedPdfs) {
    pdfTexts.push(`--- PDF: ${pdf.filename} ---`);
    pdfTexts.push(pdf.text);
    pdfTexts.push('');
  }

  const prompt = `Analyze these customer support attachments. Extract all relevant text, OCR data, error messages, and product details.
${imageBlocks.length > 0 ? `You will receive ${imageBlocks.length} image(s) as separate content blocks. For each image, identify: product type, error messages visible, UI elements shown, and any text visible in screenshots.

` : ''}${
    pdfTexts.length > 0
      ? `The following PDF text content is included below the images:\n\n${pdfTexts.join('\n')}`
      : ''
  }

You MUST output your response as valid JSON matching this schema:
{
  "attachments": [
    {
      "filename": "original_filename.ext",
      "type": "image|pdf",
      "summary": "Brief 1-2 sentence description of what's shown",
      "ocr_text": "All extracted text from the image or PDF",
      "key_facts": ["Fact 1", "Fact 2", "Fact 3"]
    }
  ]
}

Be thorough and precise. Prioritize error messages, account numbers, product IDs, and customer intent.`;

  return prompt;
}

/**
 * Create a text block for skipped attachment stubs.
 */
export function formatSkippedAttachments(stubs: SkippedAttachmentStub[]): string {
  if (stubs.length === 0) return '';

  const lines = ['\n--- SKIPPED ATTACHMENTS (Exceeds V1 Processing Limits) ---'];
  
  for (const stub of stubs) {
    lines.push(
      `Skipped Attachment: ${stub.filename} (${stub.mimeType}) - ${stub.reason}`,
    );
  }

  lines.push('--- END SKIPPED ATTACHMENTS ---\n');

  return lines.join('\n');
}

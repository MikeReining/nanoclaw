/**
 * xAI Grok Responses API — stateless call, no conversation storage.
 * Model: grok-4-1-fast-reasoning. Auth: Bearer GROK_API_KEY.
 * Supports both text-only and multi-modal (image + text) content.
 */
const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
const MODEL = 'grok-4-1-fast-reasoning';

interface OutputTextPart {
  type: 'output_text';
  text: string;
}

interface OutputMessage {
  type: 'message';
  role: string;
  content?: Array<OutputTextPart>;
}

interface XaiResponse {
  output?: Array<OutputMessage>;
}

export type GrokContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Text-only or multi-modal Grok call.
 * - If userContent is a string, uses legacy text-only API.
 * - If contentBlocks is provided (array of text/image blocks), uses multi-modal API.
 */
export async function grokComplete(
  systemContent: string,
  userContent: string | Array<GrokContentBlock>,
  apiKey: string,
  maxTokens = 1024,
  externalSignal?: AbortSignal,
): Promise<string> {
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);

  const isMultiModal = Array.isArray(userContent);

  const body: Record<string, unknown> = {
    model: MODEL,
    store: false,
    max_output_tokens: maxTokens,
  };

  if (isMultiModal) {
    // Multi-modal: array of content blocks
    body.input = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ];
  } else {
    // Text-only: legacy format
    body.input = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ];
  }

  const res = await fetch(XAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Grok API ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as XaiResponse;
  const message = data.output?.find(
    (o): o is OutputMessage => o.type === 'message' && o.role === 'assistant',
  );
  const part = message?.content?.find((c) => c.type === 'output_text');
  return part?.text ?? '';
}

/**
 * Summarize attachments via Grok Vision.
 * Processes images (base64 JPEG) and PDF texts through a single Vision call.
 * Returns the raw JSON response from Grok.
 */
export async function summarizeAttachmentsViaVision(
  processedImages: Array<{ filename: string; base64Jpeg: string }>,
  processedPdfs: Array<{ filename: string; text: string }>,
  apiKey: string,
): Promise<string | null> {
  if (processedImages.length === 0 && processedPdfs.length === 0) {
    return null;
  }

  // Build the multi-modal content array
  const contentBlocks: GrokContentBlock[] = [];

  // Add all images first
  for (const img of processedImages) {
    contentBlocks.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${img.base64Jpeg}`,
      },
    });
  }

  // Add PDF text as text blocks (with filenames for context)
  for (const pdf of processedPdfs) {
    contentBlocks.push({
      type: 'text',
      text: `--- PDF Context: ${pdf.filename} ---\n${pdf.text}`,
    });
  }

  // Add the prompt directive as the final text block
  contentBlocks.push({
    type: 'text',
    text: `You MUST output your response as valid JSON matching this schema:\n{\n  "attachments": [\n    {\n      "filename": "original_filename.ext",\n      "type": "image|pdf",\n      "summary": "Brief 1-2 sentence description of what's shown",\n      "ocr_text": "All extracted text from the image or PDF",\n      "key_facts": ["Fact 1", "Fact 2", "Fact 3"]\n    }\n  ]\n}\n\nBe thorough and precise. Prioritize error messages, account numbers, product IDs, and customer intent.`,
  });

  const systemPrompt =
    'You are a multimodal AI assistant analyzing customer support attachments. Extract all relevant text, OCR data, error messages, and product details. Output must be valid JSON.';

  const result = await grokComplete(systemPrompt, contentBlocks, apiKey);

  return result || null;
}

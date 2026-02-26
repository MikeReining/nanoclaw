/**
 * xAI Grok Responses API — stateless call, no conversation storage.
 * Model: grok-4-1-fast-reasoning. Auth: Bearer GROK_API_KEY.
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

export async function grokComplete(
  systemContent: string,
  userContent: string,
  apiKey: string,
  maxTokens = 1024,
): Promise<string> {
  const res = await fetch(XAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      store: false,
      max_output_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(120_000), // 2 min for reasoning model
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

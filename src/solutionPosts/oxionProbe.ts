/** Fixed-origin, bounded diagnostics. Supplied credentials are never saved or logged. */
export async function probeOxion(apiKey: string, model?: string, structured = false, maxTokens = 128) {
  const started = Date.now();
  const origin = 'https://oxionai.com/v1';
  const metadata = {
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null,
    testedAt: new Date().toISOString(),
    operation: model ? (structured ? 'structured' : 'completion') : 'models',
    requestedModel: model ?? null,
  };
  const clean = (value: unknown) => String(value ?? '').split(apiKey).join('[REDACTED]')
    .replace(/(?:cc_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);
  try {
    const response = await fetch(`${origin}/${model ? 'chat/completions' : 'models'}`, {
      method: model ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      ...(model ? { body: JSON.stringify({ model,
        messages: [{ role: 'user', content: structured ?
          'Return only a JSON object with intuition (one short sentence), approach (two short strings), timeComplexity (string), and code (a C++ function int square(int n) returning n*n). No Markdown.' :
          'Reply with exactly OXION_RENDER_OK.' }],
        max_tokens: maxTokens,
        ...(structured ? { response_format: { type: 'json_object' } } : {}),
      }) } : {}),
      signal: AbortSignal.timeout(model ? 45000 : 20000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* Never retain upstream HTML. */ }
    const common = { ...metadata, elapsedMs: Date.now() - started, status: response.status,
      contentType, providerRequestId: response.headers.get('x-request-id') ?? response.headers.get('cf-ray') };
    if (!response.ok) {
      const html = /text\/html/i.test(contentType) || /^\s*<!doctype|^\s*<html/i.test(raw);
      return { ...common, ok: false, category: html ? 'PROVIDER_HTML_ACCESS_DENIAL' :
        response.status === 401 ? 'INVALID_API_KEY' : response.status === 402 ? 'BILLING_OR_ALLOWANCE_REQUIRED' :
        response.status === 403 ? 'PROVIDER_PERMISSION_DENIED' : response.status === 429 ? 'RATE_OR_QUOTA_LIMIT' : 'PROVIDER_ERROR',
      error: html ? 'Provider returned an HTML access page instead of an API response.' :
        clean(data.error?.message ?? data.message ?? `HTTP_${response.status}`),
      errorCode: clean(data.error?.code), errorType: clean(data.error?.type) };
    }
    if (!model) {
      const models = Array.isArray(data.data) ? data.data.map((item: any) => item?.id)
        .filter((id: unknown): id is string => typeof id === 'string').slice(0, 200) : [];
      return { ...common, ok: models.length > 0, models, modelsCount: models.length };
    }
    const content = data.choices?.[0]?.message?.content;
    const replyReceived = typeof content === 'string' && content.trim().length > 0;
    let validJson = false;
    if (structured && replyReceived) {
      try {
        const parsed = JSON.parse(content);
        validJson = typeof parsed.intuition === 'string' && Array.isArray(parsed.approach) &&
          parsed.approach.length === 2 && parsed.approach.every((s: unknown) => typeof s === 'string') &&
          typeof parsed.timeComplexity === 'string' && typeof parsed.code === 'string';
      } catch { /* Report failed structured output separately from transport success. */ }
    }
    const finishReason = data.choices?.[0]?.finish_reason ?? null;
    return { ...common, ok: replyReceived && finishReason === 'stop' && (!structured || validJson),
      servedModel: clean(data.model), replyReceived, finishReason, validJson: structured ? validJson : null,
      markerMatched: !structured && replyReceived ? content.trim() === 'OXION_RENDER_OK' : null,
      reply: replyReceived ? clean(content) : null,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens ?? null,
        completionTokens: data.usage.completion_tokens ?? null, totalTokens: data.usage.total_tokens ?? null } : null,
      reportedCost: typeof data.usage?.cost === 'number' ? data.usage.cost :
        typeof data.cost === 'number' ? data.cost : null,
    };
  } catch (error) {
    return { ...metadata, ok: false, status: 0, elapsedMs: Date.now() - started,
      category: error instanceof Error && /Timeout|Abort/.test(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR',
      error: 'Provider request did not complete.' };
  }
}

/** Bounded, fixed-origin BazaarLink free-model probe. Credentials are never persisted. */
export async function probeBazaarLink(apiKey: string) {
  const started = Date.now();
  const model = 'qwen/qwen3.7-flash:free';
  const clean = (value: unknown) => String(value ?? '').split(apiKey).join('[REDACTED]')
    .replace(/sk-bl-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 240);
  const metadata = {
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null,
    testedAt: new Date().toISOString(),
    requestedModel: model,
  };
  try {
    const response = await fetch('https://api.bazaarlink.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Free-Fallback': 'false' },
      redirect: 'error',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly BAZAARLINK_RENDER_OK.' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* never return raw HTML or malformed response bodies */ }
    const content = data.choices?.[0]?.message?.content;
    const replyReceived = typeof content === 'string' && content.trim().length > 0;
    return {
      ...metadata,
      ok: response.ok && replyReceived && data.choices?.[0]?.finish_reason === 'stop',
      status: response.status,
      category: response.ok ? undefined : response.status === 401 ? 'INVALID_API_KEY' :
        response.status === 402 ? 'BILLING_OR_ALLOWANCE_REQUIRED' : response.status === 403 ? 'PROVIDER_PERMISSION_DENIED' :
          response.status === 429 ? 'FREE_QUOTA_OR_RATE_LIMIT' : 'PROVIDER_ERROR',
      ...(response.ok ? {} : { error: clean(data.error?.message ?? data.message ?? `HTTP_${response.status}`),
        errorCode: clean(data.error?.code) }),
      servedModel: clean(data.model ?? ''), replyReceived,
      markerMatched: replyReceived ? content.trim() === 'BAZAARLINK_RENDER_OK' : false,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens ?? null,
        completionTokens: data.usage.completion_tokens ?? null, totalTokens: data.usage.total_tokens ?? null } : null,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return { ...metadata, ok: false, status: 0, elapsedMs: Date.now() - started,
      category: error instanceof Error && /Timeout|Abort/.test(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR',
      error: 'Provider request did not complete.' };
  }
}

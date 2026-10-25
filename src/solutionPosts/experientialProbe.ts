/** Bounded, fixed-origin check for an Experiential Labs key. Never persists credentials. */
export async function probeExperiential(apiKey: string, requestedModel?: string) {
  const started = Date.now();
  const origin = 'https://api.experientiallabs.ai/v1';
  const metadata = {
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null,
    testedAt: new Date().toISOString(),
  };
  const clean = (value: unknown) => String(value ?? '').split(apiKey).join('[REDACTED]')
    .replace(/xpl_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);

  try {
    const modelsResponse = await fetch(`${origin}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    const modelsRaw = await modelsResponse.text();
    let modelsData: any = {};
    try { modelsData = JSON.parse(modelsRaw); } catch { /* omit upstream HTML and malformed bodies */ }
    const models = Array.isArray(modelsData.data) ? modelsData.data.map((item: any) => item?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length <= 160).slice(0, 200) : [];
    if (!modelsResponse.ok) return {
      ...metadata, ok: false, stage: 'model_discovery', status: modelsResponse.status,
      category: modelsResponse.status === 401 ? 'INVALID_API_KEY' : modelsResponse.status === 403 ? 'PROVIDER_PERMISSION_DENIED' :
        modelsResponse.status === 429 ? 'RATE_OR_QUOTA_LIMIT' : 'PROVIDER_ERROR',
      error: clean(modelsData.error?.message ?? modelsData.message ?? `HTTP_${modelsResponse.status}`),
      elapsedMs: Date.now() - started,
    };
    if (!models.length) return { ...metadata, ok: false, stage: 'model_discovery', status: modelsResponse.status,
      category: 'EMPTY_MODEL_CATALOG', modelsCount: 0, elapsedMs: Date.now() - started };

    const model = requestedModel ?? models[0];
    if (!models.includes(model)) return { ...metadata, ok: false, stage: 'model_discovery', status: modelsResponse.status,
      category: 'MODEL_NOT_AVAILABLE_TO_KEY', modelsCount: models.length, requestedModel: clean(model),
      models: models.map(clean), elapsedMs: Date.now() - started };

    const completion = await fetch(`${origin}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly EXPERIENTIAL_RENDER_OK.' }], max_tokens: 24 }),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await completion.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* never return raw provider response */ }
    const content = data.choices?.[0]?.message?.content;
    const replyReceived = typeof content === 'string' && content.trim().length > 0;
    return {
      ...metadata, ok: completion.ok && replyReceived && data.choices?.[0]?.finish_reason === 'stop',
      stage: 'chat_completion', status: completion.status, category: completion.ok ? undefined :
        completion.status === 401 ? 'INVALID_API_KEY' : completion.status === 402 ? 'BILLING_OR_ALLOWANCE_REQUIRED' :
          completion.status === 403 ? 'PROVIDER_PERMISSION_DENIED' : completion.status === 429 ? 'RATE_OR_QUOTA_LIMIT' : 'PROVIDER_ERROR',
      ...(completion.ok ? {} : { error: clean(data.error?.message ?? data.message ?? `HTTP_${completion.status}`) }),
      modelsCount: models.length, requestedModel: clean(model), servedModel: clean(data.model ?? ''),
      replyReceived, markerMatched: replyReceived ? content.trim() === 'EXPERIENTIAL_RENDER_OK' : false,
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

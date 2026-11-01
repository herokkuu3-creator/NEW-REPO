import { FirecrawlAgentRouter } from './firecrawlAgent';
import { firecrawlProbeRequest } from './firecrawlProbe';
import { ModelAttempt, RoutingError } from './router';

/** Explicit, capped inference test. It is never run automatically at startup. */
export async function probeFirecrawlAgent(apiKey: string, maxCredits = 50) {
  firecrawlProbeRequest.parse({ apiKey });
  const started = Date.now();
  let attempt: ModelAttempt | undefined;
  const meta = { executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null, testedAt: new Date().toISOString(), provider: 'firecrawl-agent',
    maxCredits: Math.min(50, Math.max(1, maxCredits)) };
  try {
    const router = new FirecrawlAgentRouter(apiKey, meta.maxCredits, a => { attempt = a; });
    const result = await router.generate([{ role: 'user', content: 'Reply with exactly OK.' }], text => text, 32, false, 'agent-diagnostic');
    return { ...meta, ok: result.value.trim().toUpperCase() === 'OK', outcome: attempt?.outcome ?? 'UNKNOWN',
      model: result.model, creditsUsed: attempt?.agentCreditsUsed ?? null, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ...meta, ok: false, outcome: error instanceof RoutingError ? error.lastFailure ?? 'AGENT_FAILED' : 'AGENT_FAILED',
      creditsUsed: attempt?.agentCreditsUsed ?? null, elapsedMs: Date.now() - started };
  }
}

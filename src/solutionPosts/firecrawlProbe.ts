import { z } from 'zod';

export const firecrawlProbeRequest = z.object({
  apiKey: z.string().regex(/^fc-[A-Za-z0-9_-]{16,128}$/),
}).strict();

/** One fixed public-page scrape. Never saves credentials or returns upstream text. */
export async function probeFirecrawl(apiKey: string) {
  // Validate even for non-HTTP callers, before transmitting a credential.
  firecrawlProbeRequest.parse({ apiKey });
  const started = Date.now();
  const targetUrl = 'https://example.com';
  const metadata = {
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
    revision: process.env.RENDER_GIT_COMMIT ?? null,
    testedAt: new Date().toISOString(), targetUrl,
  };
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* Never expose raw HTML or provider errors. */ }
    const markdown = data?.data?.markdown;
    const contentReceived = typeof markdown === 'string' && markdown.trim().length > 0;
    const targetStatus = Number.isInteger(data?.data?.metadata?.statusCode) ? data.data.metadata.statusCode : null;
    // onlyMainContent can remove the page heading; validate its distinctive body too.
    const expectedContent = contentReceived && /\bExample Domain\b|domain is for use in documentation examples/i.test(markdown);
    const ok = response.ok && data?.success === true && expectedContent &&
      (targetStatus === null || (targetStatus >= 200 && targetStatus < 300));
    return { ...metadata, ok, status: response.status, elapsedMs: Date.now() - started,
      contentReceived, expectedContent, targetStatus,
      markdownCharacters: contentReceived ? markdown.length : 0,
      category: ok ? 'SCRAPE_OK' : response.status === 401 ? 'INVALID_API_KEY' :
        response.status === 402 ? 'CREDITS_OR_BILLING_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' :
          response.status === 429 ? 'RATE_OR_QUOTA_LIMIT' : response.ok ? 'INVALID_SCRAPE_RESULT' : 'PROVIDER_ERROR',
    };
  } catch (error) {
    return { ...metadata, ok: false, status: 0, elapsedMs: Date.now() - started,
      category: error instanceof Error && /Timeout|Abort/.test(error.name) ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}

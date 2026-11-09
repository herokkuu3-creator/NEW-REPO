export const DEFAULT_SOLUTION_POST_BASE_URL = 'https://discovery-api.intern-ai.org.cn/v1';
export const DEFAULT_SOLUTION_POST_MODEL = 'minimax-m3';

export function isBazaarLinkProvider(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'https:' &&
    ((url.hostname === 'api.bazaarlink.ai' && url.pathname.replace(/\/+$/, '') === '/v1') ||
      (url.hostname === 'bazaarlink.ai' && url.pathname.replace(/\/+$/, '') === '/api/v1'));
}

export function isSageProvider(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes('intern-ai.org.cn');
  } catch {
    return false;
  }
}

/** Keep free model requests from automatically falling back to paid usage. */
export function solutionPostProviderHeaders(baseUrl: string): Record<string, string> {
  return isBazaarLinkProvider(baseUrl) ? { 'X-Free-Fallback': 'false' } : {};
}

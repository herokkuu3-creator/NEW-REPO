export const DEFAULT_SOLUTION_POST_BASE_URL = 'https://api.bazaarlink.ai/v1';
export const DEFAULT_SOLUTION_POST_MODEL = 'qwen/qwen3.7-flash:free';

export function isBazaarLinkProvider(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'https:' &&
    ((url.hostname === 'api.bazaarlink.ai' && url.pathname.replace(/\/+$/, '') === '/v1') ||
      (url.hostname === 'bazaarlink.ai' && url.pathname.replace(/\/+$/, '') === '/api/v1'));
}

/** Keep free model requests from automatically falling back to paid usage. */
export function solutionPostProviderHeaders(baseUrl: string): Record<string, string> {
  return isBazaarLinkProvider(baseUrl) ? { 'X-Free-Fallback': 'false' } : {};
}

import { isBazaarLinkProvider } from './solutionPostProvider';

export const ARTICLE_KEY_VARIABLES = ['BAZAARLINK_API_KEYS', 'BAZAARLINK_API_KEY',
  'SOLUTION_POST_API_KEYS', 'SOLUTION_POST_API_KEY'] as const;
type KeyVariable = typeof ARTICLE_KEY_VARIABLES[number];
export interface ArticleKeyInput {
  name: KeyVariable; present: boolean; count: number; invalid: boolean;
}

/** Credentials are opaque. Only transport-safe structure is checked locally;
 * the selected provider determines whether the credential is valid. */
export function parseSolutionApiKeys(input: string | string[]): string[] {
  const tokens = (Array.isArray(input) ? input : [input]).flatMap(raw => {
    let value = raw.trim().replace(/^```(?:env|dotenv|text)?\s*\n([\s\S]*?)\n```$/, '$1');
    value = value.replace(/^(?:export\s+)?(?:BAZAARLINK|SOLUTION_POST)_API_KEYS?\s*=\s*/i, '');
    if (value.startsWith('[')) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (Array.isArray(decoded) && decoded.every(item => typeof item === 'string')) return decoded;
      } catch { /* accept ordinary wrapped comma-separated values below */ }
    }
    return value.split(/[,\n\r\t]+/);
  });
  const keys: string[] = [];
  for (const token of tokens) {
    const value = token.trim().replace(/^["'`<[(\{]+|["'`>\])}\s]+$/g, '')
      .replace(/^Bearer\s+/i, '');
    if (!value || /^(?:none|null|undefined|test|fixture)$/i.test(value)) continue;
    if (value.length < 8 || value.length > 512 || /\s/.test(value)) {
      throw new Error('Each API key must be 8–512 non-whitespace characters');
    }
    if (!keys.includes(value)) keys.push(value);
  }
  if (keys.length > 100) throw new Error('At most 100 API keys may be stored');
  return keys;
}

export function resolveArticleKeys(env: Partial<Record<KeyVariable, string>>, baseUrl: string) {
  const inputs = ARTICLE_KEY_VARIABLES.map(name => {
    const raw = env[name] ?? '';
    try { return { name, present: !!raw.trim(), keys: parseSolutionApiKeys(raw), invalid: false }; }
    catch { return { name, present: !!raw.trim(), keys: [] as string[], invalid: true }; }
  });
  const order = isBazaarLinkProvider(baseUrl) ? ARTICLE_KEY_VARIABLES :
    ['SOLUTION_POST_API_KEYS', 'SOLUTION_POST_API_KEY'] as const;
  const selected = order.map(name => inputs.find(input => input.name === name)!)
    .find(input => input.keys.length > 0 || input.invalid);
  return {
    apiKey: selected?.keys[0] ?? '', apiKeys: selected?.keys ?? [], keySource: selected?.name,
    keyError: selected?.invalid ? 'AI_KEY_INPUT_INVALID' : undefined,
    // This is the only form suitable for logs and diagnostic responses.
    keyEnvironment: inputs.map(({ name, present, keys, invalid }): ArticleKeyInput =>
      ({ name, present, count: keys.length, invalid })),
  };
}

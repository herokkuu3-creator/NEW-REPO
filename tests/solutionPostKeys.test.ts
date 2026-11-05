import { describe, expect, it } from 'vitest';
import { parseSolutionApiKeys, resolveArticleKeys } from '../src/config/solutionPostKeys';
const bazaar = 'https://api.bazaarlink.ai/v1';

describe('article credential input', () => {
  it.each([
    'opaque_key_one,opaque_key_two',
    'SOLUTION_POST_API_KEYS="opaque_key_one,opaque_key_two"',
    'export BAZAARLINK_API_KEYS=opaque_key_one,opaque_key_two',
    '["opaque_key_one","opaque_key_two"]',
    '```env\nSOLUTION_POST_API_KEYS="opaque_key_one,opaque_key_two"\n```',
    'Bearer opaque_key_one, Bearer opaque_key_two',
  ])('normalizes a supported copied key input without prefix assumptions (%#)', input => {
    expect(parseSolutionApiKeys(input)).toEqual(['opaque_key_one', 'opaque_key_two']);
  });
  it('retains every key in a ten-key pool, deduplicates, and preserves credential padding', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `opaque_key_${i}==`);
    expect(parseSolutionApiKeys([...keys, keys[0]!])).toEqual(keys);
  });
  it('rejects malformed transport structure without echoing the credential', () => {
    expect(() => parseSolutionApiKeys('private key with spaces')).toThrow('non-whitespace');
    expect(() => parseSolutionApiKeys(Array.from({ length: 101 }, (_, i) => `opaque_key_${i}`))).toThrow('At most 100');
  });
  it('prefers provider-specific credentials over an old generic plural pool', () => {
    const result = resolveArticleKeys({ BAZAARLINK_API_KEY: 'opaque_bazaar_key',
      SOLUTION_POST_API_KEYS: 'old_generic_key' }, bazaar);
    expect(result.apiKeys).toEqual(['opaque_bazaar_key']);
    expect(result.keySource).toBe('BAZAARLINK_API_KEY');
    expect(JSON.stringify(result.keyEnvironment)).not.toContain('opaque_bazaar_key');
  });
  it('uses a generic plural pool without dropping opaque entries', () => {
    const result = resolveArticleKeys({ SOLUTION_POST_API_KEYS: 'key_one_0001,key_two_0002' }, bazaar);
    expect(result.apiKeys).toEqual(['key_one_0001', 'key_two_0002']);
    expect(result.keySource).toBe('SOLUTION_POST_API_KEYS');
  });
  it('does not let an empty plural variable hide a populated singular key', () => {
    expect(resolveArticleKeys({ SOLUTION_POST_API_KEYS: ' , ', SOLUTION_POST_API_KEY: 'single_key_0001' }, bazaar).apiKeys)
      .toEqual(['single_key_0001']);
  });
  it('isolates another provider from BazaarLink-only environment credentials', () => {
    expect(resolveArticleKeys({ BAZAARLINK_API_KEY: 'opaque_bazaar_key', SOLUTION_POST_API_KEY: 'other_provider_key' },
      'https://example.test/v1').apiKeys).toEqual(['other_provider_key']);
  });
  it('reports malformed selected inputs explicitly instead of silently choosing another credential', () => {
    const result = resolveArticleKeys({ BAZAARLINK_API_KEY: 'bad value with spaces', SOLUTION_POST_API_KEY: 'generic_key_0001' }, bazaar);
    expect(result).toMatchObject({ apiKeys: [], keyError: 'AI_KEY_INPUT_INVALID', keySource: 'BAZAARLINK_API_KEY' });
    expect(result.keyEnvironment[1]).toMatchObject({ present: true, count: 0, invalid: true });
    expect(JSON.stringify(result)).not.toContain('bad value');
  });
  it('falls back to default Sage Inkstone key when Sage provider is used without custom keys', () => {
    const sageBaseUrl = 'https://discovery-api.intern-ai.org.cn/v1';
    const result = resolveArticleKeys({}, sageBaseUrl);
    expect(result.apiKey).toBe('sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056');
    expect(result.apiKeys).toEqual(['sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056']);
    expect(result.keySource).toBe('DEFAULT_SAGE_KEY');
  });
  it('prefers explicit SAGE_API_KEY over default Sage key', () => {
    const sageBaseUrl = 'https://discovery-api.intern-ai.org.cn/v1';
    const result = resolveArticleKeys({ SAGE_API_KEY: 'sk-custom-sage-key-12345' }, sageBaseUrl);
    expect(result.apiKey).toBe('sk-custom-sage-key-12345');
    expect(result.apiKeys).toEqual(['sk-custom-sage-key-12345']);
    expect(result.keySource).toBe('SAGE_API_KEY');
  });
});

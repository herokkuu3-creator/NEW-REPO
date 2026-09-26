import { describe, expect, it } from 'vitest';
import { createLLMProvider, LLMError, SUPPORTED_PROVIDERS } from '../src/ai/provider';
import { GeminiProvider, GEMINI_OPENAI_BASE_URL } from '../src/ai/gemini';

/**
 * Provider selection. The test environment sets LLM_PROVIDER=gemini and
 * LLM_API_KEY (see vitest.config.ts), so these exercise the real factory
 * against real config parsing — no mocks of the config layer.
 */
describe('createLLMProvider', () => {
  it('constructs the gemini provider from configuration', () => {
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.name).toBe('gemini');
    expect(provider.model).toBeTruthy();
  });

  it('exposes the providers it supports', () => {
    expect(SUPPORTED_PROVIDERS).toContain('gemini');
    expect(SUPPORTED_PROVIDERS).toContain('openai');
  });
});

describe('GeminiProvider', () => {
  it('falls back to the official OpenAI-compatible base URL', () => {
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 1_000,
    });
    expect(provider.name).toBe('gemini');
    expect(GEMINI_OPENAI_BASE_URL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    );
  });

  it('refuses to construct without an API key', () => {
    expect(
      () =>
        new GeminiProvider({ apiKey: '', model: 'gemini-3.5-flash', timeoutMs: 1_000 }),
    ).toThrow(LLMError);
  });

  it('refuses to construct without a model', () => {
    expect(
      () => new GeminiProvider({ apiKey: 'test-key', model: '', timeoutMs: 1_000 }),
    ).toThrow(LLMError);
  });
});

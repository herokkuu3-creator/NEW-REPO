import { describe, expect, it } from 'vitest';
import { validateSolutionPostModels } from '../src/config/solutionPostModels';
import { config } from '../src/config';
import { solutionPostProviderHeaders } from '../src/config/solutionPostProvider';

describe('solution post model configuration', () => {
  it('defaults article generation to BazaarLink free Qwen without a built-in credential', () => {
    expect(config.solutionPosts.baseUrl).toBe('https://api.bazaarlink.ai/v1');
    expect(config.solutionPosts.models).toEqual(['qwen/qwen3.7-flash:free']);
    expect(config.solutionPosts.apiKeys).toEqual([]);
  });
  it('disables paid fallback for both documented BazaarLink endpoints only', () => {
    expect(solutionPostProviderHeaders('https://api.bazaarlink.ai/v1/')).toEqual({ 'X-Free-Fallback': 'false' });
    expect(solutionPostProviderHeaders('https://bazaarlink.ai/api/v1')).toEqual({ 'X-Free-Fallback': 'false' });
    expect(solutionPostProviderHeaders('https://codecraftapi.com/v1')).toEqual({});
    expect(solutionPostProviderHeaders('https://api.bazaarlink.ai.example.com/v1')).toEqual({});
  });
  it('accepts the BazaarLink namespaced free Qwen model', () => {
    expect(validateSolutionPostModels('qwen/qwen3.7-flash:free'))
      .toEqual(['qwen/qwen3.7-flash:free']);
  });

  it('keeps unrelated models outside the approved families', () => {
    expect(() => validateSolutionPostModels('anthropic/claude-opus'))
      .toThrow('SOLUTION_POST_MODELS only supports');
  });
});

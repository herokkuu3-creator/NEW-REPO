import { describe, expect, it } from 'vitest';
import { validateSolutionPostModels } from '../src/config/solutionPostModels';
import { config } from '../src/config';
import { solutionPostProviderHeaders } from '../src/config/solutionPostProvider';

describe('solution post model configuration', () => {
  it('defaults article generation to Intern-AI / Sage Inkstone models with built-in credential', () => {
    expect(config.solutionPosts.baseUrl).toBe('https://discovery-api.intern-ai.org.cn/v1');
    expect(config.solutionPosts.models).toEqual(['minimax-m3', 'deepseek-v4.1-flash-1017', 'qwen3.8-27b']);
    expect(config.solutionPosts.apiKeys).toEqual(['sk-0c521134a79c8241d29ce148c8b1f42c3bd8458dbca136601fb17dd217c4a056']);
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

  it('accepts supported Sage Inkstone models', () => {
    expect(validateSolutionPostModels('deepseek-v4.1-flash-1017,qwen3.8-27b,Sage-A1.5,intern-s2'))
      .toEqual(['deepseek-v4.1-flash-1017', 'qwen3.8-27b', 'Sage-A1.5', 'intern-s2']);
  });

  it('keeps unrelated models outside the approved families', () => {
    expect(() => validateSolutionPostModels('anthropic/claude-opus'))
      .toThrow('SOLUTION_POST_MODELS only supports');
  });
});

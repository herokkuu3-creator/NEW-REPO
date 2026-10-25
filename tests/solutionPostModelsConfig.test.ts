import { describe, expect, it } from 'vitest';
import { validateSolutionPostModels } from '../src/config/solutionPostModels';

describe('solution post model configuration', () => {
  it('accepts the BazaarLink namespaced free Qwen model', () => {
    expect(validateSolutionPostModels('qwen/qwen3.7-flash:free'))
      .toEqual(['qwen/qwen3.7-flash:free']);
  });

  it('keeps unrelated models outside the approved families', () => {
    expect(() => validateSolutionPostModels('anthropic/claude-opus'))
      .toThrow('SOLUTION_POST_MODELS only supports');
  });
});

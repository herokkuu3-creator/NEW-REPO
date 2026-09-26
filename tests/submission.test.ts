import { describe, expect, it } from 'vitest';
import { classifyStatusText } from '../src/leetcode/submission';

describe('classifyStatusText', () => {
  it('maps judge verdicts', () => {
    expect(classifyStatusText('Accepted')).toBe('ACCEPTED');
    expect(classifyStatusText('Wrong Answer')).toBe('WRONG_ANSWER');
    expect(classifyStatusText('Time Limit Exceeded')).toBe('TIME_LIMIT_EXCEEDED');
    expect(classifyStatusText('Memory Limit Exceeded')).toBe('MEMORY_LIMIT_EXCEEDED');
    expect(classifyStatusText('Compile Error')).toBe('COMPILE_ERROR');
    expect(classifyStatusText('Runtime Error')).toBe('RUNTIME_ERROR');
    expect(classifyStatusText('Output Limit Exceeded')).toBe('UNKNOWN');
  });
});

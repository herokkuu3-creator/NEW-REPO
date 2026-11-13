import { describe, expect, it } from 'vitest';
import { validateAiOutputForLanguage } from '../src/ai/codeSolver';
import { OutputValidationError } from '../src/solutionPosts/router';

describe('validateAiOutputForLanguage', () => {
  it('extracts valid solutions across C++, MySQL, Python3, and Bash', () => {
    expect(
      validateAiOutputForLanguage('```cpp\nclass Solution {\npublic:\n  int solve() { return 1; }\n};\n```', 'cpp'),
    ).toContain('class Solution');

    expect(
      validateAiOutputForLanguage('```sql\nSELECT id, name FROM Users;\n```', 'mysql'),
    ).toBe('SELECT id, name FROM Users;');

    expect(
      validateAiOutputForLanguage('```python\nclass Solution:\n    def solve(self):\n        return 1\n```', 'python3'),
    ).toContain('def solve');

    expect(
      validateAiOutputForLanguage('```bash\nawk "{print $1}" file.txt\n```', 'bash'),
    ).toContain('awk');
  });

  it('rejects empty prose, placeholders, and mismatched languages with OutputValidationError', () => {
    expect(() => validateAiOutputForLanguage('Just think about DP.', 'cpp')).toThrow(OutputValidationError);
    expect(() =>
      validateAiOutputForLanguage('```cpp\nclass Solution { public: int f() { /* TODO */ return 0; } };\n```', 'cpp'),
    ).toThrow(OutputValidationError);
    expect(() =>
      validateAiOutputForLanguage('```python\ndef solve(nums):\n    return 0\n```', 'cpp'),
    ).toThrow(OutputValidationError);
    expect(() =>
      validateAiOutputForLanguage('This is not SQL at all.', 'mysql'),
    ).toThrow(OutputValidationError);
  });
});

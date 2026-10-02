import { describe, expect, it } from 'vitest';
import { shouldRetryWithOriginal, stripCppComments } from '../src/codeforces/codeSanitizer';

describe('stripCppComments', () => {
  it('removes line and block comments while preserving strings and chars', () => {
    const source = [
      '#include <bits/stdc++.h> // trailing include comment',
      'int main() {',
      '  const char* a = "http://example.com/*not a comment*/"; // remove this',
      "  const char slash = '/'; /* remove this block */",
      '  /* block comment',
      '     spanning two lines */',
      '  std::cout << a << slash << "\\n";',
      '}',
    ].join('\\n');

    const stripped = stripCppComments(source);

    expect(stripped).not.toContain('trailing include comment');
    expect(stripped).not.toContain('remove this block');
    expect(stripped).toContain('"http://example.com/*not a comment*/"');
    expect(stripped).toContain("const char slash = '/';");
    expect(stripped.split('\\n')).toHaveLength(source.split('\\n').length);
  });

  it('does not remove comment-looking text inside C++ raw strings', () => {
    const source = 'const char* s = R"tag(\\n // this is inside the raw string\\n /* so is this */\\n)tag"; // actual comment';
    const stripped = stripCppComments(source);

    expect(stripped).toContain('// this is inside the raw string');
    expect(stripped).toContain('/* so is this */');
    expect(stripped).not.toContain('actual comment');
  });

  it('returns original text when there is no comment', () => {
    const source = 'int main() { return 0; }';
    expect(stripCppComments(source)).toBe(source);
  });
});

describe('shouldRetryWithOriginal', () => {
  it.each(['COMPILATION_ERROR', 'RUNTIME_ERROR', 'CRASHED', ' runtime_error '])(
    'retries for compiler/runtime verdict %s',
    (verdict) => {
      expect(shouldRetryWithOriginal(verdict)).toBe(true);
    },
  );

  it.each(['OK', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'PRESENTATION_ERROR', 'TESTING', null, undefined])(
    'does not retry for non-compiler/runtime verdict %s',
    (verdict) => {
      expect(shouldRetryWithOriginal(verdict)).toBe(false);
    },
  );
});

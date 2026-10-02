/**
 * Removes C++ comments without touching string literals, character literals,
 * or C++ raw string literals. Newlines inside comments are preserved so source
 * line numbers stay stable in compiler diagnostics.
 */
export function stripCppComments(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    // C++ raw string literals: R"delim(... )delim" and the u8/u/U/L variants.
    if ((i === 0 || !isIdentifierChar(source[i - 1]!)) && isRawStringPrefixAt(source, i)) {
      const raw = readRawStringEnd(source, i);
      if (raw) {
        out += source.slice(i, raw.end);
        i = raw.end;
        continue;
      }
    }

    const ch = source[i]!;
    const next = source[i + 1];

    // Line comment.
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') {
        out += ' ';
        i++;
      }
      continue;
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length) {
        const current = source[i]!;
        const following = source[i + 1];
        if (current === '*' && following === '/') {
          out += '  ';
          i += 2;
          break;
        }
        if (current === '\n' || current === '\r') {
          out += current;
        } else {
          out += ' ';
        }
        i++;
      }
      continue;
    }

    // String / character literals: comment markers inside them are code.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const current = source[i]!;
        out += current;
        i++;
        if (current === '\\' && i < source.length) {
          out += source[i]!;
          i++;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Only compiler/runtime verdicts justify trying the exact original source a
 * second time. Wrong answers are algorithmic failures, not comment failures,
 * so they must never trigger an automatic duplicate submission.
 */
export function shouldRetryWithOriginal(verdict: string | null | undefined): boolean {
  const normalized = verdict?.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (
    normalized === 'COMPILATION_ERROR' ||
    normalized === 'COMPILE_ERROR' ||
    normalized === 'RUNTIME_ERROR' ||
    normalized === 'CRASHED' ||
    normalized === 'RUNTIME_FAILURE'
  );
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isRawStringPrefixAt(source: string, index: number): boolean {
  const rest = source.slice(index);
  return /^(?:u8|u|U|L)?R"[^\\()\\s]{0,16}\(/.test(rest);
}

function readRawStringEnd(source: string, index: number): { end: number } | null {
  const match = /^(?:u8|u|U|L)?R"([^\\()\\s]{0,16})\(/.exec(source.slice(index));
  if (!match) return null;

  const prefixLength = match[0].length;
  const delimiter = match[1]!;
  const closing = ')' + delimiter + '"';
  const closeAt = source.indexOf(closing, index + prefixLength);
  if (closeAt < 0) {
    return null;
  }

  return { end: closeAt + closing.length };
}

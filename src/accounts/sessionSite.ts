export type SessionSite = 'leetcode' | 'codeforces' | 'unknown';

export function detectSessionSite(raw: string, fileName?: string): SessionSite {
  const name = (fileName ?? '').toLowerCase();
  if (/codeforces|code-force/.test(name) && !/leetcode/.test(name)) return 'codeforces';
  if (/leetcode/.test(name) && !/codeforces/.test(name)) return 'leetcode';

  const text = raw.trim();
  if (text.includes('LEETCODE_SESSION')) return 'leetcode';

  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const site = String(obj.site ?? '').toLowerCase();
      if (site === 'codeforces') return 'codeforces';
      if (site === 'leetcode') return 'leetcode';

      const origin = String(obj.origin ?? '').toLowerCase();
      if (origin.includes('codeforces.com')) return 'codeforces';
      if (origin.includes('leetcode.com')) return 'leetcode';

      const origins = Array.isArray(obj.origins) ? obj.origins : [];
      for (const entry of origins) {
        const originText = String((entry as Record<string, unknown> | null)?.origin ?? '').toLowerCase();
        if (originText.includes('codeforces.com')) return 'codeforces';
        if (originText.includes('leetcode.com')) return 'leetcode';
      }

      const cookies = Array.isArray(obj.cookies) ? obj.cookies : [];
      let cf = false;
      let lc = false;
      for (const entry of cookies) {
        const domain = String((entry as Record<string, unknown> | null)?.domain ?? '').toLowerCase();
        cf ||= domain.includes('codeforces.com');
        lc ||= domain.includes('leetcode.com');
      }
      if (cf && !lc) return 'codeforces';
      if (lc && !cf) return 'leetcode';
    } else if (Array.isArray(value)) {
      let cf = false;
      let lc = false;
      for (const entry of value) {
        const domain = String((entry as Record<string, unknown> | null)?.domain ?? '').toLowerCase();
        cf ||= domain.includes('codeforces.com');
        lc ||= domain.includes('leetcode.com');
      }
      if (cf && !lc) return 'codeforces';
      if (lc && !cf) return 'leetcode';
    }
  } catch {
    // Not JSON.
  }

  return 'unknown';
}

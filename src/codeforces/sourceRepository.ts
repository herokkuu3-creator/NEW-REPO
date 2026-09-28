import type { CodeforcesSourceFile } from './types';

export interface HttpLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export const DEFAULT_REPO = 'Saurav-Paul/Codeforces-Problem-Solution-By-Saurav-Paul';
export const DEFAULT_BRANCH = 'master';

export function parseSourceFilename(name: string) {
  const m = /^\s*(\d+)([A-Z][A-Z0-9]*)\s*-\s*(.*?)\s*\.(cpp|cc|cxx|py)\s*$/i.exec(name);
  if (!m) return null;
  return {
    contestId: Number(m[1]),
    index: m[2].toUpperCase(),
    title: m[3].trim(),
    language: m[4].toLowerCase() === 'py' ? 'python' as const : 'cpp' as const,
  };
}

export function languageFromPath(name: string): 'cpp' | 'python' | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') return 'cpp';
  if (ext === 'py') return 'python';
  return null;
}

export function problemKey(contestId: number, index: string): string {
  return \`\${contestId}\${index.toUpperCase()}\`;
}

export function compareKeys(
  a: Pick<CodeforcesSourceFile, 'contestId' | 'index'>,
  b: Pick<CodeforcesSourceFile, 'contestId' | 'index'>,
): number {
  const ac = a.contestId ?? Number.MAX_SAFE_INTEGER;
  const bc = b.contestId ?? Number.MAX_SAFE_INTEGER;
  if (ac !== bc) return ac - bc;

  const ai = a.index ?? '';
  const bi = b.index ?? '';
  const am = /^([A-Z]+)(\d*)$/i.exec(ai);
  const bm = /^([A-Z]+)(\d*)$/i.exec(bi);
  if (!am || !bm) return ai.localeCompare(bi);

  const letters = am[1].toUpperCase().localeCompare(bm[1].toUpperCase());
  if (letters !== 0) return letters;
  return Number(am[2] || 0) - Number(bm[2] || 0);
}

export async function listSourceFiles(http: HttpLike = fetch): Promise<CodeforcesSourceFile[]> {
  const response = await http(
    \`https://api.github.com/repos/\${DEFAULT_REPO}/git/trees/\${DEFAULT_BRANCH}?recursive=1\`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'leetcode-daily-agent' },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(\`solution repository tree failed: HTTP \${response.status}\`);

  const body = (await response.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
    truncated?: boolean;
  };
  if (body.truncated) throw new Error('solution repository tree was truncated');

  const result: CodeforcesSourceFile[] = [];
  for (const entry of body.tree ?? []) {
    if (entry.type !== 'blob' || !entry.path) continue;
    const name = entry.path.split('/').pop() ?? entry.path;
    const language = languageFromPath(name);
    if (!language) continue;

    const parsed = parseSourceFilename(name);
    result.push({
      path: entry.path,
      name,
      rawUrl: \`https://raw.githubusercontent.com/\${DEFAULT_REPO}/\${DEFAULT_BRANCH}/\${entry.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}\`,
      language,
      ...(parsed ? { contestId: parsed.contestId, index: parsed.index, title: parsed.title } : {}),
    });
  }

  return result.sort(compareKeys);
}

export async function fetchSourceCode(source: CodeforcesSourceFile): Promise<string> {
  const response = await fetch(source.rawUrl, {
    headers: { 'User-Agent': 'leetcode-daily-agent' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(\`source fetch failed: HTTP \${response.status}\`);
  const code = (await response.text()).replace(/^\uFEFF/, '').trim();
  if (!code) throw new Error('source file is empty');
  return code;
}

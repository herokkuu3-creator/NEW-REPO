import { problemKey } from './sourceRepository';
import type { CodeforcesProblem, CodeforcesSourceFile, ResolvedSource } from './types';

const SPECIALS: Record<string, Omit<ResolvedSource, 'source'>> = {
  '1 - Guess the Number .cpp': {
    kind: 'CODEFORCES',
    contestId: 101021,
    index: '1',
    problemName: 'Guess the Number',
    problemUrl: 'https://codeforces.com/gym/101021/problem/1',
    interactive: true,
    gym: true,
    reason: 'Verified Codeforces Gym 101021, Problem 1 (interactive).',
  },
  '11965 - Extra Spaces.cpp': {
    kind: 'NON_CODEFORCES',
    externalUrl:
      'https://onlinejudge.org/index.php?Itemid=8&category=0&option=com_onlinejudge&page=problem_stats&problemid=3116',
    reason: 'Verified UVA 11965 / Online Judge; not a Codeforces problem.',
  },
};

export function resolveSpecial(source: CodeforcesSourceFile): ResolvedSource | null {
  const result = SPECIALS[source.name];
  return result ? { source, ...result } : null;
}

export function resolveStandard(
  source: CodeforcesSourceFile,
  problems: Map<string, CodeforcesProblem>,
): ResolvedSource | null {
  if (source.contestId === undefined || !source.index) return null;
  const problem = problems.get(problemKey(source.contestId, source.index));
  if (!problem) return null;

  return {
    kind: 'CODEFORCES',
    source,
    contestId: problem.contestId,
    index: problem.index,
    problemName: problem.name,
    problemUrl: \`https://codeforces.com/contest/\${problem.contestId}/problem/\${problem.index}\`,
    interactive: problem.tags.some((tag) => /interactive/i.test(tag)),
    gym: false,
    reason: 'Resolved from Codeforces problemset API.',
  };
}

export async function discoverByTitle(source: CodeforcesSourceFile): Promise<ResolvedSource | null> {
  const query = source.name
    .replace(/\.(cpp|cc|cxx|py)$/i, '')
    .replace(/^\s*\d+\s*-\s*/i, '')
    .trim();
  if (!query) return null;

  const response = await fetch(
    \`https://codeforces.com/search?query=\${encodeURIComponent(query)}\`,
    { headers: { 'User-Agent': 'leetcode-daily-agent' }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) return null;

  const html = await response.text();
  const matches = [...html.matchAll(
    /href=["'](https?:\/\/codeforces\.com)?\/(contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )];

  for (const match of matches) {
    const type = String(match[2]).toLowerCase();
    const contestId = Number(match[3]);
    const index = String(match[4]).toUpperCase();
    const title = stripHtml(match[5] ?? '');
    if (!Number.isSafeInteger(contestId) || !title) continue;
    if (similarity(query, title) < 0.45) continue;

    return {
      kind: 'CODEFORCES',
      source,
      contestId,
      index,
      problemName: title,
      problemUrl: \`https://codeforces.com/\${type}/\${contestId}/problem/\${index}\`,
      gym: type === 'gym',
      interactive: false,
      reason: 'Resolved by Codeforces site search from source filename/title.',
    };
  }
  return null;
}

export function toProblem(resolved: ResolvedSource): CodeforcesProblem | null {
  if (resolved.kind !== 'CODEFORCES' || resolved.contestId === undefined || !resolved.index) {
    return null;
  }
  return {
    contestId: resolved.contestId,
    index: resolved.index,
    name: resolved.problemName ?? resolved.source.title ?? resolved.source.name,
    type: 'PROGRAMMING',
    tags: resolved.interactive ? ['interactive'] : [],
    gym: resolved.gym === true,
    interactive: resolved.interactive === true,
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  const left = new Set(a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
  const right = new Set(b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;

  let hit = 0;
  for (const token of left) if (right.has(token)) hit++;
  return hit / Math.max(left.size, right.size);
}

import { CodeforcesSourceKind, Prisma } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { CodeforcesProblem, fetchProblemsetProblems } from './api';

const SOURCE_OWNER = 'Saurav-Paul';
const SOURCE_REPO = 'Codeforces-Problem-Solution-By-Saurav-Paul';
const SOURCE_BRANCH = 'master';
const INDEX_CACHE_MS = 30 * 60 * 1000;

const STANDARD_RE = /^\s*(\d+)([A-Z][A-Z0-9]*)\s*-\s*(.*?)\s*\.(cpp|cc|cxx|py)\s*$/i;
const SOURCE_EXT_RE = /\.(cpp|cc|cxx|py)$/i;

export interface SourceTreeFile {
  path: string;
  sha: string;
}

export interface SourceIndexEntry {
  key: string;
  path: string;
  fileName: string;
  language: 'cpp' | 'python';
  kind: 'CODEFORCES' | 'NON_CODEFORCES' | 'UNRESOLVED';
  contestId?: number;
  problemIndex?: string;
  problemName?: string;
  problemUrl?: string;
  rawUrl: string;
  interactive: boolean;
  gym: boolean;
  reason: string;
}

export interface CodeforcesSourceIndex {
  entries: SourceIndexEntry[];
  queue: SourceIndexEntry[];
}

let cachedIndex: { at: number; value: CodeforcesSourceIndex } | undefined;

export async function loadSourceIndex(force = false): Promise<CodeforcesSourceIndex> {
  if (!force && cachedIndex && Date.now() - cachedIndex.at < INDEX_CACHE_MS) {
    return cachedIndex.value;
  }

  const [treeFiles, problems] = await Promise.all([fetchSourceTree(), fetchProblemsetProblems()]);
  const value = buildSourceIndex(treeFiles, problems);
  await persistAudit(value.entries);
  cachedIndex = { at: Date.now(), value };

  logger.info(
    {
      total: value.entries.length,
      queue: value.queue.length,
      nonCodeforces: value.entries.filter((e) => e.kind === 'NON_CODEFORCES').length,
      unresolved: value.entries.filter((e) => e.kind === 'UNRESOLVED').length,
    },
    'Codeforces source index built',
  );
  return value;
}

export async function fetchSourceCode(entry: SourceIndexEntry): Promise<string> {
  const response = await fetch(entry.rawUrl, {
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`source repository fetch failed: HTTP ${response.status} for ${entry.path}`);
  }
  return response.text();
}

export function buildSourceIndex(files: SourceTreeFile[], problems: CodeforcesProblem[]): CodeforcesSourceIndex {
  const byKey = new Map<string, CodeforcesProblem>();
  const byTitle = new Map<string, CodeforcesProblem[]>();

  for (const problem of problems) {
    if (problem.contestId === undefined) continue;
    byKey.set(`${problem.contestId}/${problem.index}`, problem);
    const title = normalizeTitle(problem.name);
    const list = byTitle.get(title) ?? [];
    list.push(problem);
    byTitle.set(title, list);
  }

  const entries: SourceIndexEntry[] = [];

  for (const file of files) {
    const fileName = file.path.split('/').pop() ?? file.path;
    if (!SOURCE_EXT_RE.test(fileName)) continue;

    const language = /\.py$/i.test(fileName) ? 'python' : 'cpp';
    const rawUrl = `https://raw.githubusercontent.com/${SOURCE_OWNER}/${SOURCE_REPO}/${SOURCE_BRANCH}/${encodePath(file.path)}`;

    if (fileName === '1 - Guess the Number .cpp') {
      entries.push({
        key: file.path,
        path: file.path,
        fileName,
        language,
        kind: 'CODEFORCES',
        contestId: 101021,
        problemIndex: '1',
        problemName: 'Guess the Number',
        problemUrl: 'https://codeforces.com/gym/101021/problem/1',
        rawUrl,
        interactive: true,
        gym: true,
        reason: 'verified Codeforces Gym 101021 problem 1',
      });
      continue;
    }

    if (fileName === '11965 - Extra Spaces.cpp') {
      entries.push({
        key: file.path,
        path: file.path,
        fileName,
        language,
        kind: 'NON_CODEFORCES',
        problemUrl: 'https://onlinejudge.org/index.php?Itemid=8&category=0&option=com_onlinejudge&page=problem_stats&problemid=3116',
        rawUrl,
        interactive: false,
        gym: false,
        reason: 'verified UVA/Online Judge problem 11965, not a Codeforces problem',
      });
      continue;
    }

    const standard = STANDARD_RE.exec(fileName);
    if (standard) {
      const contestId = Number(standard[1]);
      const problemIndex = standard[2]!.toUpperCase();
      const title = standard[3]!.trim();
      const found = byKey.get(`${contestId}/${problemIndex}`);
      if (found) {
        entries.push(makeResolvedEntry(file, fileName, language, rawUrl, found, false, false, `matched filename key ${contestId}/${problemIndex}`));
        continue;
      }

      const byTitleMatches = byTitle.get(normalizeTitle(title)) ?? [];
      const unique = byTitleMatches.length === 1 ? byTitleMatches[0] : undefined;
      if (unique) {
        entries.push(makeResolvedEntry(file, fileName, language, rawUrl, unique, false, false, `filename key missing from problemset; unique title match resolved to ${unique.contestId}/${unique.index}`));
      } else {
        entries.push({
          key: file.path,
          path: file.path,
          fileName,
          language,
          kind: 'UNRESOLVED',
          rawUrl,
          interactive: false,
          gym: false,
          reason: `filename key ${contestId}/${problemIndex} not found in current Codeforces problemset`,
        });
      }
      continue;
    }

    const strippedTitle = normalizeTitle(fileName.replace(/\.(cpp|cc|cxx|py)$/i, ''));
    const titleMatches = byTitle.get(strippedTitle) ?? [];
    if (titleMatches.length === 1) {
      const found = titleMatches[0]!;
      entries.push(makeResolvedEntry(file, fileName, language, rawUrl, found, false, false, `unique title match resolved to ${found.contestId}/${found.index}`));
    } else {
      entries.push({
        key: file.path,
        path: file.path,
        fileName,
        language,
        kind: 'UNRESOLVED',
        rawUrl,
        interactive: false,
        gym: false,
        reason: titleMatches.length === 0
          ? 'filename has no verifiable Codeforces contest/index and no unique problem-title match'
          : 'filename matched multiple Codeforces problem titles; automatic submission would be ambiguous',
      });
    }
  }

  const queue = entries
    .filter((entry): entry is SourceIndexEntry & { contestId: number; problemIndex: string } =>
      entry.kind === 'CODEFORCES' && entry.contestId !== undefined && !!entry.problemIndex,
    )
    .sort((a, b) => {
      if (a.contestId !== b.contestId) return a.contestId - b.contestId;
      const byIndex = compareProblemIndex(a.problemIndex, b.problemIndex);
      return byIndex !== 0 ? byIndex : a.path.localeCompare(b.path);
    });

  return { entries, queue };
}

async function fetchSourceTree(): Promise<SourceTreeFile[]> {
  const url = `https://api.github.com/repos/${SOURCE_OWNER}/${SOURCE_REPO}/git/trees/${SOURCE_BRANCH}?recursive=1`;
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`source repository tree fetch failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    truncated?: boolean;
    tree?: Array<{ type?: string; path?: string; sha?: string }>;
  };
  if (body.truncated) throw new Error('source repository tree is truncated; refusing to build a partial Codeforces queue');
  return (body.tree ?? [])
    .filter((e): e is { type: 'blob'; path: string; sha: string } => e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string')
    .map((e) => ({ path: e.path, sha: e.sha }));
}

function makeResolvedEntry(
  file: SourceTreeFile,
  fileName: string,
  language: 'cpp' | 'python',
  rawUrl: string,
  problem: CodeforcesProblem,
  interactive: boolean,
  gym: boolean,
  reason: string,
): SourceIndexEntry {
  return {
    key: file.path,
    path: file.path,
    fileName,
    language,
    kind: 'CODEFORCES',
    contestId: problem.contestId,
    problemIndex: problem.index,
    problemName: problem.name,
    problemUrl: problem.contestId !== undefined
      ? `https://codeforces.com/contest/${problem.contestId}/problem/${problem.index}`
      : undefined,
    rawUrl,
    interactive,
    gym,
    reason,
  };
}

async function persistAudit(entries: SourceIndexEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows: Prisma.CodeforcesSourceAuditCreateManyInput[] = entries.map((entry) => ({
    path: entry.path,
    fileName: entry.fileName,
    language: entry.language,
    kind: entry.kind as CodeforcesSourceKind,
    contestId: entry.contestId,
    problemIndex: entry.problemIndex,
    problemUrl: entry.problemUrl,
    externalUrl: entry.kind === 'NON_CODEFORCES' ? entry.problemUrl : undefined,
    interactive: entry.interactive,
    gym: entry.gym,
    reason: entry.reason,
  }));
  await prisma.codeforcesSourceAudit.createMany({ data: rows, skipDuplicates: true });
}

function compareProblemIndex(a: string, b: string): number {
  const pa = splitIndex(a);
  const pb = splitIndex(b);
  const rank = (s: string) => /^(?:A|B|C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z)$/.test(s) ? 0 : 1;
  const ra = rank(pa.letter);
  const rb = rank(pb.letter);
  if (ra !== rb) return ra - rb;
  const letter = pa.letter.localeCompare(pb.letter);
  if (letter !== 0) return letter;
  return pa.number - pb.number;
}

function splitIndex(index: string): { letter: string; number: number } {
  const match = /^([A-Z]+)(\d*)$/i.exec(index.trim());
  if (!match) return { letter: index.toUpperCase(), number: 0 };
  return { letter: match[1]!.toUpperCase(), number: match[2] ? Number(match[2]) : 0 };
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\s*[a-z](?:\d+)?\s*[.)-]\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

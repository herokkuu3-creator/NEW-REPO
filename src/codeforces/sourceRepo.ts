import { gunzipSync } from 'node:zlib';
import { CodeforcesSourceKind, Prisma } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { CodeforcesProblem, fetchProblemsetProblems } from './api';

const SOURCE_OWNER = 'Saurav-Paul';
const SOURCE_REPO = 'Codeforces-Problem-Solution-By-Saurav-Paul';
const SOURCE_BRANCH = 'master';
const SOURCE_TARBALL_URL = `https://codeload.github.com/${SOURCE_OWNER}/${SOURCE_REPO}/tar.gz/refs/heads/${SOURCE_BRANCH}`;
const SOURCE_TOKEN_ENVS = ['GITHUB_TOKEN', 'GH_TOKEN', 'SOURCE_REPO_TOKEN'] as const;
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
  const token = SOURCE_TOKEN_ENVS.map((key) => process.env[key]?.trim()).find((value) => !!value);
  const routes: Array<{ label: string; run: () => Promise<SourceTreeFile[]> }> = [];
  if (token) routes.push({ label: 'GitHub API (token)', run: () => fetchSourceTreeViaApi(token) });
  routes.push({ label: 'codeload tarball', run: fetchSourceTreeViaTarball });
  if (!token) routes.push({ label: 'GitHub API (anonymous)', run: () => fetchSourceTreeViaApi() });

  const failures: string[] = [];
  for (const route of routes) {
    try {
      const files = await route.run();
      if (files.length === 0) throw new Error('the source archive contained no files');
      logger.info({ route: route.label, files: files.length }, 'Codeforces source tree resolved');
      return files;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${route.label}: ${message}`);
      logger.warn({ err: message, route: route.label }, 'Codeforces source tree route failed');
    }
  }
  throw new Error(`source repository tree fetch failed — ${failures.join('; ')}`);
}

async function fetchSourceTreeViaApi(token?: string): Promise<SourceTreeFile[]> {
  const url = `https://api.github.com/repos/${SOURCE_OWNER}/${SOURCE_REPO}/git/trees/${SOURCE_BRANCH}?recursive=1`;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const quota = response.status === 403 && !token
      ? ' - the anonymous GitHub API quota is 60 requests/hour and is shared by every service behind this host IP; set GITHUB_TOKEN to raise it to 5000/hour'
      : '';
    throw new Error(`GitHub API returned HTTP ${response.status}${quota}`);
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

async function fetchSourceTreeViaTarball(): Promise<SourceTreeFile[]> {
  const response = await fetch(SOURCE_TARBALL_URL, {
    headers: { accept: 'application/gzip, application/octet-stream' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`codeload tarball returned HTTP ${response.status}`);
  const gzipped = Buffer.from(await response.arrayBuffer());

  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped);
  } catch (err) {
    throw new Error(`could not decompress the source archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files = treeFromTarball(tar);
  if (files.length === 0) throw new Error('the source archive contained no files');
  return files;
}

/**
 * Exported for tests. Walks the tar stream and returns the flat file list with
 * the archive's top-level folder stripped, so paths match what the GitHub API
 * returns for the same branch.
 */
export function treeFromTarball(tar: Buffer): SourceTreeFile[] {
  const root = `${SOURCE_REPO}-${SOURCE_BRANCH}/`;
  const files: SourceTreeFile[] = [];
  let offset = 0;
  let longName: string | undefined;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12) || '0', 8);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + (Number.isFinite(size) ? size : 0);
    offset = dataStart + (size > 0 ? Math.ceil(size / 512) * 512 : 0);

    if (typeFlag === 'L') {
      longName = tar.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '');
      continue;
    }

    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (typeFlag !== '0' && typeFlag !== '\0') continue;
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    if (!relative) continue;
    files.push({ path: relative, sha: '' });
  }
  return files;
}

function readTarString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return header.toString('utf8', start, stop).trim();
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

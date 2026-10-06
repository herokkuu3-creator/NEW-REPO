import fs from 'node:fs/promises';
import path from 'node:path';
import { CodeChefSourceKind } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { getSystemState, setSystemState } from '../database/models';

export interface CodeChefSourceEntry {
  path: string;
  fileName: string;
  language: string;
  kind: 'CODECHEF' | 'UNRESOLVED';
  problemCode?: string;
  problemUrl?: string;
  reason: string;
}

export const RETIRED_OR_INVALID_CODECHEF_PROBLEMS = new Set([
  'SCHOOL', 'ATTND', 'HMAPPY2', 'TWOSTR', 'SUBINC', 'RECIPE', 'COPS',
  'CFRTEST', 'FLOW016', 'LUCKFOUR', 'MATCHES', 'SIMPSTAT', 'ALPHABET',
  'SNAKPROC', 'TWODISH', 'SMPAIR', 'VCS', 'MAGDOORS', 'CHEFWORK',
  'VACCINQ', 'SPCTRIPS', 'PRIGAME', 'TANDJ1', 'VDATES', 'CSUB',
  'CARVANS', 'COLGLF2', 'PTMSSNG', 'STACKS', 'WEIGHTBL', 'ADAKNG',
]);

const SOLUTIONS_DIR = path.join(process.cwd(), 'codechef-solutions');

export async function loadCodeChefSourceIndex(force = false): Promise<CodeChefSourceEntry[]> {
  const readRows = () =>
    prisma.codeChefSourceAudit.findMany({
      where: {
        kind: CodeChefSourceKind.CODECHEF,
        problemCode: { not: null },
      },
      select: {
        path: true,
        fileName: true,
        language: true,
        problemCode: true,
        problemUrl: true,
        reason: true,
      },
    });

  let rows = await readRows();

  if (rows.length === 0 || force || await getSystemState('codechef.source-index-version') !== '3') {
    logger.info('Building CodeChef source index from local files...');
    const entries = await buildLocalIndex();
    await persistAudit(entries);
    await setSystemState('codechef.source-index-version', '3');
    rows = await readRows();
  }

  const sorted: CodeChefSourceEntry[] = rows.map((row) => ({
    path: row.path,
    fileName: row.fileName,
    language: row.language,
    kind: 'CODECHEF' as const,
    problemCode: row.problemCode!,
    problemUrl: row.problemUrl ?? undefined,
    reason: row.reason,
  })).sort((a, b) => a.problemCode!.localeCompare(b.problemCode!));
  const seen = new Set<string>();
  const queue = sorted.filter(entry => {
    if (RETIRED_OR_INVALID_CODECHEF_PROBLEMS.has(entry.problemCode!)) return false;
    if (seen.has(entry.problemCode!)) return false;
    seen.add(entry.problemCode!);
    return true;
  });

  logger.info({ queue: queue.length }, 'CodeChef source queue loaded');
  return queue;
}

export async function fetchSourceCode(entry: CodeChefSourceEntry): Promise<string> {
  const fullPath = path.resolve(SOLUTIONS_DIR, entry.path.replace(/[\\/]/g, path.sep));
  const relative = path.relative(SOLUTIONS_DIR, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CodeChef source path is outside the solution directory');
  return fs.readFile(fullPath, 'utf8');
}

export async function buildLocalIndex(root = SOLUTIONS_DIR): Promise<CodeChefSourceEntry[]> {
  const entries: CodeChefSourceEntry[] = [];
  
  async function walk(dir: string) {
    try {
      const files = await fs.readdir(dir, { withFileTypes: true });
      for (const file of files) {
        if (file.name === '.git') continue;
        const res = path.join(dir, file.name);
        if (file.isDirectory()) {
          await walk(res);
        } else if (file.name.toLowerCase() === 'readme.md') {
          if (path.resolve(dir) === path.resolve(root)) continue;
          // Check if there is a cpp file in this directory
          const dirFiles = await fs.readdir(dir);
          const cppFile = dirFiles.sort().find(f => f.toLowerCase().endsWith('.cpp'));
          if (cppFile) {
            const readmeContent = await fs.readFile(res, 'utf8');
            const match = readmeContent.match(/https?:\/\/(?:www\.)?codechef\.com\/(?:[A-Za-z0-9_-]+\/)?problems\/([A-Za-z0-9_]+)/i);
            const relativePath = path.relative(root, path.join(dir, cppFile)).split(path.sep).join('/');
            
            if (match && match[1]) {
              const code = match[1].toUpperCase();
              if (RETIRED_OR_INVALID_CODECHEF_PROBLEMS.has(code)) {
                entries.push({
                  path: relativePath,
                  fileName: cppFile,
                  language: 'cpp',
                  kind: 'UNRESOLVED' as const,
                  reason: `Problem ${code} retired or no longer in CodeChef Practice`,
                });
              } else {
                entries.push({
                  path: relativePath,
                  fileName: cppFile,
                  language: 'cpp',
                  kind: 'CODECHEF' as const,
                  problemCode: code,
                  problemUrl: `https://www.codechef.com/problems/${code}`,
                  reason: 'Resolved from local directory readme.md',
                });
              }
            } else {
              entries.push({
                path: relativePath,
                fileName: cppFile,
                language: 'cpp',
                kind: 'UNRESOLVED' as const,
                reason: 'No valid CodeChef URL found in readme.md',
              });
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), dir }, 'Failed to walk directory');
    }
  }

  await walk(root);
  return entries;
}

async function persistAudit(entries: CodeChefSourceEntry[]): Promise<void> {
  if (entries.length === 0) throw new Error('No CodeChef C++ solutions with README files were found in the deployed solution directory');
  const rows = entries.map((entry) => ({
    path: entry.path,
    fileName: entry.fileName,
    language: entry.language,
    kind: entry.kind as CodeChefSourceKind,
    problemCode: entry.problemCode,
    problemUrl: entry.problemUrl,
    reason: entry.reason,
  }));
  // This table is a derived file index; rebuild atomically without touching progress.
  await prisma.$transaction([
    prisma.codeChefSourceAudit.deleteMany(),
    prisma.codeChefSourceAudit.createMany({ data: rows, skipDuplicates: true }),
  ]);
}

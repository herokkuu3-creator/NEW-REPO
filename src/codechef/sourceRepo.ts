import fs from 'node:fs/promises';
import path from 'node:path';
import { CodeChefSourceKind } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../database/prisma';

export interface CodeChefSourceEntry {
  path: string;
  fileName: string;
  language: string;
  kind: 'CODECHEF' | 'UNRESOLVED';
  problemCode?: string;
  problemUrl?: string;
  reason: string;
}

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

  if (rows.length === 0 || force) {
    logger.info('Building CodeChef source index from local files...');
    const entries = await buildLocalIndex();
    await persistAudit(entries);
    rows = await readRows();
  }

  const queue: CodeChefSourceEntry[] = rows.map((row) => ({
    path: row.path,
    fileName: row.fileName,
    language: row.language,
    kind: 'CODECHEF' as const,
    problemCode: row.problemCode!,
    problemUrl: row.problemUrl ?? undefined,
    reason: row.reason,
  })).sort((a, b) => a.problemCode!.localeCompare(b.problemCode!));

  logger.info({ queue: queue.length }, 'CodeChef source queue loaded');
  return queue;
}

export async function fetchSourceCode(entry: CodeChefSourceEntry): Promise<string> {
  const fullPath = path.join(SOLUTIONS_DIR, entry.path);
  return fs.readFile(fullPath, 'utf8');
}

async function buildLocalIndex(): Promise<CodeChefSourceEntry[]> {
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
          // Check if there is a cpp file in this directory
          const dirFiles = await fs.readdir(dir);
          const cppFile = dirFiles.find(f => f.endsWith('.cpp'));
          if (cppFile) {
            const readmeContent = await fs.readFile(res, 'utf8');
            const match = readmeContent.match(/https?:\/\/(?:www\.)?codechef\.com\/problems\/([A-Za-z0-9_]+)/i);
            const relativePath = path.relative(SOLUTIONS_DIR, path.join(dir, cppFile));
            
            if (match && match[1]) {
              entries.push({
                path: relativePath,
                fileName: cppFile,
                language: 'cpp',
                kind: 'CODECHEF' as const,
                problemCode: match[1],
                problemUrl: match[0],
                reason: 'Resolved from local directory readme.md',
              });
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

  await walk(SOLUTIONS_DIR);
  return entries;
}

async function persistAudit(entries: CodeChefSourceEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((entry) => ({
    path: entry.path,
    fileName: entry.fileName,
    language: entry.language,
    kind: entry.kind as CodeChefSourceKind,
    problemCode: entry.problemCode,
    problemUrl: entry.problemUrl,
    reason: entry.reason,
  }));
  await prisma.codeChefSourceAudit.createMany({ data: rows, skipDuplicates: true });
}

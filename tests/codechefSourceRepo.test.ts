import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLocalIndex, fetchSourceCode } from '../src/codechef/sourceRepo';

vi.mock('../src/database/prisma', () => ({ prisma: {} }));
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codechef-index-'));
  for (const [folder, link] of [['direct', 'https://www.codechef.com/problems/START01'], ['contest', 'https://www.codechef.com/OCT21C/problems/THREEBOX/']]) {
    const directory = path.join(root, folder!);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'README.md'), `# Problem\n${link}`);
    await fs.writeFile(path.join(directory, 'Solution.CPP'), 'int main(){}');
  }
});
afterAll(async () => {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codechef-index-')) await fs.rm(root, { recursive: true });
});
describe('CodeChef solution index', () => {
  it('recognizes direct and contest problem links and normalizes stored paths', async () => {
    const entries = await buildLocalIndex(root);
    expect(entries.map(entry => entry.problemCode).sort()).toEqual(['START01', 'THREEBOX']);
    expect(entries.every(entry => !entry.path.includes('\\'))).toBe(true);
    expect(entries.find(entry => entry.problemCode === 'THREEBOX')?.problemUrl).toBe('https://www.codechef.com/problems/THREEBOX');
  });
  it('rejects source paths that escape the shipped solution directory', async () => {
    await expect(fetchSourceCode({ path: '../../package.json', fileName: '', language: 'cpp', kind: 'CODECHEF', reason: '' })).rejects.toThrow('outside');
  });
  it('marks known retired problems as UNRESOLVED so they are not queued', async () => {
    const retiredDir = path.join(root, 'retired');
    await fs.mkdir(retiredDir);
    await fs.writeFile(path.join(retiredDir, 'README.md'), '# Problem\nhttps://www.codechef.com/problems/FLOW016');
    await fs.writeFile(path.join(retiredDir, 'solution.cpp'), 'int main(){}');
    const entries = await buildLocalIndex(root);
    const flow = entries.find(e => e.path.includes('FLOW016') || e.path.includes('retired'));
    expect(flow?.kind).toBe('UNRESOLVED');
  });
});

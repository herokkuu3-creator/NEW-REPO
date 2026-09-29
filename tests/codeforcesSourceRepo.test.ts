import { describe, expect, it } from 'vitest';
import { buildSourceIndex, treeFromTarball } from '../src/codeforces/sourceRepo';

/**
 * The Codeforces queue is built from the solution repository's archive. These
 * tests cover the offline parts: tar extraction (which replaces the anonymous
 * GitHub API call that returns HTTP 403 on shared host IPs) and the filename to
 * problem resolution rules.
 */

const ROOT = 'Codeforces-Problem-Solution-By-Saurav-Paul-master/';

function tarEntry(path: string, content: string, typeFlag = '0'): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('000644 ', 100, 8, 'utf8');
  header.write('000000 ', 108, 8, 'utf8');
  header.write('000000 ', 116, 8, 'utf8');
  header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
  header.write('00000000000 ', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeFlag, 156, 1, 'utf8');
  header.write('ustar  ', 257, 8, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function makeTar(entries: Array<[string, string, string?]>): Buffer {
  const blocks = entries.map(([path, content, typeFlag]) => tarEntry(path, content, typeFlag));
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

type ProblemsArg = Parameters<typeof buildSourceIndex>[1];
const PROBLEMS = [
  { contestId: 1005, index: 'B', name: 'Delete from the Left' },
  { contestId: 1006, index: 'A', name: 'Adjacent Replacements' },
] as unknown as ProblemsArg;

describe('treeFromTarball', () => {
  it('lists files with the archive root folder stripped', () => {
    const tar = makeTar([
      [`${ROOT}1005B - Delete from the Left.cpp`, '#include<bits/stdc++.h>\n'],
      [`${ROOT}nested/1006A - Adjacent Replacements.cpp`, 'int main(){}\n'],
    ]);
    expect(treeFromTarball(tar).map((f) => f.path)).toEqual([
      '1005B - Delete from the Left.cpp',
      'nested/1006A - Adjacent Replacements.cpp',
    ]);
  });

  it('skips directory entries and files outside the repository root', () => {
    const tar = makeTar([
      [`${ROOT}subdir/`, '', '5'],
      [`${ROOT}1005B - Delete from the Left.cpp`, 'a'],
      ['outside.cpp', 'b'],
      [`${ROOT}`, '', '5'],
    ]);
    expect(treeFromTarball(tar).map((f) => f.path)).toEqual(['1005B - Delete from the Left.cpp']);
  });

  it('returns nothing for an empty or truncated archive', () => {
    expect(treeFromTarball(Buffer.alloc(0))).toEqual([]);
    expect(treeFromTarball(Buffer.alloc(1024))).toEqual([]);
  });
});

describe('buildSourceIndex', () => {
  it('queues a file whose contest id and index exist in the problemset', () => {
    const index = buildSourceIndex([{ path: '1005B - Delete from the Left.cpp', sha: '' }], PROBLEMS);
    expect(index.entries).toHaveLength(1);
    expect(index.queue).toHaveLength(1);
    expect(index.queue[0]).toMatchObject({
      kind: 'CODEFORCES',
      contestId: 1005,
      problemIndex: 'B',
      problemName: 'Delete from the Left',
      problemUrl: 'https://codeforces.com/contest/1005/problem/B',
    });
  });

  it('never queues an unresolvable filename', () => {
    const index = buildSourceIndex([{ path: '9999Z - Nonexistent Problem.cpp', sha: '' }], PROBLEMS);
    expect(index.entries[0]?.kind).toBe('UNRESOLVED');
    expect(index.queue).toHaveLength(0);
  });

  it('never queues the known non-Codeforces file', () => {
    const index = buildSourceIndex([{ path: '11965 - Extra Spaces.cpp', sha: '' }], PROBLEMS);
    expect(index.entries[0]?.kind).toBe('NON_CODEFORCES');
    expect(index.queue).toHaveLength(0);
  });

  it('resolves a filename with no standard prefix through a unique title match', () => {
    const index = buildSourceIndex([{ path: 'Delete from the Left.cpp', sha: '' }], PROBLEMS);
    expect(index.queue).toHaveLength(1);
    expect(index.queue[0]?.contestId).toBe(1005);
  });
});

export interface CodeforcesProblem {
  contestId: number;
  index: string;
  name: string;
  type: string;
  tags: string[];
  rating?: number;
}

export interface CodeforcesSourceFile {
  path: string;
  name: string;
  rawUrl: string;
  contestId: number;
  index: string;
  title: string;
}

export interface CodeforcesQueueItem {
  key: string;
  source: CodeforcesSourceFile;
  problem: CodeforcesProblem;
  problemUrl: string;
  sourceUrl: string;
}

export type CodeforcesSourceKind = 'CODEFORCES' | 'NON_CODEFORCES' | 'UNRESOLVED';

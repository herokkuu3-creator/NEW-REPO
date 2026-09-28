export type CodeforcesSourceKind = 'CODEFORCES' | 'NON_CODEFORCES' | 'UNRESOLVED';

export interface CodeforcesProblem {
  contestId: number;
  index: string;
  name: string;
  type: string;
  tags: string[];
  rating?: number;
  gym?: boolean;
  interactive?: boolean;
}

export interface CodeforcesSourceFile {
  path: string;
  name: string;
  rawUrl: string;
  language: 'cpp' | 'python';
  contestId?: number;
  index?: string;
  title?: string;
}

export interface ResolvedSource {
  kind: CodeforcesSourceKind;
  source: CodeforcesSourceFile;
  contestId?: number;
  index?: string;
  problemName?: string;
  problemUrl?: string;
  externalUrl?: string;
  interactive?: boolean;
  gym?: boolean;
  reason?: string;
}

export interface CodeforcesQueueItem {
  key: string;
  source: CodeforcesSourceFile;
  problem: CodeforcesProblem;
  problemUrl: string;
  sourceUrl: string;
}

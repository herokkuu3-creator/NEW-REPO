export type CodeforcesSourceKind = 'CODEFORCES' | 'NON_CODEFORCES' | 'UNRESOLVED';
export type CodeforcesLanguage = 'cpp' | 'python';

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

export interface SourceFile {
  path: string;
  name: string;
  rawUrl: string;
  language: CodeforcesLanguage | null;
  contestId?: number;
  index?: string;
  title?: string;
}

export interface ResolvedSource {
  kind: CodeforcesSourceKind;
  source: SourceFile;
  contestId?: number;
  index?: string;
  problemName?: string;
  problemUrl?: string;
  externalUrl?: string;
  reason?: string;
  interactive?: boolean;
  gym?: boolean;
}

export interface QueueItem {
  key: string;
  source: SourceFile;
  problem: CodeforcesProblem;
  problemUrl: string;
  sourceUrl: string;
  code?: string;
}

export interface CodeforcesCursorState {
  nextKey: string | null;
  lastCompletedKey: string | null;
  lastAttemptDate: string | null;
  lastAttemptKey: string | null;
  lastSubmissionId: string | null;
  lastVerdict: string | null;
}

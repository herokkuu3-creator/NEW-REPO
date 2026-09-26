/**
 * Local code-execution runners. Each runner wraps a candidate solution in a
 * language-specific harness, executes it in a child process with a hard
 * timeout, and reports per-testcase results. Runners NEVER execute with
 * network access requirements — they run plain stdin/stdout programs.
 */

export interface TestCase {
  /** Arguments as stringified JSON values, in the order the function takes them */
  args: string[];
  /** Expected return value as stringified JSON (null = not checked, compile-only) */
  expected: string | null;
  label: string;
}

export interface TestResult {
  label: string;
  passed: boolean;
  actual?: string;
  expected?: string | null;
  error?: string;
  durationMs: number;
}

export interface RunReport {
  ok: boolean;
  results: TestResult[];
  stderr?: string;
}

export interface CodeRunner {
  readonly language: string;
  /** Compile/parse check only — fast rejection of broken code. */
  checkSyntax(code: string): Promise<{ ok: boolean; error?: string }>;
  /** Execute the solution against testcases. */
  run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport>;
}

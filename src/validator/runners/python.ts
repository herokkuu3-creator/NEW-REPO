import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodeRunner, RunReport, TestCase, TestResult } from './types';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

/**
 * Python3 runner. Requires python3 on PATH (present in the Docker image and
 * most dev machines; the validator degrades to syntax-only checks without
 * it — see validator.ts).
 */
export class PythonRunner implements CodeRunner {
  readonly language = 'python3';

  async checkSyntax(code: string): Promise<{ ok: boolean; error?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pysyntax-'));
    try {
      const file = path.join(dir, 'check.py');
      fs.writeFileSync(file, code);
      await execFileAsync('python3', ['-m', 'py_compile', file], { timeout: TIMEOUT_MS });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pyrun-'));
    try {
      fs.writeFileSync(path.join(dir, 'harness.py'), buildHarness(code, functionName, tests));
      const { stdout, stderr } = await execFileAsync(
        'python3',
        [path.join(dir, 'harness.py')],
        { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );

      const results: TestResult[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          results.push(JSON.parse(line) as TestResult);
        } catch {
          // ignore non-JSON prints from the solution
        }
      }
      const ok = results.length === tests.length && results.every((r) => r.passed);
      return { ok, results, stderr: stderr?.slice(0, 2000) || undefined };
    } catch (err) {
      return {
        ok: false,
        results: [],
        stderr: err instanceof Error ? err.message.slice(0, 2000) : String(err),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function buildHarness(code: string, functionName: string, tests: TestCase[]): string {
  return `import json, time

${code}

__tests = json.loads(${JSON.stringify(JSON.stringify(tests))})
__fn_name = ${JSON.stringify(functionName)}

def __resolve():
    if 'Solution' in dir():
        s = Solution()
        fn = getattr(s, __fn_name, None)
        if callable(fn):
            return fn
    fn = globals().get(__fn_name)
    if callable(fn):
        return fn
    raise RuntimeError('could not resolve callable: ' + __fn_name)

def __norm(v):
    if isinstance(v, (list, tuple)):
        return [__norm(x) for x in v]
    return v

for t in __tests:
    started = time.time()
    try:
        fn = __resolve()
        args = [json.loads(a) for a in t['args']]
        actual = fn(*args)
        actual_str = json.dumps(__norm(actual))
        passed = True
        if t['expected'] is not None:
            passed = __norm(actual) == __norm(json.loads(t['expected']))
        print(json.dumps({
            'label': t['label'], 'passed': bool(passed),
            'actual': actual_str, 'expected': t['expected'],
            'durationMs': int((time.time() - started) * 1000),
        }))
    except Exception as e:
        print(json.dumps({
            'label': t['label'], 'passed': False,
            'error': str(e)[:500],
            'durationMs': int((time.time() - started) * 1000),
        }))
`;
}

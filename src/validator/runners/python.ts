import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodeRunner, RunReport, TestCase, TestResult } from './types';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

export function resolvePython3Command(candidates: readonly string[] = ['python3', 'python']): string {
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (!res.error && res.status === 0 && /\bPython\s+3\./i.test(`${res.stdout ?? ''}\n${res.stderr ?? ''}`)) {
      return cmd;
    }
  }
  throw new Error('no working python3 interpreter found on PATH');
}

/**
 * Python3 runner. Resolves python3 or python on PATH at construction time and
 * throws if no working Python 3 interpreter is available so validator.ts
 * degrades gracefully instead of misreporting ENOENT as a syntax error.
 */
export class PythonRunner implements CodeRunner {
  readonly language = 'python3';
  private readonly pythonBin: string;

  constructor(pythonCmd?: string) {
    this.pythonBin = pythonCmd ?? resolvePython3Command();
  }

  async checkSyntax(code: string): Promise<{ ok: boolean; error?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pysyntax-'));
    try {
      const file = path.join(dir, 'check.py');
      fs.writeFileSync(file, code);
      await execFileAsync(this.pythonBin, ['-m', 'py_compile', file], { timeout: TIMEOUT_MS });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err) };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp directory cleanup
      }
    }
  }

  async run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pyrun-'));
    try {
      fs.writeFileSync(path.join(dir, 'harness.py'), buildHarness(code, functionName, tests));
      const { stdout, stderr } = await execFileAsync(
        this.pythonBin,
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
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp directory cleanup
      }
    }
  }
}

function buildHarness(code: string, functionName: string, tests: TestCase[]): string {
  return `import json, time
from typing import *
import collections, math, heapq, bisect, itertools, functools

${code}

__tests = json.loads(${JSON.stringify(JSON.stringify(tests))})
__fn_name = ${JSON.stringify(functionName)}

def __resolve():
    sol_cls = globals().get('Solution')
    if sol_cls is not None:
        s = sol_cls()
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
    if isinstance(v, dict):
        return {k: __norm(val) for k, val in sorted(v.items(), key=lambda kv: str(kv[0]))}
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

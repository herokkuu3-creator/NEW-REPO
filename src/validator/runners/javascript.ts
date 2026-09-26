import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodeRunner, RunReport, TestCase, TestResult } from './types';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

/**
 * JavaScript runner: executes the candidate inside a Node child process.
 *
 * Harness strategy: the candidate source defines the solution (class
 * `Solution` with a method, or a top-level `var fn = function(...)`). The
 * harness resolves the callable, feeds it JSON-parsed arguments, and prints
 * one JSON line per testcase.
 */
export class JavaScriptRunner implements CodeRunner {
  readonly language = 'javascript';

  async checkSyntax(code: string): Promise<{ ok: boolean; error?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-syntax-'));
    try {
      const file = path.join(dir, 'check.js');
      fs.writeFileSync(file, code);
      await execFileAsync(process.execPath, ['--check', file], { timeout: TIMEOUT_MS });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-run-'));
    try {
      const harness = buildHarness(code, functionName, tests);
      const file = path.join(dir, 'harness.js');
      fs.writeFileSync(file, harness);

      const { stdout, stderr } = await execFileAsync(process.execPath, [file], {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      const results: TestResult[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          results.push(JSON.parse(line) as TestResult);
        } catch {
          // Non-JSON output (e.g. stray console.log in the solution) — ignore.
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

/**
 * The harness is generated code, serialized with JSON.stringify so testcase
 * data can never break out of its string context.
 */
function buildHarness(code: string, functionName: string, tests: TestCase[]): string {
  return `'use strict';
const __tests = ${JSON.stringify(tests)};
const __fnName = ${JSON.stringify(functionName)};

${code}

function __resolve() {
  if (typeof Solution === 'function') {
    const s = new Solution();
    if (typeof s[__fnName] === 'function') return s[__fnName].bind(s);
  }
  try {
    const v = eval(__fnName);
    if (typeof v === 'function') return v;
  } catch (e) {}
  if (typeof globalThis[__fnName] === 'function') return globalThis[__fnName];
  throw new Error('could not resolve callable: ' + __fnName);
}

function __deepEqual(a, b) {
  return JSON.stringify(__norm(a)) === JSON.stringify(__norm(b));
}
function __norm(v) {
  if (Array.isArray(v)) return v.map(__norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = __norm(v[k]);
    return o;
  }
  return v;
}

(async () => {
  for (const t of __tests) {
    const started = Date.now();
    try {
      const fn = __resolve();
      const args = t.args.map((a) => JSON.parse(a));
      let actual = fn(...args);
      if (actual instanceof Promise) actual = await actual;
      const actualStr = JSON.stringify(__norm(actual === undefined ? null : actual));
      let passed = true;
      if (t.expected !== null) {
        passed = __deepEqual(actual, JSON.parse(t.expected));
      }
      console.log(JSON.stringify({
        label: t.label, passed,
        actual: actualStr === undefined ? null : actualStr,
        expected: t.expected, durationMs: Date.now() - started,
      }));
    } catch (e) {
      console.log(JSON.stringify({
        label: t.label, passed: false,
        error: String(e && e.message ? e.message : e).slice(0, 500),
        durationMs: Date.now() - started,
      }));
    }
  }
})();
`;
}

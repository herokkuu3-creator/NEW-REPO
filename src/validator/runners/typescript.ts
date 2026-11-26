import { CodeRunner, RunReport, TestCase } from './types';
import { JavaScriptRunner } from './javascript';

export type StripTypeScriptTypesFn = (
  code: string,
  options?: { mode?: 'strip' | 'transform' },
) => string;

export interface TypeScriptRunnerDeps {
  loadTypescript?: () => typeof import('typescript') | null;
  loadStripTypeScriptTypes?: () => StripTypeScriptTypesFn | null;
}

function defaultLoadTypescript(): typeof import('typescript') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('typescript') as typeof import('typescript');
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'MODULE_NOT_FOUND' || /Cannot find module/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

function defaultLoadStripTypeScriptTypes(): StripTypeScriptTypesFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:module') as { stripTypeScriptTypes?: StripTypeScriptTypesFn };
    return typeof mod.stripTypeScriptTypes === 'function' ? mod.stripTypeScriptTypes : null;
  } catch {
    return null;
  }
}

/**
 * TypeScript runner: strips type annotations with the TypeScript compiler's
 * transpile-only API when available, or falls back to Node 22+'s built-in
 * `module.stripTypeScriptTypes` when `typescript` is not installed (e.g.
 * pruned production Docker images), and delegates execution to JavaScriptRunner.
 */
export class TypeScriptRunner implements CodeRunner {
  readonly language = 'typescript';
  private readonly js = new JavaScriptRunner();
  private readonly ts: typeof import('typescript') | null;
  private readonly stripFn: StripTypeScriptTypesFn | null;
  private transpileCache: { code: string; result: { ok: boolean; js?: string; error?: string } } | null = null;

  constructor(deps?: TypeScriptRunnerDeps) {
    this.ts = (deps?.loadTypescript ?? defaultLoadTypescript)();
    this.stripFn = this.ts
      ? null
      : (deps?.loadStripTypeScriptTypes ?? defaultLoadStripTypeScriptTypes)();
    if (!this.ts && !this.stripFn) {
      throw new Error('neither typescript compiler nor node:module stripTypeScriptTypes is available');
    }
  }

  private transpile(code: string): { ok: boolean; js?: string; error?: string } {
    if (this.transpileCache && this.transpileCache.code === code) {
      return this.transpileCache.result;
    }
    const result = this.transpileUncached(code);
    this.transpileCache = { code, result };
    return result;
  }

  private transpileUncached(code: string): { ok: boolean; js?: string; error?: string } {
    if (this.ts) {
      try {
        const ts = this.ts;
        const out = ts.transpileModule(code, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
          reportDiagnostics: true,
        });
        const errors = (out.diagnostics ?? []).filter(
          (d) => d.category === ts.DiagnosticCategory.Error,
        );
        if (errors.length > 0) {
          const msg = errors
            .slice(0, 3)
            .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
            .join('; ');
          return { ok: false, error: msg.slice(0, 2000) };
        }
        return { ok: true, js: out.outputText };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err) };
      }
    }

    try {
      const strip = this.stripFn!;
      try {
        return { ok: true, js: strip(code, { mode: 'transform' }) };
      } catch (transformErr) {
        const errCode = (transformErr as { code?: string })?.code;
        const errMsg = transformErr instanceof Error ? transformErr.message : String(transformErr);
        if (errCode === 'ERR_INVALID_ARG_VALUE' || /mode/i.test(errMsg)) {
          return { ok: true, js: strip(code, { mode: 'strip' }) };
        }
        throw transformErr;
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err) };
    }
  }

  async checkSyntax(code: string): Promise<{ ok: boolean; error?: string }> {
    const t = this.transpile(code);
    if (!t.ok || t.js === undefined) {
      return { ok: false, error: t.error };
    }
    if (this.ts) {
      return { ok: true };
    }
    return this.js.checkSyntax(t.js);
  }

  async run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport> {
    const t = this.transpile(code);
    if (!t.ok || t.js === undefined) {
      return { ok: false, results: [], stderr: t.error };
    }
    return this.js.run(t.js, functionName, tests);
  }
}

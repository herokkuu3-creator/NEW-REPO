import { CodeRunner, RunReport, TestCase } from './types';
import { JavaScriptRunner } from './javascript';

/**
 * TypeScript runner: strips type annotations with the TypeScript compiler's
 * transpile-only API (no type-check, no tsconfig needed) and delegates
 * execution to the JavaScript runner. `typescript` is a devDependency of
 * this project, so it is always available inside the container.
 */
export class TypeScriptRunner implements CodeRunner {
  readonly language = 'typescript';
  private readonly js = new JavaScriptRunner();

  private transpile(code: string): { ok: boolean; js?: string; error?: string } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ts = require('typescript') as typeof import('typescript');
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

  async checkSyntax(code: string): Promise<{ ok: boolean; error?: string }> {
    return this.transpile(code);
  }

  async run(code: string, functionName: string, tests: TestCase[]): Promise<RunReport> {
    const t = this.transpile(code);
    if (!t.ok || !t.js) {
      return { ok: false, results: [], stderr: t.error };
    }
    return this.js.run(t.js, functionName, tests);
  }
}

import { CodeRunner } from './types';
import { JavaScriptRunner } from './javascript';
import { TypeScriptRunner } from './typescript';
import { PythonRunner } from './python';

export * from './types';
export { JavaScriptRunner, TypeScriptRunner, PythonRunner };

export function createRunner(language: string): CodeRunner {
  switch (language) {
    case 'javascript':
      return new JavaScriptRunner();
    case 'typescript':
      return new TypeScriptRunner();
    case 'python3':
      return new PythonRunner();
    default:
      // C++ has no local runner: walkccc's solutions are human-verified, and
      // LeetCode's own judge (when AUTO_SUBMIT=true) is the real compiler.
      throw new Error(`no local runner for language: ${language}`);
  }
}

import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';
import { chromium, firefox, type Browser, type Page } from 'playwright';
import { config } from '../src/config';
import * as models from '../src/database/models';
import * as accountsDb from '../src/database/accounts';
import * as credStore from '../src/security/credentialStore';
import { loginOnLeetCodePage } from '../src/leetcode/auth';
import { TypeScriptRunner } from '../src/validator/runners/typescript';
import { PythonRunner, resolvePython3Command } from '../src/validator/runners/python';
import { JavaScriptRunner } from '../src/validator/runners/javascript';
import { createRunner } from '../src/validator/runners';
import { extractCode, validateSolution } from '../src/validator/validator';
import {
  extractFunctionName,
  parseExampleInput,
  parseExampleOutput,
} from '../src/validator/testcaseGenerator';
import { submitCurrentEditor } from '../src/leetcode/submission';
import { leetcodeGraphQL } from '../src/leetcode/graphql';
import { ensureLanguage } from '../src/leetcode/editor';
import {
  launchFirefoxWithStorageStateObject,
  launchWithPersistentProfile,
  launchWithStorageState,
  launchWithStorageStateObject,
} from '../src/browser/playwright';
import { openGhostBrowserSession, submitViaPageFetch } from '../src/leetcode/ghostSubmit';
import { checkSession } from '../src/browser/sessionCheck';
import { establishAuthenticatedSession } from '../src/browser/auth';
import { decodeEntities as decodeParserEntities, parseProblem } from '../src/leetcode/parser';
import {
  decodeEntities as decodeWalkcccEntities,
  signatureMatchesStarter,
} from '../src/solutions/walkccc';
import {
  clearCommunitySolutionsCache,
  clearSlugByNumberCacheForTests,
  executeLeetCodeGraphQL,
  extractCppCode,
  fetchArticleContent,
  fetchCommunityArticleList,
  resolveLeetCodeSlugByNumber,
} from '../src/solutions/communitySolutions';
import { fetchIncompleteQuestions } from '../src/leetcode/incompleteQuestions';
import { fetchQuestionData } from '../src/leetcode/dailyChallenge';
import { LeetCodeApi, LeetCodeHttpError } from '../src/leetcode/apiClient';
import {
  clearLeetCodePairingSessionsForTests,
  completeLeetCodePairingSession,
  createLeetCodePairingSession,
  getLatestPendingLeetCodePairingSession,
  getLeetCodePairingSession,
} from '../src/leetcode/loginHandoff';
import { parseCookiePayload, type StorageStateShape } from '../src/browser/cookiePayload';
import { extractSessionIdentity } from '../src/browser/sessionIdentity';
import { DEFAULT_SAGE_API_KEY, sageConsoleHtml } from '../src/ai/sageProbe';
import { OpenAIProvider } from '../src/ai/openai';
import { GeminiProvider } from '../src/ai/gemini';
import { createLLMProvider, LLMError } from '../src/ai/provider';
import { fakeSession } from './fixtures';
import { initCapzyKeys } from '../src/codeforces/capzyKeyManager';

afterEach(() => {
  initCapzyKeys([], 0);
  clearLeetCodePairingSessionsForTests();
  clearCommunitySolutionsCache();
  clearSlugByNumberCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('1. LeetCode browser login fixes (auth.ts)', () => {
  it('preserves VERIFICATION_REQUIRED + diagnostic even if Date.now() passes deadline', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('https://leetcode.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body><div class="cf-turnstile" data-sitekey="0x4TurnstileKeyTest"></div><input name="cf-turnstile-response"></body></html>',
        }),
      );

      const solver = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 900));
        return null;
      });

      const result = await loginOnLeetCodePage(page, 'user', 'pw', {
        timeoutMs: 800,
        solver,
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('VERIFICATION_REQUIRED');
      expect(result.state).toBe('AWAITING_USER_VERIFICATION');
      expect(result.diagnostic).toMatchObject({
        challengeType: 'turnstile',
        solverAttempted: true,
        solverResult: 'failed',
      });
    } finally {
      await browser.close();
    }
  });

  it('re-checks and solves form Turnstile after cloudflare_interstitial in retryPostSubmit', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      let postAttempts = 0;
      let interstitialCleared = false;

      await page.route('https://leetcode.com/**', async (route) => {
        const req = route.request();
        if (req.url().includes('/graphql')) {
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              data: { userStatus: { isSignedIn: postAttempts >= 2, username: 'recovered_user' } },
            }),
          });
        }
        if (req.method() === 'POST') {
          postAttempts++;
          if (postAttempts === 1) {
            return route.fulfill({
              status: 403,
              contentType: 'text/html',
              body: '<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking</div></body></html>',
            });
          }
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true }),
          });
        }
        if (interstitialCleared) {
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `
              <html><body>
                <div class="cf-turnstile" data-sitekey="0x4PostInterstitialTurnstileKey"></div>
                <input name="cf-turnstile-response">
                <form id="login">
                  <input id="id_login">
                  <input id="id_password" type="password">
                  <button type="submit">Sign In</button>
                </form>
                <script>
                  document.querySelector('#login').onsubmit = e => {
                    e.preventDefault();
                    fetch('/accounts/login/', { method: 'POST', body: '{}' });
                  };
                </script>
              </body></html>
            `,
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
            <html><body>
              <form id="login">
                <input id="id_login">
                <input id="id_password" type="password">
                <button type="submit">Sign In</button>
              </form>
              <script>
                document.querySelector('#login').onsubmit = e => {
                  e.preventDefault();
                  fetch('/accounts/login/', { method: 'POST', body: '{}' });
                };
              </script>
            </body></html>
          `,
        });
      });

      const solverCalls: Array<{ sitekey?: string }> = [];
      const solver = vi.fn(async (params: { sitekey?: string }) => {
        solverCalls.push({ sitekey: params.sitekey });
        if (!interstitialCleared) {
          interstitialCleared = true;
          return { cookies: { cf_clearance: 'cf_cleared_1' } };
        }
        return { token: 'form_turnstile_token_2' };
      });

      const result = await loginOnLeetCodePage(page, 'recovered_user', 'secret', {
        timeoutMs: 8000,
        solver,
      });

      expect(result.ok).toBe(true);
      expect(result.username).toBe('recovered_user');
      expect(solver).toHaveBeenCalledTimes(2);
      expect(solverCalls[1]?.sitekey).toBe('0x4PostInterstitialTurnstileKey');
      expect(postAttempts).toBe(2);
    } finally {
      await browser.close();
    }
  });
});

describe('2. Validator, runner, and testcaseGenerator fixes', () => {
  it('TypeScriptRunner falls back to node:module stripTypeScriptTypes when typescript is missing and throws if neither exists', async () => {
    const mod = await import('node:module');
    const runner = new TypeScriptRunner({
      loadTypescript: () => null,
      loadStripTypeScriptTypes: () =>
        (mod as unknown as { stripTypeScriptTypes: typeof mod.stripTypeScriptTypes })
          .stripTypeScriptTypes,
    });

    const syntaxOk = await runner.checkSyntax(
      'function twoSum(nums: number[], target: number): number[] { return [0, 1]; }',
    );
    expect(syntaxOk.ok).toBe(true);

    const syntaxBad = await runner.checkSyntax('function broken(: number) { return [; }');
    expect(syntaxBad.ok).toBe(false);

    const runReport = await runner.run(
      'function add(a: number, b: number): number { return a + b; }',
      'add',
      [{ label: 'example-1', args: ['2', '3'], expected: '5' }],
    );
    expect(runReport.ok).toBe(true);
    expect(runReport.results[0]?.passed).toBe(true);

    expect(
      () =>
        new TypeScriptRunner({
          loadTypescript: () => null,
          loadStripTypeScriptTypes: () => null,
        }),
    ).toThrow(/available/i);
  });

  it('PythonRunner prepends standard imports, recursively normalizes dict values, and degrades gracefully when python is missing', async () => {
    expect(() => resolvePython3Command(['nonexistent_python3_binary_xyz'])).toThrow(/no working python3/i);

    const origPath = process.env.PATH;
    try {
      process.env.PATH = '';
      expect(() => createRunner('python3')).toThrow();
      const degraded = await validateSolution(
        'class Solution:\n    def f(self, x):\n        return x',
        {
          slug: 'p',
          title: 'P',
          difficulty: 'Easy',
          questionId: '1',
          frontendId: '1',
          descriptionText: 'desc '.repeat(10),
          descriptionHtml: '<p>desc</p>',
          examples: [{ input: 'x = 1', output: '1' }],
          constraints: [],
          starterCode: 'class Solution:\n    def f(self, x):\n',
          language: 'python3',
          exampleTestcasesRaw: '1',
        },
        'python3',
      );
      expect(degraded.ok).toBe(true);
    } finally {
      process.env.PATH = origPath;
    }

    // Run real PythonRunner only if a Python 3 interpreter is installed on this host.
    let pyRunner: PythonRunner | null = null;
    try {
      pyRunner = new PythonRunner();
    } catch {
      pyRunner = null;
    }
    if (pyRunner) {
      const code = `
class Solution:
    def analyze(self, nums: List[int]) -> Dict[str, List[int]]:
        c = collections.Counter(nums)
        g = math.gcd(nums[0], nums[1])
        return {'b': (g, c[nums[0]]), 'a': [1, 2]}
`;
      const report = await pyRunner.run(code, 'analyze', [
        { label: 'example-1', args: ['[2, 4, 2]'], expected: '{"a": [1, 2], "b": [2, 2]}' },
      ]);
      expect(report.ok).toBe(true);
      expect(report.results[0]?.passed).toBe(true);
    }
  });

  it('PythonRunner and JavaScriptRunner tolerate fs.rmSync throwing in cleanup', async () => {
    const js = new JavaScriptRunner();
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });
    const res = await js.checkSyntax('function f(x) { return x + 1; }');
    expect(res.ok).toBe(true);
    expect(rmSpy).toHaveBeenCalled();
  });

  it('testcaseGenerator returns null on invalid JSON in examples and extracts function names cleanly', () => {
    expect(parseExampleInput('nums = [1, 2, ...], target = 9')).toBeNull();
    expect(parseExampleOutput('[1, ...]')).toBeNull();

    const pyStarter = `
# Definition for singly-linked list.
# def __init__(self, val=0):
class Solution:
    def __init__(self):
        pass
    def reverseList(self, head):
        pass
`;
    expect(extractFunctionName(pyStarter, 'python3')).toBe('reverseList');

    const tsArrow = `
/**
 * function ListNode(val, next) {}
 */
// function ignoredHelper() {}
const twoSum = (nums: number[], target: number): number[] => {
  return [];
};
`;
    expect(extractFunctionName(tsArrow, 'typescript')).toBe('twoSum');

    const jsClass = `
class Solution {
  constructor() {}
  solveProblem(nums) {}
}
`;
    expect(extractFunctionName(jsClass, 'javascript')).toBe('solveProblem');
  });

  it('validator extractCode matches fenced blocks with info strings containing spaces/brackets and CRLF', () => {
    const raw = 'Explanation:\r\n```cpp []\r\nclass Solution {\r\npublic:\r\n  int f() { return 1; }\r\n};\r\n```\r\n';
    expect(extractCode(raw, 'cpp')).toBe('class Solution {\r\npublic:\r\n  int f() { return 1; }\r\n};');
  });
});

describe('3. Submission & GraphQL fixes', () => {
  it('cancels waitForSubmissionId cleanly when clickSubmit fails without unhandled rejection or listener leak', async () => {
    const listeners = new Set<(...args: unknown[]) => void>();
    const fakePage = {
      on: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
        if (ev === 'response') listeners.add(fn);
      }),
      off: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
        if (ev === 'response') listeners.delete(fn);
      }),
      locator: vi.fn(() => ({
        first: () => ({
          count: vi.fn(async () => 0),
        }),
      })),
    } as unknown as Page;

    await expect(submitCurrentEditor(fakePage, '1')).rejects.toThrow('submit button not found');
    expect(listeners.size).toBe(0);
    expect((fakePage.off as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('polls /v2/check/ for large submission IDs without calling 32-bit Int! GraphQL, and falls back to DOM panel', async () => {
    const largeId = '2192767591';
    const listeners = new Set<(res: unknown) => void>();
    const evalCalls: string[] = [];

    const mkPage = (checkReplies: Array<unknown>, domText = '') =>
      ({
        on: vi.fn((ev: string, fn: (res: unknown) => void) => {
          if (ev === 'response') listeners.add(fn);
        }),
        off: vi.fn((ev: string, fn: (res: unknown) => void) => {
          if (ev === 'response') listeners.delete(fn);
        }),
        waitForTimeout: vi.fn(async () => undefined),
        locator: vi.fn((sel: string) => ({
          first: () => ({
            count: vi.fn(async () => {
              if (sel.includes('submit') || sel.includes('Submit')) return 1;
              if (domText && sel.includes('submission-result')) return 1;
              return 0;
            }),
            click: vi.fn(async () => {
              for (const fn of listeners) {
                fn({
                  url: () => 'https://leetcode.com/problems/two-sum/submit/',
                  request: () => ({ method: () => 'POST' }),
                  json: async () => ({ submission_id: largeId }),
                });
              }
            }),
            innerText: vi.fn(async () => domText),
          }),
        })),
        evaluate: vi.fn(async (fn: unknown, arg: unknown) => {
          evalCalls.push(String(fn));
          if (typeof arg === 'string') {
            return checkReplies.shift() ?? null;
          }
          throw new Error('SUBMISSION_DETAILS_QUERY must not be called for > 32-bit ID');
        }),
      }) as unknown as Page;

    const page1 = mkPage([
      { state: 'PENDING' },
      { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', status_runtime: '4 ms', status_memory: '9 MB' },
    ]);
    const res1 = await submitCurrentEditor(page1, '1');
    expect(res1).toMatchObject({
      submissionId: largeId,
      classification: 'ACCEPTED',
      runtime: '4 ms',
      memory: '9 MB',
    });

    evalCalls.length = 0;
    const page2 = mkPage([null], 'Accepted');
    const res2 = await submitCurrentEditor(page2, '1');
    expect(res2).toMatchObject({
      submissionId: largeId,
      classification: 'ACCEPTED',
      statusDisplay: 'Accepted',
    });
  });

  it('leetcodeGraphQL sends x-csrftoken extracted from document.cookie', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      let capturedHeaders: Record<string, string> = {};
      await page.route('https://leetcode.com/**', async (route) => {
        const req = route.request();
        if (req.url().endsWith('/graphql')) {
          capturedHeaders = req.headers();
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: { ping: 'ok' } }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'Set-Cookie': 'csrftoken=csrf_from_cookie_123; Path=/' },
          body: '<html><body>ok</body></html>',
        });
      });
      await page.goto('https://leetcode.com/');
      const { z } = await import('zod');
      const data = await leetcodeGraphQL(page, 'query { ping }', {}, z.object({ ping: z.string() }));
      expect(data.ping).toBe('ok');
      expect(capturedHeaders['x-csrftoken']).toBe('csrf_from_cookie_123');
    } finally {
      await browser.close();
    }
  });
});

describe('4. Editor language detection fix', () => {
  it('inspects Monaco active model languageId and maps python3 <-> python', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <script>
          window.monaco = {
            editor: {
              getModels: () => [{ getLanguageId: () => 'python' }]
            }
          };
        </script>
      `);
      expect(await ensureLanguage(page, 'python3')).toBe(true);
    } finally {
      await browser.close();
    }
  });
});

describe('5. Playwright & GhostSubmit lifecycle and submission_id fixes', () => {
  it('closes browser & context when newContext or newPage throws, and close() closes browser even if context.close throws', async () => {
    const browserClose = vi.fn(async () => undefined);
    const ctxClose = vi.fn(async () => {
      throw new Error('context close failure');
    });

    vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => {
        throw new Error('newContext boom');
      }),
      close: browserClose,
    } as unknown as Browser);
    expect(await launchWithStorageStateObject({ cookies: [], origins: [] }, 'lbl')).toBeNull();
    expect(browserClose).toHaveBeenCalledTimes(1);

    const browserClose2 = vi.fn(async () => undefined);
    vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => ({
        addInitScript: vi.fn(async () => undefined),
        pages: () => [],
        newPage: vi.fn(async () => ({ on: vi.fn() })),
        close: ctxClose,
      })),
      close: browserClose2,
    } as unknown as Browser);
    const session = await launchWithStorageStateObject({ cookies: [], origins: [] }, 'lbl');
    expect(session).not.toBeNull();
    await expect(session!.close()).resolves.toBeUndefined();
    expect(ctxClose).toHaveBeenCalledTimes(1);
    expect(browserClose2).toHaveBeenCalledTimes(1);

    const ffBrowserClose = vi.fn(async () => undefined);
    const ffCtxClose = vi.fn(async () => undefined);
    vi.spyOn(firefox, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => ({
        addInitScript: vi.fn(async () => undefined),
        route: vi.fn(async () => undefined),
        pages: () => [],
        newPage: vi.fn(async () => {
          throw new Error('newPage boom');
        }),
        close: ffCtxClose,
      })),
      close: ffBrowserClose,
    } as unknown as Browser);
    expect(await launchFirefoxWithStorageStateObject({ cookies: [], origins: [] }, 'ff')).toBeNull();
    expect(ffCtxClose).toHaveBeenCalledTimes(1);
    expect(ffBrowserClose).toHaveBeenCalledTimes(1);
  });

  it('openGhostBrowserSession closes browser when newContext throws, and submitViaPageFetch accepts numeric or string submission_id', async () => {
    const browserClose = vi.fn(async () => undefined);
    vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      isConnected: () => true,
      newContext: vi.fn(async () => {
        throw new Error('ghost context boom');
      }),
      close: browserClose,
    } as unknown as Browser);

    const ghost = await openGhostBrowserSession(
      { cookies: [], origins: [] },
      {},
      { resolveProxy: async () => null },
    );
    await expect(
      ghost.submit({ slug: 'two-sum', questionId: '1', lang: 'cpp', code: 'class Solution {};' }),
    ).rejects.toThrow('ghost context boom');
    expect(browserClose).toHaveBeenCalledTimes(1);
    await ghost.close();

    const makeFakePage = (responseBody: unknown) =>
      ({
        context: () => ({
          cookies: async () => [
            { name: 'csrftoken', value: 'csrf_1', domain: '.leetcode.com', path: '/' },
          ],
          addCookies: async () => undefined,
        }),
        waitForTimeout: async () => undefined,
        evaluate: async () => ({ status: 200, text: JSON.stringify(responseBody) }),
      }) as unknown as Page;

    expect(
      await submitViaPageFetch(makeFakePage({ submission_id: '2192767591' }), {
        slug: 'two-sum',
        questionId: '1',
        lang: 'cpp',
        code: 'code',
      }),
    ).toBe('2192767591');

    expect(
      await submitViaPageFetch(makeFakePage({ submission_id: 42 }), {
        slug: 'two-sum',
        questionId: '1',
        lang: 'cpp',
        code: 'code',
      }),
    ).toBe('42');

    await expect(
      submitViaPageFetch(makeFakePage({ submission_id: '0' }), {
        slug: 'two-sum',
        questionId: '1',
        lang: 'cpp',
        code: 'code',
      }),
    ).rejects.toThrow(/no submission_id/);
  });
});

describe('6. sessionCheck & browser/auth challenge propagation fixes', () => {
  it('sessionCheck preserves exact shape on plain failure and sets challenged: true only on challenge errors', async () => {
    const plainApi = {
      graphql: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    } as unknown as LeetCodeApi;
    expect(await checkSession(plainApi)).toEqual({ authenticated: false, cause: 'query-failed' });

    const cfApi = {
      graphql: vi.fn(async () => {
        throw new LeetCodeHttpError('GraphQL HTTP 403', 403);
      }),
    } as unknown as LeetCodeApi;
    expect(await checkSession(cfApi)).toEqual({
      authenticated: false,
      cause: 'query-failed',
      challenged: true,
    });
  });

  it('establishAuthenticatedSession reports CLOUDFLARE_VERIFICATION_REQUIRED when check.challenged is true', async () => {
    vi.spyOn(models, 'setSystemState').mockResolvedValue(undefined);
    vi.spyOn(models, 'loadStorageStateFromDb').mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const browserClose = vi.fn(async () => undefined);
    const ctxClose = vi.fn(async () => undefined);
    const mockRequest = {
      post: vi.fn(async () => ({
        status: () => 403,
        text: async () => '<html><title>Just a moment...</title></html>',
        headers: () => ({}),
        dispose: async () => undefined,
      })),
    };
    vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => ({
        addInitScript: vi.fn(async () => undefined),
        pages: () => [],
        newPage: vi.fn(async () => ({ on: vi.fn() })),
        cookies: async () => [],
        request: mockRequest,
        close: ctxClose,
      })),
      close: browserClose,
    } as unknown as Browser);

    const outcome = await establishAuthenticatedSession();
    expect(outcome).toEqual({ ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' });
    expect(ctxClose).toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalled();
    expect(models.setSystemState).toHaveBeenCalledWith(
      models.SystemKeys.authStatus,
      'cloudflare_verification_required',
    );
  });

  it('launchWithPersistentProfile closes context if openPageWithCapture/stealth throws', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const ctxClose = vi.fn(async () => undefined);
    vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValueOnce({
      addInitScript: vi.fn(async () => {
        throw new Error('stealth failed');
      }),
      close: ctxClose,
    } as never);
    expect(await launchWithPersistentProfile()).toBeNull();
    expect(ctxClose).toHaveBeenCalledTimes(1);
  });

  it('launchWithStorageState closes browser if newContext throws', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const browserClose = vi.fn(async () => undefined);
    vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => {
        throw new Error('bad storage');
      }),
      close: browserClose,
    } as unknown as Browser);
    expect(await launchWithStorageState()).toBeNull();
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});

describe('7. Parser, walkccc, communitySolutions, incompleteQuestions, dailyChallenge fixes', () => {
  it('single-pass decodeEntities prevents double decoding and invalid codepoint RangeError', () => {
    expect(decodeParserEntities('&amp;lt;script&amp;gt; &#99999999; &#x110000;')).toBe(
      '&lt;script&gt; &#99999999; &#x110000;',
    );
    expect(decodeWalkcccEntities('&amp;lt;script&amp;gt; &#99999999; &#x110000;')).toBe(
      '&lt;script&gt; &#99999999; &#x110000;',
    );
  });

  it('strips comments and handles pointer/reference C++ identifiers in walkccc and communitySolutions', () => {
    const problem = parseProblem(
      {
        frontendId: '206',
        title: 'Reverse Linked List',
        slug: 'reverse-linked-list',
        difficulty: 'Easy',
        isPaidOnly: false,
        contentHtml: '<p>Reverse a singly linked list with enough text.</p>',
        exampleTestcases: '[1,2]',
        metaData: null,
        codeSnippets: [
          {
            lang: 'C++',
            langSlug: 'cpp',
            code: `/* void fakeMethod() */\n// ListNode* fakeTwo()\nclass Solution {\npublic:\n    ListNode *reverseList(ListNode* head) {\n    }\n};`,
          },
        ],
      },
      'cpp',
    );

    expect(
      signatureMatchesStarter(
        'class Solution {\npublic:\n ListNode* reverseList(ListNode* head) { return head; }\n};',
        problem,
      ),
    ).toBe(true);
    expect(
      signatureMatchesStarter(
        'class Solution {\npublic:\n ListNode* wrongMethod(ListNode* head) { return head; }\n};',
        problem,
      ),
    ).toBe(false);

    const extracted = extractCppCode(
      '```cpp\nclass Solution {\npublic:\n ListNode *reverseList(ListNode* head) { return head; }\n};\n```',
      problem,
    );
    expect(extracted).toContain('reverseList');
  });

  it('communitySolutions sends x-csrftoken in-page and bounds its in-memory caches', async () => {
    let evaluatedArgs: unknown;
    const fakePage = {
      evaluate: vi.fn(async (fn: unknown, arg: unknown) => {
        evaluatedArgs = { fnStr: String(fn), arg };
        return { status: 200, body: JSON.stringify({ data: { ok: true } }) };
      }),
    } as unknown as Page;
    await executeLeetCodeGraphQL(
      'query { ok }',
      {},
      { page: fakePage },
    );
    expect((evaluatedArgs as { fnStr: string }).fnStr).toContain('x-csrftoken');

    clearCommunitySolutionsCache();
    clearSlugByNumberCacheForTests();
    let fetchCalls = 0;
    const graphql = vi.fn(async (_q: string, vars: Record<string, unknown>) => {
      fetchCalls++;
      if (vars.articleId) {
        return { ugcArticleSolutionArticle: { uuid: vars.articleId, content: `content-${vars.articleId}` } };
      }
      if (vars.filters) {
        const num = (vars.filters as { searchKeywords: string }).searchKeywords;
        return {
          problemsetQuestionList: {
            questions: [{ frontendQuestionId: num, titleSlug: `slug-${num}` }],
          },
        };
      }
      return {
        ugcArticleSolutionArticles: {
          edges: [{ node: { uuid: `u-${vars.questionSlug}`, title: 'T', slug: 's' } }],
        },
      };
    });

    for (let i = 0; i < 252; i++) {
      await fetchArticleContent(`art-${i}`, { graphql: graphql as never });
    }
    const beforeEvictedRefetch = fetchCalls;
    await fetchArticleContent('art-0', { graphql: graphql as never });
    expect(fetchCalls).toBe(beforeEvictedRefetch + 1);

    for (let i = 0; i < 502; i++) {
      await fetchCommunityArticleList(`prob-${i}`, { graphql: graphql as never });
    }
    const beforeListRefetch = fetchCalls;
    await fetchCommunityArticleList('prob-0', { graphql: graphql as never });
    expect(fetchCalls).toBe(beforeListRefetch + 1);

    for (let i = 1; i <= 2002; i++) {
      await resolveLeetCodeSlugByNumber(i, { graphql: graphql as never });
    }
    const beforeSlugRefetch = fetchCalls;
    await resolveLeetCodeSlugByNumber(1, { graphql: graphql as never });
    expect(fetchCalls).toBe(beforeSlugRefetch + 1);
  });

  it('incompleteQuestions clamps invalid pageSize, skips empty titleSlug, and stops on partial page', async () => {
    const graphql = vi.fn(async (_q: string, vars: Record<string, unknown>) => {
      expect(vars.limit).toBe(1);
      if (vars.skip === 0) {
        return {
          problemsetQuestionList: {
            total: 10,
            questions: [{ frontendQuestionId: '1', titleSlug: '', title: 'Missing Slug', status: null }],
          },
        };
      }
      return {
        problemsetQuestionList: {
          total: 10,
          questions: [],
        },
      };
    });
    const res = await fetchIncompleteQuestions({ graphql }, 5, 0);
    expect(res).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(2);

    const partialGraphql = vi.fn(async () => ({
      problemsetQuestionList: {
        total: 100,
        questions: [{ frontendQuestionId: '1', titleSlug: 'two-sum', title: 'Two Sum', status: null }],
      },
    }));
    const res2 = await fetchIncompleteQuestions({ graphql: partialGraphql }, 10, 50);
    expect(res2).toHaveLength(1);
    expect(partialGraphql).toHaveBeenCalledTimes(1);
  });

  it('dailyChallenge fetchQuestionData allows nullable questionId and throws 404 LeetCodeHttpError when question is null', async () => {
    const nullIdApi = {
      graphql: vi.fn(async () => ({
        question: {
          questionId: null,
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          difficulty: 'Easy',
          content: '<p>content</p>',
          exampleTestcases: '1',
          metaData: null,
          codeSnippets: [],
          isPaidOnly: false,
        },
      })),
    } as unknown as LeetCodeApi;
    const raw = await fetchQuestionData(nullIdApi, 'two-sum');
    expect(raw.questionId).toBeNull();

    const notFoundApi = {
      graphql: vi.fn(async () => ({ question: null })),
    } as unknown as LeetCodeApi;
    await expect(fetchQuestionData(notFoundApi, 'missing-slug')).rejects.toMatchObject({
      name: 'LeetCodeHttpError',
      status: 404,
    });
  });
});

describe('8. loginHandoff, cookiePayload, and sessionIdentity fixes', () => {
  it('loginHandoff clears password on pruneStaleSessions and checks local/server/identifier mismatches before saving credentials', async () => {
    vi.spyOn(accountsDb, 'listAccounts').mockResolvedValue([]);
    vi.spyOn(accountsDb, 'saveAccount').mockResolvedValue({
      id: 'acc-1',
      label: 'alice',
      username: 'alice',
      status: AccountStatus.ACTIVE,
    } as never);
    vi.spyOn(accountsDb, 'patchAccount').mockResolvedValue({} as never);
    const saveCredsSpy = vi.spyOn(credStore, 'saveEncryptedCredentials').mockResolvedValue(undefined);

    // Password cleared when expired during pruneStaleSessions
    const s1 = createLeetCodePairingSession({
      label: 'stale_lbl',
      identifier: 'stale_user',
      password: 'plain_secret_password',
      ttlMs: 60_000,
    });
    const liveRef = getLeetCodePairingSession(s1.token);
    expect(liveRef?.password).toBe('plain_secret_password');
    getLatestPendingLeetCodePairingSession(s1.expiresAt + 1);
    expect(liveRef?.status).toBe('expired');
    expect(liveRef?.password).toBeUndefined();

    // Local vs server mismatch on ACTIVE session: flags mismatch and does NOT persist password
    const s2 = createLeetCodePairingSession({
      label: 'alice',
      identifier: 'alice',
      password: 'alice_password',
    });
    const cookieStr = `LEETCODE_SESSION=${fakeSession({ username: 'bob' })}; csrftoken=csrf123`;
    const mismatchRes = await completeLeetCodePairingSession(
      s2.token,
      { cookies: cookieStr, localVerifiedUsername: 'alice' },
      {
        validator: async () => ({ ok: true, username: 'bob' }),
        notifyTelegram: async () => true,
      },
    );
    expect(mismatchRes.ok).toBe(true);
    if (mismatchRes.ok) {
      expect(mismatchRes.localVsServerMismatch).toBe(true);
    }
    expect(saveCredsSpy).not.toHaveBeenCalled();

    // Non-email pendingIdentifier mismatch (even when localVerifiedUsername matches server) skips saving password
    const s3 = createLeetCodePairingSession({
      label: 'alice',
      identifier: 'alice',
      password: 'alice_password',
    });
    const idMismatchRes = await completeLeetCodePairingSession(
      s3.token,
      { cookies: cookieStr, localVerifiedUsername: 'bob' },
      {
        validator: async () => ({ ok: true, username: 'bob' }),
        notifyTelegram: async () => true,
      },
    );
    expect(idMismatchRes.ok).toBe(true);
    expect(saveCredsSpy).not.toHaveBeenCalled();

    // Email pendingIdentifier with matching local/server DOES save credentials
    const s4 = createLeetCodePairingSession({
      label: 'bob',
      identifier: 'bob@example.com',
      password: 'bob_password',
    });
    const emailRes = await completeLeetCodePairingSession(
      s4.token,
      { cookies: cookieStr, localVerifiedUsername: 'bob' },
      {
        validator: async () => ({ ok: true, username: 'bob' }),
        notifyTelegram: async () => true,
      },
    );
    expect(emailRes.ok).toBe(true);
    expect(saveCredsSpy).toHaveBeenCalledWith('leetcode', 'bob', {
      username: 'bob',
      password: 'bob_password',
      label: 'bob',
    });
  });

  it('cookiePayload enforces strict leetcode.com domain boundary and coerces secure=true when sameSite=None', () => {
    const spoofed = parseCookiePayload(
      JSON.stringify([
        { name: 'LEETCODE_SESSION', value: 'x'.repeat(20), domain: '.evil-leetcode.com' },
        { name: 'csrftoken', value: 'abc', domain: 'leetcode.com.attacker.test' },
      ]),
    );
    expect(spoofed.ok).toBe(false);

    const sameSiteNone = parseCookiePayload(
      JSON.stringify([
        {
          name: 'LEETCODE_SESSION',
          value: 'x'.repeat(20),
          domain: '.leetcode.com',
          secure: false,
          sameSite: 'None',
        },
        {
          name: 'csrftoken',
          value: 'abc',
          domain: 'leetcode.com',
          secure: false,
          sameSite: 'no_restriction',
        },
      ]),
    );
    expect(sameSiteNone.ok).toBe(true);
    if (sameSiteNone.ok) {
      expect(sameSiteNone.storageState.cookies.every((c) => c.secure === true)).toBe(true);
    }
  });

  it('sessionIdentity prefers non-expired newest LEETCODE_SESSION across duplicate domain cookies', () => {
    const NOW = 1_800_000_000;
    const state: StorageStateShape = {
      cookies: [
        {
          name: 'LEETCODE_SESSION',
          value: fakeSession({ username: 'expired_user', refreshed_at: NOW - 2_000_000, _session_expiry: 1_209_600 }),
          domain: '.leetcode.com',
          path: '/',
          expires: NOW - 100,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'LEETCODE_SESSION',
          value: fakeSession({ username: 'older_valid', refreshed_at: NOW - 5000, _session_expiry: 1_209_600 }),
          domain: 'leetcode.com',
          path: '/',
          expires: NOW + 1000,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'LEETCODE_SESSION',
          value: fakeSession({ username: 'newest_valid', refreshed_at: NOW - 100, _session_expiry: 1_209_600 }),
          domain: '.leetcode.com',
          path: '/',
          expires: NOW + 5000,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    };
    const identity = extractSessionIdentity(state, NOW);
    expect(identity.expired).toBe(false);
    expect(identity.username).toBe('newest_valid');
  });
});

describe('9. Sage XSS escaping and LLM provider option wiring fixes', () => {
  it('sageConsoleHtml escapes hostLabel, retains DEFAULT_SAGE_API_KEY, and escapes dynamic fields in runDiagnosticTest', () => {
    const html = sageConsoleHtml('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).toContain(DEFAULT_SAGE_API_KEY);
    expect(html).toContain('escapeHtml(String(data.executionHost');
    expect(html).toContain('escapeHtml(String(data.error');
    expect(html).toContain('escapeHtml(String(data.chatReply');
  });

  it('OpenAIProvider & GeminiProvider validate model and forward maxTokens, temperature, and timeoutMs', async () => {
    expect(() => new OpenAIProvider({ apiKey: 'k', model: '  ', timeoutMs: 1000 })).toThrow(LLMError);
    expect(() => new GeminiProvider({ apiKey: 'k', model: '  ', timeoutMs: 1000 })).toThrow(LLMError);

    const origLlm = { ...config.llm };
    try {
      (config.llm as { provider: string; apiKey: string; model: string; maxTokens: number; temperature?: number }).provider = 'openai';
      (config.llm as { apiKey: string }).apiKey = 'sk-test';
      (config.llm as { model: string }).model = 'gpt-4o-mini';
      (config.llm as { maxTokens: number }).maxTokens = 2048;
      (config.llm as { temperature?: number }).temperature = 0.45;

      const provider = createLLMProvider() as OpenAIProvider;
      const createSpy = vi.fn(async () => ({
        choices: [{ message: { content: 'ok' } }],
      }));
      (provider as unknown as { client: { chat: { completions: { create: typeof createSpy } } } }).client = {
        chat: { completions: { create: createSpy } },
      };

      await provider.generate([{ role: 'user', content: 'hi' }], { timeoutMs: 1234 });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini',
          max_tokens: 2048,
          temperature: 0.45,
        }),
        { timeout: 1234 },
      );

      await provider.generate([{ role: 'user', content: 'hi' }]);
      expect(createSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini',
          max_tokens: 2048,
          temperature: 0.45,
        }),
        undefined,
      );
    } finally {
      Object.assign(config.llm, origLlm);
    }

    const gem = new GeminiProvider({ apiKey: 'gk', model: 'gemini-3.5-flash', timeoutMs: 5000 });
    const gemCreateSpy = vi.fn(async () => ({
      choices: [{ message: { content: 'gem-ok' } }],
    }));
    (gem as unknown as { client: { chat: { completions: { create: typeof gemCreateSpy } } } }).client = {
      chat: { completions: { create: gemCreateSpy } },
    };
    await gem.generate([{ role: 'user', content: 'hi' }], { timeoutMs: 4321 });
    expect(gemCreateSpy).toHaveBeenCalledWith(expect.any(Object), { timeout: 4321 });
  });
});

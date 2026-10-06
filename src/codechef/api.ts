import type { Page, Response } from 'playwright';
import { withCodeChefPage, type CodeChefState } from './browser';
import { logger } from '../logger';

export interface CodeChefSubmitResult {
  ok: boolean;
  performed?: boolean;
  clicked?: boolean;
  kind?: 'signed-out' | 'blocked' | 'error';
  submissionId?: string;
  verdict?: string;
  error?: string;
}

export function normalizeCodeChefVerdict(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  const text = raw.replace(/[\s_-]+/g, ' ');
  if (['wait', 'waiting', 'running', 'judging', 'queued', 'in queue', 'evaluating', 'submitted'].includes(text)) {
    return null;
  }
  const names: Record<string, string> = {
    ac: 'Accepted',
    accepted: 'Accepted',
    'correct answer': 'Accepted',
    wa: 'Wrong Answer',
    wrong: 'Wrong Answer',
    'wrong answer': 'Wrong Answer',
    tle: 'Time Limit Exceeded',
    time: 'Time Limit Exceeded',
    'time limit exceeded': 'Time Limit Exceeded',
    ce: 'Compilation Error',
    compilation: 'Compilation Error',
    'compilation error': 'Compilation Error',
    'compile error': 'Compilation Error',
    re: 'Runtime Error',
    rte: 'Runtime Error',
    runtime: 'Runtime Error',
    'runtime error': 'Runtime Error',
    sigsegv: 'Runtime Error',
    sigfpe: 'Runtime Error',
    sigabrt: 'Runtime Error',
    nzec: 'Runtime Error',
    'partially correct': 'Partially Correct',
    'partially solved': 'Partially Correct',
    partial: 'Partially Correct',
    'internal error': 'Internal Error',
  };
  return names[text] ?? null;
}

function responseDetails(value: unknown, depth = 0): { id?: string; verdict?: string } {
  if (!value || typeof value !== 'object' || depth > 5) return {};
  const object = value as Record<string, unknown>;
  const idValue = object.upid ?? object.up_id ?? object.solution_id ?? object.solutionId ?? object.submission_id ?? object.submissionId ?? object.id ?? object.sub_id;
  const id = (typeof idValue === 'number' || typeof idValue === 'string') && /^[1-9]\d{0,18}$/.test(String(idValue)) ? String(idValue) : undefined;
  const verdict = normalizeCodeChefVerdict(object.result_code ?? object.verdict ?? object.result ?? object.status ?? object.STATUS ?? object.verdict_code ?? object.result_description) ?? undefined;
  const child = responseDetails(object.data ?? object.result ?? object.details, depth + 1);
  return { id: id ?? child.id, verdict: verdict ?? child.verdict };
}

export async function selectCodeChefLanguage(page: Page, language = 'cpp'): Promise<void> {
  if (!/^(cpp|c\+\+(?:14|17|20|23)?)$/i.test(language)) {
    throw new Error(`Unsupported CodeChef source language: ${language}`);
  }

  // 1. Check if C++ is ALREADY selected
  const isAlreadyCpp = await page.evaluate(() => {
    const selectors = [
      '#language-select',
      '[data-cy="language-select"]',
      '[class*="language" i]',
      '[class*="Language" i]',
      'button',
      'select',
    ];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of Array.from(elements)) {
        const text = (el.textContent || (el as HTMLSelectElement).value || '').trim();
        if (/^C\+\+(?:14|17|20|23)?(?:\s|\(|$)/i.test(text)) return true;
      }
    }
    return false;
  }).catch(() => false);

  if (isAlreadyCpp) {
    logger.info('C++ language is already selected in CodeChef IDE');
    return;
  }

  // 2. Try native <select>
  const native = page.locator('select').first();
  if (await native.count() && await native.isVisible().catch(() => false)) {
    const options = await native.locator('option').evaluateAll(nodes =>
      nodes.map(el => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' }))
    );
    const chosen = options.find(el => /C\+\+17/i.test(el.text)) ?? options.find(el => /C\+\+/i.test(el.text));
    if (chosen) {
      await native.selectOption(chosen.value);
      return;
    }
  }

  // 3. Try custom dropdown / combobox
  const dropdownSelectors = [
    '#language-select',
    '[data-cy*="language"]',
    '[class*="language-select" i]',
    '[class*="LanguageSelect" i]',
    '[role="combobox"]',
    'button:has-text("Rust"), button:has-text("Python"), button:has-text("Java"), button:has-text("C")',
  ];

  for (const selector of dropdownSelectors) {
    const dropdown = page.locator(selector).first();
    if (await dropdown.count() && await dropdown.isVisible().catch(() => false)) {
      try {
        await dropdown.click({ timeout: 5000 });
        await page.waitForTimeout(300);

        const optionSelectors = [
          '[role="option"]',
          '.select__option',
          'div[class*="option" i]',
          'li[role="option"]',
          'li',
          'button',
        ];
        for (const optSel of optionSelectors) {
          const options = page.locator(optSel);
          const count = await options.count();
          for (let i = 0; i < Math.min(count, 50); i++) {
            const opt = options.nth(i);
            const text = (await opt.textContent().catch(() => ''))?.trim() ?? '';
            if (/^C\+\+(?:17|14|20|23)?(?:\s|\(|$)/i.test(text) || text === 'C++') {
              await opt.click();
              logger.info({ chosenLanguage: text }, 'Selected C++ in CodeChef language dropdown');
              return;
            }
          }
        }
      } catch {}
    }
  }

  logger.warn('Could not explicitly change language in CodeChef IDE, continuing with default/active language');
}

export async function fillCodeChefSource(page: Page, code: string): Promise<void> {
  const editorSelector = '.ace_editor, .monaco-editor, [class*="editor"]';
  await page.locator(editorSelector).first().waitFor({ state: 'visible', timeout: 20000 });

  const populated = await page.evaluate(content => {
    // 1. Try Ace editor via DOM element env
    const aceElements = Array.from(document.querySelectorAll('.ace_editor'));
    for (const el of aceElements) {
      const aceEnv = (el as any).env?.editor;
      if (aceEnv && typeof aceEnv.setValue === 'function') {
        aceEnv.setValue(content, -1);
        if (aceEnv.getValue() === content) return true;
      }
    }

    // 2. Try window.ace
    const app = window as any;
    if (app.ace && typeof app.ace.edit === 'function') {
      const el = document.querySelector('.ace_editor');
      if (el) {
        const editor = app.ace.edit(el);
        editor.setValue(content, -1);
        if (editor.getValue() === content) return true;
      }
    }

    // 3. Try Monaco editor
    if (app.monaco?.editor) {
      const models = app.monaco.editor.getModels?.();
      if (models && models.length > 0) {
        models[0].setValue(content);
        if (models[0].getValue() === content) return true;
      }
    }

    // 4. Fallback: try textarea or inputarea
    const textarea = document.querySelector('.ace_text-input, textarea.inputarea, textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return false;
  }, code);

  if (!populated) {
    throw new Error('CodeChef code editor could not be populated with source code');
  }
}

/**
 * Submits straight to CodeChef's /api/ide/submit (form field `sourceCode`) using the
 * authenticated browser-context cookies, then polls /api/ide/submit?solution_id=<upid>.
 * Returns null when the API path is unusable *before* anything was submitted, so the
 * caller can fall back to the UI flow. Once a submission id exists it never returns null
 * (avoids duplicate submissions).
 */
async function submitViaCodeChefApi(
  page: Page,
  problemCode: string,
  code: string,
  language: string,
  timeoutMs: number,
): Promise<CodeChefSubmitResult | null> {
  const request = page.context().request;
  const base = 'https://www.codechef.com';
  try {
    const pageRes = await request.get(`${base}/problems/${problemCode}`, { timeout: 20000 });
    if (/\/login(?:[/?#]|$)/.test(pageRes.url())) {
      return { ok: false, clicked: false, kind: 'signed-out', error: 'CodeChef session redirected to login' };
    }
    if (!pageRes.ok()) return null;
    const html = await pageRes.text();
    const csrf = /window\.csrfToken\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
    if (!csrf || !/"username"\s*:\s*"/.test(html)) {
      logger.warn({ hasCsrf: Boolean(csrf) }, 'CodeChef API submit unavailable (no csrf/session); falling back to UI');
      return null;
    }

    logger.info({ problemCode }, 'Submitting to CodeChef via /api/ide/submit...');
    const lang = /^c\+\+(\d+)$/i.exec(language)?.[1] ?? '17';
    const postRes = await request.post(`${base}/api/ide/submit`, {
      timeout: 30000,
      headers: {
        'x-csrf-token': csrf,
        'x-requested-with': 'XMLHttpRequest',
        origin: base,
        referer: `${base}/problems/${problemCode}?tab=ide`,
      },
      form: {
        sourceCode: code,
        language: `CPP${lang}`,
        problemCode,
        contestCode: 'PRACTICE',
      },
    });
    const posted = await postRes.json().catch(() => null);
    const first = responseDetails(posted);
    if (!first.id) {
      logger.warn({ status: postRes.status(), body: posted }, 'CodeChef API submit returned no submission id; falling back to UI');
      return null;
    }

    const submissionId = first.id;
    let verdict = first.verdict;
    logger.info({ submissionId }, 'CodeChef API submission accepted for judging');
    const deadline = Date.now() + timeoutMs;
    while (!verdict && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const poll = await request.get(`${base}/api/ide/submit?solution_id=${encodeURIComponent(submissionId)}`, {
        timeout: 15000,
        headers: { 'x-requested-with': 'XMLHttpRequest', referer: `${base}/problems/${problemCode}?tab=ide` },
      }).catch(() => null);
      const data = poll ? await poll.json().catch(() => null) : null;
      verdict = responseDetails(data).verdict;
    }
    if (!verdict) {
      return { ok: false, performed: true, clicked: true, submissionId, verdict: 'Submitted', error: 'CodeChef verdict still pending' };
    }
    logger.info({ submissionId, verdict }, 'CodeChef API verdict received');
    return { ok: verdict === 'Accepted', performed: true, clicked: true, submissionId, verdict };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'CodeChef API submit failed before submission; falling back to UI');
    return null;
  }
}

export async function submitOnCodeChefPage(
  page: Page,
  problemUrl: string,
  code: string,
  language = 'cpp',
  timeoutMsOrHandle: number | string = 90000,
  userHandle?: string,
): Promise<CodeChefSubmitResult> {
  const timeoutMs = typeof timeoutMsOrHandle === 'number' ? timeoutMsOrHandle : 90000;
  const targetHandle = typeof timeoutMsOrHandle === 'string' ? timeoutMsOrHandle : userHandle;
  let clicked = false;
  let submissionId: string | undefined;
  let verdict: string | undefined;

  const observe = async (response: Response) => {
    if (!clicked) return;
    const urlStr = response.url();
    try {
      const url = new URL(urlStr);
      if (!/(^|\.)codechef\.com$/.test(url.hostname)) return;

      if (url.pathname.includes('/api/ide/submit') || url.pathname.includes('/submit')) {
        const solId = url.searchParams.get('solution_id');
        if (solId && /^[1-9]\d{0,18}$/.test(solId)) {
          submissionId ??= solId;
        }
      }

      const viewMatch = url.pathname.match(/(?:viewsolution|submission)\/(\d+)/i);
      if (viewMatch?.[1]) {
        submissionId ??= viewMatch[1];
      }

      const json = await response.json().catch(() => null);
      if (json) {
        const details = responseDetails(json);
        if (details.id && !submissionId) submissionId = details.id;
        if (details.verdict) {
          if (!submissionId || !details.id || details.id === submissionId || urlStr.includes(submissionId)) {
            verdict = details.verdict;
            if (details.id) submissionId = details.id;
          }
        }
      }
    } catch {}
  };

  const onResponse = (response: Response) => { void observe(response).catch(() => undefined); };

  try {
    const url = new URL(problemUrl);
    const match = /(?:\/problems\/|\/submit\/)([a-zA-Z0-9_]+)/i.exec(url.pathname);
    if (!/(^|\.)codechef\.com$/.test(url.hostname) || !match || !match[1]) throw new Error('Invalid CodeChef problem URL');
    const problemCode = match[1].toUpperCase();

    // Fast path: call CodeChef's own /api/ide/submit directly with the logged-in cookies.
    // This renders no page, so the 512MB Render container never hits the MemoryWatch limit.
    const direct = await submitViaCodeChefApi(page, problemCode, code, language, timeoutMs);
    if (direct) return direct;

    const targetUrl = `https://www.codechef.com/problems/${problemCode}?tab=ide`;
    logger.info({ targetUrl, problemCode }, 'Navigating to CodeChef problem IDE page...');

    try {
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      if (response && response.status() >= 400) {
        return {
          ok: false,
          clicked: false,
          kind: response.status() === 401 ? 'signed-out' : response.status() === 403 ? 'blocked' : 'error',
          error: `CodeChef problem page returned HTTP ${response.status()}`,
        };
      }
    } catch (navErr: any) {
      const msg = String(navErr?.message || navErr);
      if (msg.includes('ERR_ABORTED') && page.url().toUpperCase().includes(problemCode)) {
        logger.info({ currentUrl: page.url() }, 'Navigation aborted due to client redirect, but reached problem page');
      } else if (msg.includes('ERR_ABORTED')) {
        await page.waitForTimeout(1000);
        if (!page.url().toUpperCase().includes(problemCode)) {
          logger.warn({ currentUrl: page.url() }, 'Page not on problem code after abort; retrying with commit wait...');
          await page.goto(targetUrl, { waitUntil: 'commit', timeout: 35000 }).catch(() => undefined);
        }
      } else {
        throw navErr;
      }
    }

    if (/\/login(?:[/?#]|$)/.test(page.url())) {
      return { ok: false, clicked: false, kind: 'signed-out', error: 'CodeChef session redirected to login' };
    }

    // Ensure IDE tab is active if present
    try {
      const ideTab = page.locator('[role="tab"], button, div').filter({ hasText: /^IDE$/i }).first();
      const editor = page.locator('.ace_editor, .monaco-editor, [class*="editor"]').first();
      await ideTab.or(editor).waitFor({ state: 'visible', timeout: 25000 }).catch(() => undefined);
      
      if (await ideTab.count() && await ideTab.isVisible().catch(() => false)) {
        const ariaSelected = await ideTab.getAttribute('aria-selected');
        const classList = (await ideTab.getAttribute('class')) || '';
        if (ariaSelected !== 'true' && !classList.includes('active')) {
          logger.info('Activating IDE tab...');
          await ideTab.click({ timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(1500); // Give React time to mount the editor after tab click
        }
      } else {
        logger.warn('IDE tab not found or not visible, proceeding anyway...');
      }
    } catch {}

    logger.info({ language }, 'Selecting programming language...');
    await selectCodeChefLanguage(page, language);

    logger.info('Populating CodeChef code editor...');
    await fillCodeChefSource(page, code);

    page.on('response', onResponse);

    let button = page.locator('#submit_btn, #submitBtn, [data-cy="submit-btn"], [data-cy="submit-button"]').first();
    if (!await button.count() || !await button.isVisible().catch(() => false)) {
      const buttons = page.locator('button').filter({ hasText: /^Submit$/i });
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        if (await b.isVisible().catch(() => false)) {
          button = b;
          break;
        }
      }
      if (!await button.count() || !await button.isVisible().catch(() => false)) {
        button = page.getByRole('button', { name: 'Submit', exact: true }).first();
      }
    }

    await button.waitFor({ state: 'visible', timeout: 15000 });
    if (!await button.isEnabled().catch(() => false)) {
      throw new Error('CodeChef Submit button is disabled');
    }

    await button.scrollIntoViewIfNeeded().catch(() => undefined);
    logger.info('Clicking CodeChef Submit button...');
    clicked = true;
    await button.click();
    logger.info('Submit button clicked; waiting for judge verdict or submission ID...');

    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    while (Date.now() < deadline) {
      if (submissionId && verdict) {
        logger.info({ submissionId, verdict }, 'CodeChef submission verdict received via API');
        return { ok: verdict === 'Accepted', performed: true, clicked, submissionId, verdict };
      }

      // 1. Direct active polling via /api/ide/submit?solution_id=... if we have submissionId
      if (submissionId && !verdict && pollCount % 4 === 0) {
        try {
          const pollData = await page.evaluate(async (solId) => {
            const res = await fetch(`/api/ide/submit?solution_id=${encodeURIComponent(solId)}`).catch(() => null);
            if (!res || !res.ok) return null;
            return await res.json().catch(() => null);
          }, submissionId);
          if (pollData && typeof pollData === 'object') {
            const parsed = responseDetails(pollData);
            if (parsed.verdict) {
              verdict = parsed.verdict;
              logger.info({ submissionId, verdict, data: pollData }, 'CodeChef verdict confirmed via active /api/ide/submit polling');
              return { ok: verdict === 'Accepted', performed: true, clicked, submissionId, verdict };
            }
          }
        } catch {}
      }

      // 2. Read judge result panel in UI:
      const uiVerdictAndId = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        let foundId: string | null = null;
        let foundVerdict: string | null = null;

        const idMatch = bodyText.match(/Submission\s+ID\s*:\s*(\d+)/i) ||
                        document.querySelector('a[href*="viewsolution"]')?.getAttribute('href')?.match(/viewsolution\/(\d+)/i) ||
                        document.querySelector('a[href*="submission"]')?.getAttribute('href')?.match(/submission\/(\d+)/i);
        if (idMatch && idMatch[1]) foundId = idMatch[1];

        const matchVerdict = (t: string): string | null => {
          if (/Correct\s+Answer/i.test(t)) return 'Accepted';
          if (/Wrong\s+Answer/i.test(t)) return 'Wrong Answer';
          if (/Time\s+Limit\s+Exceeded/i.test(t)) return 'Time Limit Exceeded';
          if (/Runtime\s+Error/i.test(t)) return 'Runtime Error';
          if (/Compilation\s+Error/i.test(t)) return 'Compilation Error';
          if (/Partially\s+Solved|Partially\s+Correct/i.test(t)) return 'Partially Correct';
          return null;
        };

        const resultEls = document.querySelectorAll('.verdict-text, [data-verdict], #solution-status, .submission-result, .submission-status, [class*="verdict" i], [class*="result" i], [class*="status" i]');
        for (const el of Array.from(resultEls)) {
          const v = matchVerdict(el.textContent || '');
          if (v) { foundVerdict = v; break; }
        }

        if (!foundVerdict && foundId) {
          foundVerdict = matchVerdict(bodyText);
        }

        return { foundId, foundVerdict };
      }).catch(() => ({ foundId: null, foundVerdict: null }));

      if (uiVerdictAndId.foundId && !submissionId) submissionId = uiVerdictAndId.foundId;
      if (uiVerdictAndId.foundVerdict && !verdict) verdict = uiVerdictAndId.foundVerdict;

      if (submissionId && verdict) {
        logger.info({ submissionId, verdict }, 'CodeChef submission verdict received via UI');
        return { ok: verdict === 'Accepted', performed: true, clicked, submissionId, verdict };
      }

      // 3. Login check
      if (await page.getByText(/please log ?in to submit|login to submit/i).count().catch(() => 0)) {
        return { ok: false, clicked, kind: 'signed-out', error: 'CodeChef requires login before submitting' };
      }

      pollCount++;
      if (pollCount % 20 === 0) {
        logger.info({ elapsedSec: Math.round((Date.now() - (deadline - timeoutMs)) / 1000), submissionId, verdict }, 'Waiting for CodeChef judge verdict...');
      }

      // 4. Fallback check: recent user submissions table fallback every ~6 seconds
      if (pollCount % 24 === 0 && (!submissionId || !verdict)) {
        try {
          const handle = targetHandle || await page.evaluate(() => {
            const m = document.cookie.match(/Drupal\.visitor\.name=([^;]+)/);
            return m && m[1] ? decodeURIComponent(m[1]) : null;
          }).catch(() => null);
          if (handle) {
            const recentHtml = await page.evaluate(async (h) => {
              const res = await fetch(`/recent/user?page=0&user_handle=${encodeURIComponent(h)}`).catch(() => null);
              if (!res || !res.ok) return null;
              const json = await res.json().catch(() => null);
              return json?.content || null;
            }, handle).catch(() => null);
            if (recentHtml) {
              const rows = recentHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
              for (const r of (rows ?? [])) {
                if (r.toUpperCase().includes(problemCode)) {
                  const solMatch = r.match(/viewsolution\/(\d+)/i);
                  if (solMatch?.[1]) submissionId ??= solMatch[1];
                  const vMatch = r.match(/title=['"](accepted|wrong answer|time limit exceeded|compilation error|runtime error)/i);
                  if (vMatch?.[1]) {
                    const norm = normalizeCodeChefVerdict(vMatch[1]);
                    if (norm) verdict = norm;
                  }
                  break;
                }
              }
            }
          }
        } catch {}
      }

      await page.waitForTimeout(250);
    }

    if (submissionId) {
      return { ok: verdict === 'Accepted', performed: true, clicked, submissionId, verdict: verdict ?? 'Submitted' };
    }

    return { ok: false, clicked, submissionId, verdict: 'UNKNOWN', error: 'CodeChef did not return a confirmed submission ID and terminal verdict. The submit click was not retried.' };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CodeChef submitOnCodeChefPage failed');
    return { ok: false, clicked, submissionId, kind: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    page.off('response', onResponse);
  }
}

export async function submitToCodeChef(state: CodeChefState, problemUrl: string, code: string, language = 'cpp', userHandle?: string): Promise<CodeChefSubmitResult> {
  return withCodeChefPage(state, page => submitOnCodeChefPage(page, problemUrl, code, language, 90000, userHandle));
}

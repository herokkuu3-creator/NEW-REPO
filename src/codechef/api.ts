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
  const text = value.trim().replace(/\s+/g, ' ').toLowerCase();
  const names: Record<string, string> = {
    ac: 'Accepted', accepted: 'Accepted', 'correct answer': 'Accepted',
    wa: 'Wrong Answer', 'wrong answer': 'Wrong Answer',
    tle: 'Time Limit Exceeded', 'time limit exceeded': 'Time Limit Exceeded',
    ce: 'Compilation Error', 'compilation error': 'Compilation Error',
    re: 'Runtime Error', rte: 'Runtime Error', 'runtime error': 'Runtime Error',
    'partially correct': 'Partially Correct', 'internal error': 'Internal Error',
  };
  return names[text] ?? null;
}

function responseDetails(value: unknown, depth = 0): { id?: string; verdict?: string } {
  if (!value || typeof value !== 'object' || depth > 5) return {};
  const object = value as Record<string, unknown>;
  const idValue = object.submission_id ?? object.submissionId ?? object.solution_id;
  const id = (typeof idValue === 'number' || typeof idValue === 'string') && /^[1-9]\d{0,18}$/.test(String(idValue)) ? String(idValue) : undefined;
  const verdict = normalizeCodeChefVerdict(object.verdict ?? object.result ?? object.status) ?? undefined;
  const child = responseDetails(object.data ?? object.result, depth + 1);
  return { id: id ?? child.id, verdict: verdict ?? child.verdict };
}

export async function selectCodeChefLanguage(page: Page, language: string): Promise<void> {
  if (!/^(cpp|c\+\+(?:17|20|23)?)$/i.test(language)) throw new Error(`Unsupported CodeChef source language: ${language}`);
  const native = page.locator('select').first();
  if (await native.count()) {
    const options = await native.locator('option').evaluateAll(nodes => nodes.map(el => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })));
    const chosen = options.find(el => /C\+\+17/i.test(el.text)) ?? options.find(el => /C\+\+/i.test(el.text));
    if (!chosen) throw new Error('CodeChef C++ language option was not found');
    await native.selectOption(chosen.value);
    return;
  }
  const dropdown = page.locator('#language-select, [role="combobox"]').first();
  await dropdown.click({ timeout: 15000 });
  const options = page.getByRole('option');
  const labels = await options.allTextContents();
  const index = labels.findIndex(text => /^C\+\+(?:17|20|23)?(?:\s|$)/i.test(text.trim()));
  if (index < 0) throw new Error('CodeChef C++ language option was not found');
  await options.nth(index).click();
}

export async function fillCodeChefSource(page: Page, code: string): Promise<void> {
  await page.locator('.ace_editor, .monaco-editor').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate(content => {
    const app = window as unknown as {
      ace?: { edit: (element: Element) => { setValue: (text: string, cursor?: number) => void; getValue: () => string } };
      monaco?: { editor: { getModels: () => Array<{ setValue: (text: string) => void; getValue: () => string }> } };
    };
    const aceElement = document.querySelector('.ace_editor');
    const editor = aceElement && app.ace ? app.ace.edit(aceElement) : app.monaco?.editor.getModels()[0];
    if (!editor) throw new Error('CodeChef editor API is not ready');
    editor.setValue(content);
    if (editor.getValue() !== content) throw new Error('CodeChef editor did not retain the source');
  }, code);
}

export async function submitOnCodeChefPage(page: Page, problemUrl: string, code: string, language = 'cpp', timeoutMs = 90000): Promise<CodeChefSubmitResult> {
  let clicked = false;
  let submissionId: string | undefined;
  let verdict: string | undefined;
  const observe = async (response: Response) => {
    if (!clicked) return;
    const url = new URL(response.url());
    if (!/(^|\.)codechef\.com$/.test(url.hostname) || !/submit|submission|result|status/i.test(url.pathname)) return;
    const details = responseDetails(await response.json().catch(() => null));
    // Anchor the judge result to the ID returned by this submission's POST.
    if (response.request().method() === 'POST' && details.id) submissionId ??= details.id;
    if (submissionId && details.verdict && (details.id === submissionId || url.href.includes(submissionId))) verdict = details.verdict;
  };
  const onResponse = (response: Response) => { void observe(response).catch(() => undefined); };
  try {
    const url = new URL(problemUrl);
    const match = /^\/(?:[^/]+\/)?problems\/([a-z0-9_]+)\/?$/i.exec(url.pathname);
    if (!/(^|\.)codechef\.com$/.test(url.hostname) || !match) throw new Error('Invalid CodeChef problem URL');
    const submitUrl = `https://www.codechef.com/submit/${match[1]}`;
    logger.info({ submitUrl }, 'Navigating to CodeChef submit page...');
    const response = await page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) return { ok: false, clicked: false, kind: response.status() === 401 ? 'signed-out' : response.status() === 403 ? 'blocked' : 'error', error: `CodeChef submit page returned HTTP ${response.status()}` };
    if (/\/login(?:[/?#]|$)/.test(page.url())) return { ok: false, clicked: false, kind: 'signed-out', error: 'CodeChef session redirected to login' };
    logger.info({ language }, 'Selecting programming language...');
    await selectCodeChefLanguage(page, language);
    logger.info('Populating CodeChef code editor...');
    await fillCodeChefSource(page, code);
    page.on('response', onResponse);
    const control = page.locator('#submit_btn, #submitBtn').first();
    const button = await control.count() ? control : page.getByRole('button', { name: 'Submit', exact: true });
    if (!await button.isEnabled()) throw new Error('CodeChef Submit is disabled');
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
      // Read only the judge's result panel, never the problem text/editor HTML.
      const result = page.locator('.verdict-text, [data-verdict], #solution-status, .submission-result').first();
      if (await result.count()) {
        const text = await result.innerText().catch(() => '');
        const terminal = normalizeCodeChefVerdict(text);
        if (submissionId && terminal) {
          logger.info({ submissionId, verdict: terminal }, 'CodeChef submission verdict received via UI');
          return { ok: terminal === 'Accepted', performed: true, clicked, submissionId, verdict: terminal };
        }
      }
      if (await page.getByText(/please log ?in to submit|login to submit/i).count()) {
        return { ok: false, clicked, kind: 'signed-out', error: 'CodeChef requires login before submitting' };
      }
      pollCount++;
      if (pollCount % 20 === 0) {
        logger.info({ elapsedSec: Math.round((Date.now() - (deadline - timeoutMs)) / 1000), submissionId }, 'Waiting for CodeChef judge verdict...');
      }
      await page.waitForTimeout(250);
    }
    return { ok: false, clicked, submissionId, verdict: 'UNKNOWN', error: 'CodeChef did not return a confirmed submission ID and terminal verdict. The submit click was not retried.' };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CodeChef submitOnCodeChefPage failed');
    return { ok: false, clicked, submissionId, kind: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally { page.off('response', onResponse); }
}

export async function submitToCodeChef(state: CodeChefState, problemUrl: string, code: string, language = 'cpp'): Promise<CodeChefSubmitResult> {
  return withCodeChefPage(state, page => submitOnCodeChefPage(page, problemUrl, code, language));
}

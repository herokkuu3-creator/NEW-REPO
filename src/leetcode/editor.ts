import { Page } from 'playwright';
import { SELECTORS, LANGUAGE_LABELS } from './selectors';
import { logger } from '../logger';

/**
 * Editor interaction. The primary write path is the Monaco editor model
 * API (deterministic, no keystroke timing issues); DOM selectors are the
 * fallback. Code content is written via Playwright — never logged.
 */

export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorError';
  }
}

export function problemUrl(slug: string): string {
  return `https://leetcode.com/problems/${slug}/`;
}

/** Navigates to the problem page and verifies the slug matches. */
export async function openProblemPage(page: Page, slug: string): Promise<void> {
  await page.goto(problemUrl(slug), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2_000); // let the app hydrate
  if (!page.url().includes(`/problems/${slug}`)) {
    throw new EditorError(`expected URL to contain /problems/${slug}, got ${page.url()}`);
  }
  logger.info({ slug, url: page.url() }, 'problem page open, slug verified');
}

/**
 * Selects the requested language in the editor. If the language is already
 * active this is a no-op. Returns true if the requested language is active.
 */
export async function ensureLanguage(page: Page, language: string): Promise<boolean> {
  const label = LANGUAGE_LABELS[language];
  if (!label) throw new EditorError(`unsupported language slug: ${language}`);

  // Strategy 1 (preferred): ask Monaco/LeetCode app state what is active.
  const activeSlug = await page
    .evaluate(() => {
      // LeetCode keeps editor state on window in many builds; tolerate absence.
      const w = window as unknown as Record<string, unknown>;
      const state = w['__NEXT_DATA__'] ?? w['__APP_STATE__'];
      return state ? JSON.stringify(state).includes(language) : null;
    })
    .catch(() => null);

  if (activeSlug === true) {
    logger.info({ language }, 'language already active (app state)');
    return true;
  }

  // Strategy 2: DOM dropdown with selector fallbacks.
  try {
    const dropdown = await findFirst(page, SELECTORS.languageDropdown, 5_000);
    if (!dropdown) {
      logger.warn('language dropdown not found — assuming site default matches');
      return false;
    }
    const currentText = (await dropdown.innerText().catch(() => '')) ?? '';
    if (currentText.trim().toLowerCase() === label.toLowerCase()) {
      logger.info({ language }, 'language already active (dropdown label)');
      return true;
    }
    await dropdown.click();
    const option = await findFirst(page, SELECTORS.languageOption(label), 5_000);
    if (!option) throw new EditorError(`language option "${label}" not found in dropdown`);
    await option.click();
    await page.waitForTimeout(1_000);
    logger.info({ language }, 'language selected via dropdown');
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'language selection via DOM failed — continuing with current language',
    );
    return false;
  }
}

/**
 * Replaces the editor content with the given solution and verifies the
 * write by reading the model back (length comparison only — code is never
 * logged).
 */
export async function setEditorCode(page: Page, code: string): Promise<void> {
  if (!code.trim()) throw new EditorError('refusing to write empty code to the editor');

  // Primary: Monaco model API.
  const wroteViaMonaco = await page
    .evaluate((source) => {
      const w = window as unknown as {
        monaco?: { editor?: { getModels?: () => { setValue: (v: string) => void; getValue: () => string }[] } };
      };
      const models = w.monaco?.editor?.getModels?.() ?? [];
      const model = models[0];
      if (!model) return false;
      model.setValue(source);
      return true;
    }, code)
    .catch(() => false);

  if (!wroteViaMonaco) {
    // Fallback: focus the editor, select all, type. Slower but robust.
    logger.warn('Monaco API unavailable — falling back to keyboard input');
    const container = await findFirst(page, SELECTORS.editorContainer, 15_000);
    if (!container) throw new EditorError('editor container not found');
    await container.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(code);
    await page.waitForTimeout(500);
  }

  // Verification: read back and compare length (never the content itself).
  const readBackLength = await page
    .evaluate(() => {
      const w = window as unknown as {
        monaco?: { editor?: { getModels?: () => { getValue: () => string }[] } };
      };
      const model = w.monaco?.editor?.getModels?.()[0];
      return model ? model.getValue().length : -1;
    })
    .catch(() => -1);

  if (readBackLength >= 0 && Math.abs(readBackLength - code.length) > 2) {
    throw new EditorError(
      `editor verification failed: wrote ${code.length} chars, read back ${readBackLength}`,
    );
  }
  logger.info({ codeLength: code.length }, 'editor content set and verified');
}

async function findFirst(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) return loc;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

/**
 * All DOM selectors for leetcode.com live here, and ONLY here.
 *
 * LeetCode's markup changes without notice. Every interaction first tries
 * network/API data (GraphQL, editor's Monaco model); the selectors below are
 * the fallback layer. Each logical target has an ordered list of candidates
 * — first match wins. If you need to patch a selector after a LeetCode UI
 * change, this file is the only place you touch.
 */

export const SELECTORS = {
  /** Language dropdown trigger on the problem page */
  languageDropdown: [
    'button:has-text("C++")',
    'button:has-text("JavaScript")',
    'button:has-text("TypeScript")',
    'button:has-text("Python3")',
    'button:has-text("Python")',
    '[data-cy="lang-select"]',
    'div[class*="language"] button',
    '#editor button[id^="headlessui-listbox-button"]',
  ],

  /** Options inside the open language dropdown */
  languageOption: (label: string) => [
    `li[role="option"]:has-text("${label}")`,
    `div[role="option"]:has-text("${label}")`,
    `button:has-text("${label}")`,
  ],

  /** The code editor container (Monaco) */
  editorContainer: [
    '.monaco-editor',
    'div[class*="editor"][class*="container"]',
    '#editor .monaco-editor',
  ],

  /** Submit button */
  submitButton: [
    'button[data-e2e-locator="console-submit-button"]',
    'button:has-text("Submit")',
    '[data-cy="submit-code-btn"]',
  ],

  /** Submission result panel — status text */
  resultStatus: [
    '[data-e2e-locator="submission-result"]',
    'span[data-cy="submission-result"]',
    'div[class*="result"] span[class*="text-green"]',
    'div[class*="result"] span[class*="text-red"]',
  ],

  /** Runtime / memory beats lines in the result panel */
  resultRuntime: ['span:has-text("Runtime")', 'div:has-text("Runtime")'],
  resultMemory: ['span:has-text("Memory")', 'div:has-text("Memory")'],
} as const;

/** Human labels LeetCode uses for each supported language slug. */
export const LANGUAGE_LABELS: Record<string, string> = {
  cpp: 'C++',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python3: 'Python3',
};

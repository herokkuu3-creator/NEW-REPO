import { chromium } from 'playwright';
import { logger } from '../logger';

export interface CodeChefSubmitResult {
  ok: boolean;
  submissionId?: string;
  verdict?: string;
  error?: string;
}

export async function submitToCodeChef(
  storageState: any,
  problemUrl: string,
  code: string,
  language: string = 'C++17' // Adjust based on CodeChef's dropdown if necessary
): Promise<CodeChefSubmitResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  try {
    logger.info({ problemUrl }, 'Navigating to CodeChef problem page');
    await page.goto(problemUrl, { waitUntil: 'networkidle' });

    // Wait for the submit button or IDE to load. CodeChef has a specific IDE URL.
    // Normally, the submit URL is https://www.codechef.com/submit/<problemCode>
    const match = problemUrl.match(/codechef\.com\/problems\/([A-Za-z0-9_]+)/i);
    if (!match) {
      throw new Error('Invalid problem URL');
    }
    const problemCode = match[1];
    
    await page.goto(`https://www.codechef.com/submit/${problemCode}`, { waitUntil: 'networkidle' });

    // Ensure the editor is ready
    await page.waitForSelector('.monaco-editor', { timeout: 30000 });

    // Click on the editor and paste the code
    await page.click('.monaco-editor');
    await page.keyboard.down('Control'); // Or Meta for Mac, assuming Windows/Linux container here
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Instead of typing which is slow, we can use clipboard or evaluate to set value if possible, 
    // but Playwright can type fast or we can paste.
    // For Monaco, typing line by line or pasting is needed. 
    // Let's inject into the clipboard and paste, or use evaluate.
    await page.evaluate((codeContent) => {
      // Find the Monaco model and set its value directly
      const models = (window as any).monaco.editor.getModels();
      if (models && models.length > 0) {
        models[0].setValue(codeContent);
      }
    }, code);

    // Click the submit button
    const submitBtn = await page.$('button:has-text("Submit")');
    if (!submitBtn) {
       // Look for the specific submit button class or id if text fails
       await page.click('#submitBtn'); // Fallback id, adjust if CodeChef changes
    } else {
       await submitBtn.click();
    }

    // Wait for verdict
    await page.waitForSelector('.verdict-text, .toaster', { timeout: 60000 }).catch(() => {});
    
    // Try to extract the verdict
    const verdictEl = await page.$('.verdict-text');
    let verdict = 'UNKNOWN';
    if (verdictEl) {
      verdict = await verdictEl.innerText();
    } else {
      // If no verdict text, look for common notification
      const html = await page.content();
      if (html.includes('Correct Answer')) verdict = 'Accepted';
      else if (html.includes('Wrong Answer')) verdict = 'Wrong Answer';
      else if (html.includes('Time Limit Exceeded')) verdict = 'TLE';
      else if (html.includes('Compilation Error')) verdict = 'Compilation Error';
    }

    return {
      ok: verdict.toLowerCase().includes('accepted') || verdict.toLowerCase().includes('correct'),
      verdict: verdict.trim()
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CodeChef submission failed');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    await browser.close();
  }
}

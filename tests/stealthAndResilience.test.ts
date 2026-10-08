import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import {
  applyStealthScripts,
  getRandomDesktopViewport,
  STEALTH_CHROMIUM_ARGS,
  STANDARD_DESKTOP_VIEWPORTS,
  simulateHumanMouseMove,
} from '../src/browser/stealth';
import { getCodeforcesPacingDelayMs } from '../src/codeforces/worker';

describe('Stealth and Anti-Detection Module', () => {
  it('includes required Chromium evasion args', () => {
    expect(STEALTH_CHROMIUM_ARGS).toContain('--disable-blink-features=AutomationControlled');
    expect(STEALTH_CHROMIUM_ARGS).toContain('--no-sandbox');
  });

  it('provides standard desktop viewports', () => {
    const vp = getRandomDesktopViewport();
    expect(vp.width).toBeGreaterThanOrEqual(1280);
    expect(vp.height).toBeGreaterThanOrEqual(768);
    expect(STANDARD_DESKTOP_VIEWPORTS).toContainEqual(vp);
  });

  it('generates randomized pacing delay with jitter', () => {
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) {
      const delay = getCodeforcesPacingDelayMs();
      expect(delay).toBeGreaterThanOrEqual(25000);
      delays.push(delay);
    }
    const unique = new Set(delays);
    // Across 20 samples, jitter should produce variation
    expect(unique.size).toBeGreaterThan(1);
  });

  it('masks automation indicators on page load', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: STEALTH_CHROMIUM_ARGS,
    });
    try {
      const context = await browser.newContext({
        viewport: getRandomDesktopViewport(),
      });
      await applyStealthScripts(context);
      const page = await context.newPage();
      await page.setContent('<html><body><h1>Test</h1></body></html>');

      const evaluation = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl');
        const gl2 = canvas.getContext('webgl2');
        const dbgRender = gl?.getExtension('WEBGL_debug_renderer_info');
        return {
          webdriver: (navigator as any).webdriver,
          hasChrome: !!(window as any).chrome,
          chromeRuntime: typeof (window as any).chrome?.runtime,
          languages: navigator.languages,
          pluginsLength: navigator.plugins.length,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: (navigator as any).deviceMemory,
          webglRenderer: dbgRender ? gl?.getParameter(dbgRender.UNMASKED_RENDERER_WEBGL) : null,
          webgl2Renderer: dbgRender ? gl2?.getParameter(dbgRender.UNMASKED_RENDERER_WEBGL) : null,
          devicePixelRatio: window.devicePixelRatio,
        };
      });

      expect(evaluation.webdriver).toBeUndefined();
      expect(evaluation.hasChrome).toBe(true);
      expect(evaluation.chromeRuntime).toBe('object');
      expect(evaluation.languages).toContain('en-US');
      expect(evaluation.pluginsLength).toBeGreaterThan(0);
      expect(evaluation.platform).toBe('Win32');
      expect(evaluation.hardwareConcurrency).toBe(8);
      expect(evaluation.deviceMemory).toBe(8);
      expect(evaluation.webglRenderer).toContain('ANGLE');
      expect(evaluation.devicePixelRatio).toBe(1);

      // Verify mouse simulation
      await expect(simulateHumanMouseMove(page, 300, 200, 4)).resolves.toBeUndefined();

      await context.close();
    } finally {
      await browser.close();
    }
  });
});

import type { BrowserContext, Page } from 'playwright';

/**
 * Anti-fingerprinting and stealth emulation layer.
 * Neutralizes bot automation detection flags (such as navigator.webdriver,
 * headless chrome missing runtime, abnormal window geometry, and zero-entropy DOM actions).
 */

export const STEALTH_CHROMIUM_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--disable-component-update',
  '--safebrowsing-disable-auto-update',
  '--disable-sync',
  '--disable-default-apps',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--metrics-recording-only',
  '--no-pings',
  '--disable-features=Translate,OptimizationHints,MediaRouter',
];

export const STANDARD_DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
];

export function getRandomDesktopViewport(): { width: number; height: number } {
  const index = Math.floor(Math.random() * STANDARD_DESKTOP_VIEWPORTS.length);
  return STANDARD_DESKTOP_VIEWPORTS[index] ?? { width: 1366, height: 768 };
}

/**
 * Injects scripts before any page scripts execute to mask automation indicators.
 * Respects browser engine (Firefox vs Chromium) to prevent conflicting fingerprints.
 */
export async function applyStealthScripts(
  context: BrowserContext,
  engine: 'chromium' | 'firefox' = 'chromium',
): Promise<void> {
  await context.addInitScript(
    ({ engine }: { engine: 'chromium' | 'firefox' }) => {
      // 1. Mask navigator.webdriver on both navigator and Navigator.prototype with native getter signature
      try {
        if (Object.prototype.hasOwnProperty.call(navigator, 'webdriver')) {
          delete (navigator as unknown as Record<string, unknown>).webdriver;
        }
        const proto = Object.getPrototypeOf(navigator) || Navigator.prototype;
        const getter = function webdriver() { return undefined; };
        try {
          Object.defineProperty(getter, 'name', { value: 'get webdriver', configurable: true });
          Object.defineProperty(getter, 'toString', { value: () => 'function get webdriver() { [native code] }', configurable: true });
        } catch {}
        if (proto) {
          Object.defineProperty(proto, 'webdriver', {
            get: getter,
            configurable: true,
            enumerable: true,
          });
        }
        Object.defineProperty(navigator, 'webdriver', {
          get: getter,
          configurable: true,
          enumerable: true,
        });
      } catch {}

      // 2. Mock chrome runtime object (Chromium only — real Firefox does NOT have window.chrome)
      if (engine === 'chromium') {
        try {
          const win = window as unknown as Record<string, unknown>;
          if (!win.chrome) {
            win.chrome = {
              app: {
                isInstalled: false,
                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
              },
              runtime: {
                OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
              },
              loadTimes: () => {
                const now = Date.now() / 1000;
                return {
                  requestTime: now - 0.45,
                  startLoadTime: now - 0.4,
                  commitLoadTime: now - 0.25,
                  finishDocumentLoadTime: now - 0.1,
                  firstPaintTime: now - 0.08,
                  finishLoadTime: now,
                  wasFetchedViaSpdy: true,
                  wasNpnNegotiated: true,
                  npnNegotiatedProtocol: 'h2',
                  navigationType: 'Other',
                };
              },
              csi: () => {
                const now = Date.now();
                return {
                  onloadT: now,
                  pageT: 450,
                  startE: now - 450,
                  tran: 15,
                };
              },
            };
          }
        } catch {}
      }

      // 3. Realistic navigator.languages
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });
      } catch {}

      // 4. Realistic navigator.plugins (Chromium only)
      if (engine === 'chromium') {
        try {
          if (!navigator.plugins || navigator.plugins.length === 0) {
            Object.defineProperty(navigator, 'plugins', {
              get: () => [
                { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              ],
              configurable: true,
            });
          }
        } catch {}
      }

      // 5. Normal permissions query
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const originalQuery = navigator.permissions.query;
          navigator.permissions.query = (parameters: unknown) => {
            const p = parameters as { name?: string } | undefined;
            if (p && p.name === 'notifications') {
              const perm = typeof Notification !== 'undefined' ? Notification.permission : 'default';
              return Promise.resolve({ state: perm === 'granted' ? 'granted' : 'default' } as PermissionStatus);
            }
            return originalQuery.call(navigator.permissions, parameters as PermissionDescriptor);
          };
        }
      } catch {}

      // 6. Platform and User-Agent Data consistency
      try {
        Object.defineProperty(navigator, 'platform', {
          get: () => 'Win32',
          configurable: true,
        });
        if (engine === 'chromium') {
          const nav = navigator as unknown as {
            userAgentData?: {
              platform?: string;
              getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
            };
          };
          if (nav.userAgentData) {
            Object.defineProperty(nav.userAgentData, 'platform', {
              get: () => 'Windows',
              configurable: true,
            });
            const origGetHEV = nav.userAgentData.getHighEntropyValues;
            if (typeof origGetHEV === 'function') {
              nav.userAgentData.getHighEntropyValues = async function (hints: string[]) {
                const res = await origGetHEV.call(this, hints);
                return {
                  ...res,
                  platform: 'Windows',
                  platformVersion: '15.0.0',
                  architecture: 'x86',
                  bitness: '64',
                  model: '',
                  mobile: false,
                };
              };
            }
          }
        }
      } catch {}

      // 7. WebGL and WebGL2 vendor masking (avoid SwiftShader / llvmpipe software rendering identifiers)
      try {
        if (typeof WebGLRenderingContext !== 'undefined') {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
            if (parameter === 37445) return 'Google Inc. (Intel)';
            if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter.call(this, parameter);
          };
          Object.defineProperty(WebGLRenderingContext.prototype.getParameter, 'toString', {
            value: () => 'function getParameter() { [native code] }',
          });
        }
        if (typeof WebGL2RenderingContext !== 'undefined') {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
            if (parameter === 37445) return 'Google Inc. (Intel)';
            if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter2.call(this, parameter);
          };
          Object.defineProperty(WebGL2RenderingContext.prototype.getParameter, 'toString', {
            value: () => 'function getParameter() { [native code] }',
          });
        }
      } catch {}

      // 8. Realistic hardware concurrency, device memory, and display metrics
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
        Object.defineProperty(screen, 'availWidth', { get: () => screen.width, configurable: true });
        Object.defineProperty(screen, 'availHeight', { get: () => screen.height, configurable: true });
        if (window.outerWidth === 0) {
          Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
        }
        if (window.outerHeight === 0) {
          Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight, configurable: true });
        }
        Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
      } catch {}

      // 9. Media devices mock (real desktop browsers have microphones/speakers)
      try {
        if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
          const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
          navigator.mediaDevices.enumerateDevices = async () => {
            const devs = await origEnum().catch(() => []);
            if (devs && devs.length > 0) return devs;
            return [
              { deviceId: 'default', kind: 'audioinput', label: 'Default - Microphone (Realtek(R) Audio)', groupId: 'group1' },
              { deviceId: 'default', kind: 'audiooutput', label: 'Default - Speakers (Realtek(R) Audio)', groupId: 'group1' },
            ] as unknown as MediaDeviceInfo[];
          };
        }
      } catch {}

      // 10. Strip automation & CDP leakage flags from global scope
      try {
        const win = window as any;
        ['cdc_adoQpoasnfa76pfcZLmcfl_Array', 'cdc_adoQpoasnfa76pfcZLmcfl_Promise', 'cdc_adoQpoasnfa76pfcZLmcfl_Symbol', '__nightmare', 'callPhantom', '_phantom'].forEach((prop) => {
          try { delete win[prop]; } catch {}
        });
      } catch {}

      // 11. Intercept window.turnstile explicitly and implicitly to harvest widget parameters and callbacks
      try {
        const win = window as any;
        let _turnstileInstance = win.turnstile;
        const wrapTurnstile = (t: any) => {
          if (!t || typeof t.render !== 'function' || t._isStealthWrapped) return t;
          const origRender = t.render;
          t.render = function (container: any, params: any) {
            try {
              if (params) {
                win.__turnstileSitekey = params.sitekey || win.__turnstileSitekey;
                win.__turnstileCallback = params.callback || win.__turnstileCallback;
                win.__turnstileAction = params.action || win.__turnstileAction;
                win.__turnstileCdata = params.cdata || win.__turnstileCdata;
              }
            } catch {}
            return origRender.apply(this, arguments);
          };
          t._isStealthWrapped = true;
          return t;
        };
        if (_turnstileInstance) {
          wrapTurnstile(_turnstileInstance);
        }
        Object.defineProperty(win, 'turnstile', {
          get() { return _turnstileInstance; },
          set(val) { _turnstileInstance = wrapTurnstile(val); },
          configurable: true,
          enumerable: true,
        });
      } catch {}
    },
    { engine },
  ).catch(() => undefined);
}

/**
 * Simulates natural human mouse movement using a Cubic Bézier curve
 * with biomechanical easing and sub-pixel micro-jitter.
 */
export async function simulateHumanMouseMove(
  page: Page,
  targetX: number,
  targetY: number,
  steps?: number,
): Promise<void> {
  try {
    const lastPos = (page as unknown as { _lastHumanMousePos?: { x: number; y: number } })._lastHumanMousePos ?? {
      x: Math.round(150 + Math.random() * 200),
      y: Math.round(150 + Math.random() * 200),
    };
    const startX = lastPos.x;
    const startY = lastPos.y;

    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 2) {
      await page.mouse.move(targetX, targetY).catch(() => {});
      (page as unknown as { _lastHumanMousePos: { x: number; y: number } })._lastHumanMousePos = { x: targetX, y: targetY };
      return;
    }

    const numSteps = steps ?? Math.max(16, Math.min(45, Math.round(distance / 14)));

    // Generate two cubic Bezier control points offset perpendicularly from the chord
    const angle = Math.atan2(dy, dx);
    const perpAngle = angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
    const curveDeviation = Math.min(50, distance * 0.25) * (0.6 + Math.random() * 0.8);

    const cp1x = startX + dx * 0.25 + Math.cos(perpAngle) * curveDeviation * (0.5 + Math.random() * 0.5);
    const cp1y = startY + dy * 0.25 + Math.sin(perpAngle) * curveDeviation * (0.5 + Math.random() * 0.5);

    const cp2x = startX + dx * 0.75 + Math.cos(perpAngle) * curveDeviation * (0.3 + Math.random() * 0.7);
    const cp2y = startY + dy * 0.75 + Math.sin(perpAngle) * curveDeviation * (0.3 + Math.random() * 0.7);

    for (let i = 1; i <= numSteps; i++) {
      const u = i / numSteps;
      // Smoothstep easing: 3u^2 - 2u^3
      const t = u * u * (3 - 2 * u);

      const oneMinusT = 1 - t;
      const b0 = oneMinusT * oneMinusT * oneMinusT;
      const b1 = 3 * oneMinusT * oneMinusT * t;
      const b2 = 3 * oneMinusT * t * t;
      const b3 = t * t * t;

      // Physiological tremor diminishes near target
      const tremor = (1 - u) * 1.5;
      const jitterX = (Math.random() - 0.5) * tremor;
      const jitterY = (Math.random() - 0.5) * tremor;

      const currentX = Math.round(b0 * startX + b1 * cp1x + b2 * cp2x + b3 * targetX + jitterX);
      const currentY = Math.round(b0 * startY + b1 * cp1y + b2 * cp2y + b3 * targetY + jitterY);

      await page.mouse.move(currentX, currentY).catch(() => {});

      if (numSteps > 1) {
        const delay = 6 + Math.floor(Math.random() * 10);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    await page.mouse.move(targetX, targetY).catch(() => {});
    (page as unknown as { _lastHumanMousePos: { x: number; y: number } })._lastHumanMousePos = { x: targetX, y: targetY };
  } catch {
    // Non-fatal if element or frame detaches
  }
}

/**
 * Executes a human-like click with realistic movement trajectory,
 * perceptual dwell time, contact hold duration, and post-click settle.
 */
export async function simulateHumanClick(
  page: Page,
  targetX: number,
  targetY: number,
  options: { moveSteps?: number; dwellMs?: number; holdMs?: number } = {},
): Promise<void> {
  const dwellMs = options.dwellMs ?? (60 + Math.random() * 80);
  const holdMs = options.holdMs ?? (60 + Math.random() * 50);

  // 1. Move mouse to target with natural Bezier curve
  await simulateHumanMouseMove(page, targetX, targetY, options.moveSteps);

  // 2. Pre-click hover dwell time
  if (dwellMs > 0) {
    await new Promise((r) => setTimeout(r, dwellMs));
  }

  // 3. Mouse down
  await page.mouse.down().catch(() => {});

  // 4. Biological contact hold duration
  if (holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
  }

  // 5. Mouse up
  await page.mouse.up().catch(() => {});

  // 6. Post-click settling pause
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
}

/**
 * Detects Cloudflare Turnstile challenge iframes and performs a human-like
 * cursor approach and click on the verification checkbox.
 */
export async function interactWithTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    const iframeLocator = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]').first();
    const count = await iframeLocator.count().catch(() => 0);
    if (count === 0) return false;

    const isVisible = await iframeLocator.isVisible().catch(() => false);
    if (!isVisible) return false;

    const box = await iframeLocator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return false;

    // 1. Try to obtain exact checkbox coordinates inside the frame
    let targetX: number | undefined;
    let targetY: number | undefined;

    if (typeof page.frameLocator === 'function') {
      try {
        const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]').first();
        const cb = frame.locator('input[type="checkbox"], .ctp-checkbox-container, .mark, #challenge-stage, #cf-stage').first();
        if ((await cb.count().catch(() => 0)) > 0) {
          const cbBox = await cb.boundingBox().catch(() => null);
          if (cbBox && cbBox.width > 0 && cbBox.height > 0) {
            targetX = Math.round(cbBox.x + cbBox.width / 2 + (Math.random() - 0.5) * 4);
            targetY = Math.round(cbBox.y + cbBox.height / 2 + (Math.random() - 0.5) * 4);
          }
        }
      } catch {}
    }

    // 2. If internal bounding box unavailable, compute from widget geometry
    if (targetX === undefined || targetY === undefined) {
      if (box.width < 200) {
        // Compact Turnstile layout (150x140)
        targetX = Math.round(box.x + box.width / 2 + (Math.random() - 0.5) * 6);
        targetY = Math.round(box.y + 35 + (Math.random() - 0.5) * 6);
      } else {
        // Standard Turnstile layout (300x65 or responsive)
        // Checkbox is centered at ~28px from left edge and vertically centered
        targetX = Math.round(box.x + 28 + (Math.random() - 0.5) * 4);
        targetY = Math.round(box.y + box.height / 2 + (Math.random() - 0.5) * 4);
      }
    }

    await simulateHumanClick(page, targetX, targetY, {
      dwellMs: 100 + Math.random() * 80,
      holdMs: 65 + Math.random() * 45,
    });

    // 3. Resilient backup click inside frame locator if available
    if (typeof page.frameLocator === 'function') {
      try {
        const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]').first();
        const cb = frame.locator('input[type="checkbox"], .ctp-checkbox-container, .mark, #challenge-stage, #cf-stage').first();
        if ((await cb.count().catch(() => 0)) > 0) {
          await cb.click({ force: true, timeout: 1500 }).catch(() => {});
        }
      } catch {}
    }

    return true;
  } catch {
    return false;
  }
}

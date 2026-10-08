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
 */
export async function applyStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // 1. Mask navigator.webdriver
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } catch {}

    // 2. Mock chrome runtime object
    try {
      const win = window as any;
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

    // 3. Realistic navigator.languages
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    } catch {}

    // 4. Realistic navigator.plugins
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

    // 5. Normal permissions query
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = (parameters: any) =>
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission === 'granted' ? 'granted' : 'default' } as any)
            : originalQuery.call(navigator.permissions, parameters);
      }
    } catch {}

    // 6. Platform and User-Agent Data consistency (prevent Linux runner leaking Windows UA mismatch)
    try {
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
        configurable: true,
      });
      const nav = navigator as any;
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
    } catch {}

    // 7. WebGL and WebGL2 vendor masking (avoid SwiftShader / llvmpipe software rendering identifiers)
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return 'Google Inc. (Intel)';
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameter.call(this, parameter);
      };
      Object.defineProperty(WebGLRenderingContext.prototype.getParameter, 'toString', {
        value: () => 'function getParameter() { [native code] }',
      });
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
          ] as any;
        };
      }
    } catch {}
  }).catch(() => undefined);
}

/**
 * Simulates natural human mouse movement with multi-point interpolation and slight jitter.
 */
export async function simulateHumanMouseMove(
  page: Page,
  targetX: number,
  targetY: number,
  steps = 8,
): Promise<void> {
  try {
    const lastPos = (page as any)._lastHumanMousePos ?? { x: 150, y: 150 };
    const startX = lastPos.x;
    const startY = lastPos.y;

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      // Introduce slight curved trajectory
      const curve = Math.sin(progress * Math.PI) * 12;
      const jitterX = (Math.random() - 0.5) * 3;
      const jitterY = (Math.random() - 0.5) * 3;

      const currentX = Math.round(startX + (targetX - startX) * progress + jitterX);
      const currentY = Math.round(startY + (targetY - startY) * progress + curve + jitterY);

      await page.mouse.move(currentX, currentY).catch(() => {});
      if (steps > 1) {
        await new Promise((r) => setTimeout(r, 8 + Math.floor(Math.random() * 12)));
      }
    }

    (page as any)._lastHumanMousePos = { x: targetX, y: targetY };
  } catch {
    // Non-fatal if element or frame detaches
  }
}

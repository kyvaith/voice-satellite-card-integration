/**
 * Tiny startup breadcrumbs for diagnosing native WebGPU/WebView crashes.
 *
 * VWW runs in a Worker, where localStorage is unavailable.  We post the
 * breadcrumb to the main-thread proxy, which persists it before the next
 * risky startup step.  The async yield gives that message a chance to move
 * before shader compilation or dispatch enters native code.
 */

export const VWW_BREADCRUMB_MESSAGE = 'vww-startup-breadcrumb';

export function recordVwwStartupBreadcrumb(phase, detail = {}) {
  const payload = {
    phase,
    engine: 'vww',
    at: Date.now(),
    detail,
  };

  try {
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
      self.postMessage({ type: VWW_BREADCRUMB_MESSAGE, payload });
    }
  } catch (_) { /* best-effort diagnostic only */ }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('__vs_vww_startup_breadcrumb__', JSON.stringify(payload));
    }
  } catch (_) { /* localStorage is unavailable in Workers */ }
}

export async function checkpointVwwStartup(phase, detail = {}) {
  recordVwwStartupBreadcrumb(phase, detail);
  await yieldToBrowser();
}

export function clearVwwStartupBreadcrumb(detail = {}) {
  const payload = {
    phase: 'complete',
    engine: 'vww',
    at: Date.now(),
    detail,
    clear: true,
  };

  try {
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
      self.postMessage({ type: VWW_BREADCRUMB_MESSAGE, payload });
    }
  } catch (_) { /* best-effort diagnostic only */ }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('__vs_vww_startup_breadcrumb__');
      localStorage.setItem('__vs_vww_startup_last_success__', JSON.stringify(payload));
    }
  } catch (_) { /* localStorage is unavailable in Workers */ }
}

export function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Read-only Playwright adapter for trusted synthetic fixture contexts only. */
import type { Page, ConsoleMessage, Response } from 'playwright';
import type { ObservationSource } from './browser-observation.js';
export function fixtureObservationSource(page: Page): ObservationSource {
  return {
    // Use the installed Playwright locator API, not the removed accessibility API.
    snapshot: (timeout) => page.locator('body').ariaSnapshot({ timeout }),
    screenshot: (timeout) =>
      page.screenshot({
        type: 'png',
        fullPage: false,
        timeout,
        animations: 'disabled',
        mask: [page.locator('input, textarea, select, [data-dogwatch-secret]')],
      }),
    subscribe(listener) {
      const consoleError = (message: ConsoleMessage) => {
        if (message.type() === 'error') listener({ kind: 'console_error' });
      };
      const exception = () => listener({ kind: 'page_exception' });
      const failed = () => listener({ kind: 'request_failed' });
      const response = (value: Response) => {
        if (value.status() >= 400 && value.status() <= 599)
          listener({ kind: 'http_error', status: value.status() });
      };
      page.on('console', consoleError);
      page.on('pageerror', exception);
      page.on('requestfailed', failed);
      page.on('response', response);
      return () => {
        page.off('console', consoleError);
        page.off('pageerror', exception);
        page.off('requestfailed', failed);
        page.off('response', response);
      };
    },
  };
}

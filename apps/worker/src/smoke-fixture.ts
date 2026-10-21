/** Trusted local fixture adapter only. Never use it for customer previews. */
import { chromium, errors } from 'playwright';
import { SmokeStepError } from './smoke.js';
import type { SmokeDriver, SmokeEvents, SmokeStep } from './smoke.js';

export async function createFixtureSmokeDriver(
  originInput: string,
  values: Record<string, string>,
): Promise<SmokeDriver> {
  const origin = new URL(originInput);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('smoke_fixture_origin');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const events: SmokeEvents = {
      consoleErrors: 0,
      pageErrors: 0,
      serverErrors: 0,
      networkErrors: 0,
      blockedRequests: 0,
    };
    const increment = (key: keyof SmokeEvents) => {
      events[key] = Math.min(100000, events[key] + 1);
    };
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        route.request().redirectedFrom()
      ) {
        increment('blockedRequests');
        await route.abort();
      } else {
        // Browser routing does not intercept every redirect follow-up. Fetch the
        // trusted fixture response without following redirects before fulfilling it.
        try {
          const response = await route.fetch({
            maxRedirects: 0,
            timeout: 2000,
          });
          if (response.status() >= 300 && response.status() < 400) {
            increment('blockedRequests');
            await route.abort();
          } else await route.fulfill({ response });
          await response.dispose();
        } catch {
          increment('networkErrors');
          await route.abort().catch(() => {});
        }
      }
    });
    await context.routeWebSocket('**/*', (socket) => {
      increment('blockedRequests');
      socket.close();
    });
    const page = await context.newPage();
    context.on('page', (popup) => {
      increment('blockedRequests');
      void popup.close();
    });
    page.on('console', (message) => {
      if (message.type() === 'error') increment('consoleErrors');
    });
    page.on('pageerror', () => increment('pageErrors'));
    page.on('response', (response) => {
      if (response.status() >= 500) increment('serverErrors');
    });
    page.on('requestfailed', () => increment('networkErrors'));
    page.on('download', (download) => {
      increment('blockedRequests');
      void download.cancel();
    });
    return {
      events: () => ({ ...events }),
      close: () => browser.close(),
      async execute(step: SmokeStep, timeoutMs: number) {
        try {
          if (step.kind === 'navigate') {
            const url = new URL(step.path, origin);
            if (url.origin !== origin.origin)
              throw new Error('smoke_fixture_origin');
            const response = await page.goto(url.href, {
              timeout: timeoutMs,
              waitUntil: 'load',
            });
            if (!response || response.status() >= 400)
              throw new SmokeStepError('navigation_failed');
            return;
          }
          const target = page.locator(step.selector);
          if (step.kind === 'fill' || step.kind === 'select') {
            if (!Object.hasOwn(values, step.valueRef))
              throw new Error('smoke_value_missing');
            if (step.kind === 'fill')
              await target.fill(values[step.valueRef], { timeout: timeoutMs });
            else
              await target.selectOption(values[step.valueRef], {
                timeout: timeoutMs,
              });
          } else if (step.kind === 'click')
            await target.click({ timeout: timeoutMs });
          else if (step.kind === 'visible')
            await target.waitFor({ state: 'visible', timeout: timeoutMs });
          else {
            // Poll the exact assertion without returning DOM text to the supervisor.
            await page.waitForFunction(
              ({ selector, expected }) =>
                (
                  globalThis as unknown as {
                    document: {
                      querySelector(
                        selector: string,
                      ): { textContent: string | null } | null;
                    };
                  }
                ).document
                  .querySelector(selector)
                  ?.textContent?.includes(expected) === true,
              { selector: step.selector, expected: step.expected },
              { timeout: timeoutMs },
            );
          }
        } catch (error) {
          if (error instanceof SmokeStepError) throw error;
          if (error instanceof errors.TimeoutError)
            throw new SmokeStepError(
              step.kind === 'text' || step.kind === 'visible'
                ? 'assertion_failed'
                : step.kind === 'navigate'
                  ? 'navigation_failed'
                  : 'interaction_failed',
            );
          // Browser crash, missing values and unknown errors are infrastructure outcomes.
          throw new Error('smoke_driver_unavailable', { cause: error });
        }
      },
    };
  } catch {
    await browser.close();
    throw new Error('smoke_fixture_setup_failed');
  }
}

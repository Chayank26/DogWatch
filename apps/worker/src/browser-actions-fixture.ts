/** Trusted loopback fixture executor; not a production browser sandbox. */
import { chromium } from 'playwright';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequestFault } from './browser-chaos.js';
import type { BrowserBudget } from './browser-budget.js';
import {
  browserActionSchema,
  browserPolicySchema,
  actionAllowed,
  requestAllowed,
} from './browser-actions.js';
import { scopeSchema } from './api-execution.js';
import { bounded } from './api-runtime.js';
import { createBrowserObserver } from './browser-observation.js';
import { fixtureObservationSource } from './browser-observation-playwright.js';

export async function createFixtureActionExecutor(
  scopeInput: unknown,
  policyInput: unknown,
  options: {
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
    budget?: BrowserBudget;
    chaos?: unknown;
  },
) {
  const scope = scopeSchema.parse(scopeInput);
  const policy = browserPolicySchema.parse(policyInput);
  if (
    Object.entries(scope).some(
      ([key, value]) => policy[key as keyof typeof scope] !== value,
    )
  )
    throw Error('action_scope');
  const origin = new URL(policy.origin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    policy.origin !== origin.origin
  )
    throw Error('fixture_origin');
  const fault =
    options.chaos === undefined ? undefined : createRequestFault(options.chaos);
  const isCurrent = options.isCurrent;
  const browser = await chromium.launch({ headless: true });
  let closed = false,
    busy = false,
    actions = 0,
    requests = 0,
    blocked = 0;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let observer: ReturnType<typeof createBrowserObserver> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (!closePromise) {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      observer?.close();
      closePromise = browser.close();
    }
    return closePromise;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), policy.sessionMs);
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1000, height: 700 },
    });
    const deny = () => {
      blocked++;
      controller.abort();
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      try {
        if (
          closed ||
          signal.aborted ||
          ++requests > policy.maxRequests ||
          request.redirectedFrom() ||
          !requestAllowed(request.url(), request.method(), policy) ||
          (request.isNavigationRequest() &&
            (request.frame().parentFrame() !== null ||
              !policy.navigationPaths.includes(
                new URL(request.url()).pathname,
              ))) ||
          !(await bounded(isCurrent(), signal))
        ) {
          await route.abort();
          deny();
          return;
        }
        signal.throwIfAborted();
        if (closed) throw Error('closed');
        options.budget?.reserve(scope, 'request');
        const injection = fault?.next(
          new URL(request.url()).pathname,
          request.method(),
          request.isNavigationRequest(),
        );
        if (injection?.kind === 'delay') {
          await pause(injection.delayMs!, undefined, { signal });
          signal.throwIfAborted();
          if (closed || !(await bounded(isCurrent(), signal)))
            throw Error('stale');
        } else if (injection) {
          await route.abort(
            injection.kind === 'offline' ? 'internetdisconnected' : 'aborted',
          );
          return;
        }
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: policy.actionMs,
        });
        try {
          if (
            (response.status() >= 300 && response.status() < 400) ||
            response.headers()['content-disposition']
          ) {
            await route.abort();
            deny();
          } else await route.fulfill({ response });
        } finally {
          await response.dispose();
        }
      } catch {
        await route.abort().catch(() => {});
        deny();
      }
    });
    await context.routeWebSocket('**/*', (socket) => {
      socket.close();
      deny();
    });
    const page = await context.newPage();
    context.on('page', (popup) => {
      void popup.close().catch(() => {});
      deny();
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => {});
      deny();
    });
    page.on('filechooser', () => deny());
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
      deny();
    });
    observer = createBrowserObserver(scope, fixtureObservationSource(page), {
      isCurrent,
      signal,
    });
    const current = async () => {
      signal.throwIfAborted();
      if (!(await bounded(isCurrent(), signal))) throw Error('stale');
      signal.throwIfAborted();
    };
    return {
      chaos: () => fault?.snapshot(),
      async settle() {
        if (closed || busy) throw Error('executor_unavailable');
        busy = true;
        try {
          await current();
          await page.waitForLoadState('networkidle', {
            timeout: policy.actionMs,
          });
          await current();
        } finally {
          busy = false;
        }
      },
      observe: async () => {
        if (busy || closed) throw Error('executor_unavailable');
        busy = true;
        try {
          return await observer!.observe();
        } finally {
          busy = false;
        }
      },
      async close() {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        await close();
      },
      async execute(proposal: unknown) {
        const parsed = browserActionSchema.safeParse(proposal);
        const result = (code: string) => ({
          ...scope,
          actionId: actions,
          code,
          requests,
          blocked,
        });
        if (!parsed.success) return result('action_invalid');
        if (busy || closed) return result('executor_unavailable');
        const action = parsed.data;
        if (action.kind === 'stop') {
          clearTimeout(timer);
          await close();
          return result('stopped');
        }
        if (!actionAllowed(action, policy)) return result('action_forbidden');
        if (actions >= policy.maxActions) {
          await close();
          return result('action_budget');
        }
        busy = true;
        actions++;
        const actionTimer = setTimeout(
          () => controller.abort(),
          policy.actionMs,
        );
        try {
          await current();
          observer!.markAction(`action-${actions}`);
          if (action.kind === 'navigate')
            await page.goto(new URL(action.path, origin).href, {
              timeout: policy.actionMs,
              waitUntil: 'load',
            });
          else {
            if (new URL(page.url()).origin !== policy.origin)
              throw Error('origin');
            if (action.kind === 'scroll')
              await page.mouse.wheel(0, action.deltaY);
            else {
              const grant = policy.targets.find(
                (target) => target.id === action.target,
              )!;
              const locator =
                grant.locator.kind === 'label'
                  ? page.getByLabel(grant.locator.name, { exact: true })
                  : page.getByRole(grant.locator.role, {
                      name: grant.locator.name,
                      exact: true,
                    });
              if ((await locator.count()) !== 1) throw Error('ambiguous');
              if ((await locator.getAttribute('type')) === 'file')
                throw Error('upload');
              await current();
              if (action.kind === 'click')
                await locator.click({ timeout: policy.actionMs });
              else if (action.kind === 'fill')
                await locator.fill(policy.values[action.valueRef], {
                  timeout: policy.actionMs,
                });
              else
                await locator.selectOption(policy.values[action.valueRef], {
                  timeout: policy.actionMs,
                });
            }
          }
          await current();
          if (new URL(page.url()).origin !== policy.origin)
            throw Error('origin');
          return result('executed');
        } catch {
          await close();
          return result(
            blocked ? 'destination_blocked' : 'action_inconclusive',
          );
        } finally {
          busy = false;
          clearTimeout(actionTimer);
        }
      },
    };
  } catch {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await close();
    throw Error('fixture_setup_unavailable');
  }
}

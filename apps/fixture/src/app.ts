/**
 * PawMart is a disposable QA target, not the DogWatch customer dashboard.
 * Each factory call owns fresh in-memory orders. Nothing touches Postgres,
 * GitHub, real accounts, or a payment provider. Deliberate faults are selected
 * when starting the process, never by an unauthenticated control endpoint.
 */
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';

/** A small labeled corpus: healthy behavior plus two independently observable faults. */
export const fixtureModes = [
  'healthy',
  'missing-address-500',
  'checkout-stuck',
] as const;
export type FixtureMode = (typeof fixtureModes)[number];
export function parseFixtureMode(value: string = 'healthy'): FixtureMode {
  if (!fixtureModes.includes(value as FixtureMode))
    throw new Error('Unknown FIXTURE_MODE');
  return value as FixtureMode;
}

export function createFixtureApp(mode: FixtureMode = 'healthy') {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  // Seed IDs are deterministic so future replay can use exactly the same resource.
  const orders = new Map<
    string,
    { id: string; owner: string; address: string; quantity: number }
  >([
    [
      'order-alice',
      {
        id: 'order-alice',
        owner: 'alice',
        address: '1 Test Lane',
        quantity: 1,
      },
    ],
    [
      'order-bob',
      { id: 'order-bob', owner: 'bob', address: '2 Test Lane', quantity: 2 },
    ],
  ]);
  let sequence = 0;
  const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
  app.use(express.static(publicPath));
  // Build emits browser.ts next to this module; source tests don't request it.
  app.get('/browser.js', (_request, response) => {
    response.sendFile(fileURLToPath(new URL('./browser.js', import.meta.url)));
  });
  app.get('/health', (_request, response) =>
    response.json({ status: 'ok', mode }),
  );

  // Hardcoded, public synthetic credentials; intentionally not production auth.
  app.use('/api', (request, response, next) => {
    const user = {
      'Bearer fixture-alice': 'alice',
      'Bearer fixture-bob': 'bob',
    }[request.get('authorization') ?? ''];
    if (!user) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    response.locals.user = user;
    next();
  });
  app.get('/api/orders/:id', (request, response) => {
    const order = orders.get(request.params.id);
    if (!order) {
      response.status(404).json({ error: 'Order not found' });
      return;
    }
    if (order.owner !== response.locals.user) {
      response.status(403).json({ error: 'Order belongs to another user' });
      return;
    }
    response.json(order);
  });
  app.post('/api/orders', (request, response) => {
    // Explicit shape checks handle null, arrays, and primitive JSON safely.
    const body: unknown = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      response.status(400).json({ error: 'Expected an object' });
      return;
    }
    const { address, quantity } = body as Record<string, unknown>;
    if (
      typeof address !== 'string' ||
      !address.trim() ||
      address.length > 200
    ) {
      // Deliberate benchmark defect: this case should be 400 in healthy mode.
      response
        .status(mode === 'missing-address-500' ? 500 : 400)
        .json({ error: 'Address is required (maximum 200 characters)' });
      return;
    }
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      response
        .status(400)
        .json({ error: 'Quantity must be an integer from 1 to 10' });
      return;
    }
    const order = {
      id: `order-created-${++sequence}`,
      owner: response.locals.user as string,
      address: address.trim(),
      quantity,
    };
    orders.set(order.id, order);
    response.status(201).json(order);
  });
  // Browser reads mode to reproduce an explicit client-side fault. It cannot alter it.
  app.get('/fixture-config', (_request, response) => response.json({ mode }));
  // Invalid/oversized JSON has deterministic JSON errors rather than HTML traces.
  const handleError: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    // Express identifies error middleware by four arguments; keep next even though
    // this terminal handler sends the response rather than forwarding the error.
    void _next;
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 500;
    response
      .status(status === 413 ? 413 : status === 400 ? 400 : 500)
      .json({ error: 'Request could not be processed' });
  };
  app.use(handleError);
  return app;
}

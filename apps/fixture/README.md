# PawMart synthetic QA fixture

A separate local application for testing DogWatch, not a customer-facing DogWatch feature. It makes no GitHub, model, database, payment, or third-party network calls. Orders live in process memory and reset on restart. Do not enter real credentials or customer details.

## Run it

```sh
npm run fixture:dev
```

Open http://127.0.0.1:4100. Select Alice or Bob, enter an address and quantity (1–10), then place an order. A healthy run shows the created order ID. A blank address shows a validation message. Source changes require restarting the dev command to recompile; Node watch reloads changed compiled output only.

The fixture runs separately from `npm run dev`, keeping synthetic targets out of normal product startup. After `npm run build`, use `npm run fixture:start` for compiled execution. `FIXTURE_PORT` can change the port; the server always binds to loopback.

## Deliberate fault modes

```sh
FIXTURE_MODE=missing-address-500 npm run fixture:dev
FIXTURE_MODE=checkout-stuck npm run fixture:dev
```

Run one mode at a time. The default is `healthy`; unknown modes fail startup.

| Mode                | Scenario             | Expected observation                                       |
| ------------------- | -------------------- | ---------------------------------------------------------- |
| healthy             | Submit blank address | API 400, UI shows validation message.                      |
| missing-address-500 | Submit blank address | API 500 violates the healthy contract; UI shows the error. |
| checkout-stuck      | Submit blank address | API correctly returns 400, but UI stays on Processing.     |

The form deliberately skips native browser validation so server-side edge cases can be exercised. Future Playwright phases will verify client behavior in a real browser; current automated tests exercise HTTP behavior and fault configuration only.

## Synthetic identities and data

The public tokens `fixture-alice` and `fixture-bob` correspond to the browser's identity selector. Send them as `Authorization: Bearer fixture-alice` (or Bob). These are intentional fixture credentials, not production authentication.

`GET /api/orders/order-alice` is allowed for Alice; Bob receives 403. `order-bob` behaves symmetrically. Missing/invalid tokens receive 401. A valid POST to `/api/orders` creates an in-memory order. No delete/reset endpoint is exposed; restart for a clean baseline. The healthy contract is served at `/openapi.yaml`, health at `/health`, and process mode at `/fixture-config`.

Loopback is intentional for trusted local fixtures. This does not override the planned hosted-worker prohibition on arbitrary loopback destinations. A future isolated QA harness must grant this known fixture through a dedicated controlled test environment.

## Files and configuration explained

- `src/app.ts`: factory, isolated in-memory data, middleware, validation, HTTP routes, and explicit faults. It never starts a listener by import.
- `src/index.ts`: validates startup configuration, starts loopback listening, and handles shutdown.
- `src/browser.ts`: form handler, same-origin requests, safe status rendering, and the deliberate client fault.
- `src/app.test.ts`: real HTTP checks using a fresh ephemeral server and cleanup for each test.
- `public`: labeled HTML, local CSS, and the healthy OpenAPI contract. No CDN assets are required.
- `package.json`: private ESM workspace; `build` compiles source, `dev` builds then watches compiled execution, `test` uses Node plus the tsx loader, and `start` serves the compiled target.
- `tsconfig.json`: strict shared settings, Node ESM, DOM types for browser source, and `dist` output; test files are executed separately and excluded from production builds.

TypeScript emits this browser file as ESM; HTML loads it as a module, which defers execution until the document is parsed. Generated `dist` files are ignored and should not be edited manually.

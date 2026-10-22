# Authentication probes

Part 4, Phase 4.4 adds `executeApiAuthentication(input, options)` alongside `executeApiCases`. Both use the same scoped executor and transport. Run `npm run authentication:verify` for real disposable HTTP checks or `npm run api:verify` for both API suites. The workspace test command includes these checks in CI.

## Independent operation policy

Use the same independently accepted run identity, exact deployment/origin binding, cancellation/current-authority callback and request/byte/deadline limits described in [API execution](API_EXECUTION.md). An operation additionally needs this operator-owned grant:

```ts
{
  method: 'GET',
  path: '/api/orders/{id}',
  authentication: {
    successStatuses: [200],
    rejectionStatus: 401,
    invalidBearer: true,
  },
}
```

`rejectionStatus` defaults to 401; an explicitly configured 403 is also supported. The success statuses must be 2xx. Each configured status must have an explicit response in the normalized contract; a generic default response cannot establish an authentication expectation. Merely declaring a security scheme does not authorize probes. POST/PUT/PATCH/DELETE retain the separate `allowMutation` and `disposableData` requirements, including for the authenticated control, which may create state.

Supply known disposable resource/body fixtures through `generation`. The generator's `baselineOnly` mode produces schema-valid baselines without irrelevant boundary mutations or mutation-budget gaps. Payload/case ceilings and unknown schema constraints remain enforced. The authentication stage forces baseline-only planning, then expands each baseline into at most three requests:

1. A control with a scoped credential from `getBearerToken`.
2. The exact same logical request with no Authorization header, after the control passes.
3. Optionally, the same request with a scoped, attested-invalid credential from `getInvalidBearerToken`.

Both providers receive `(scope, deploymentId, origin, schemeName)`. The caller must independently authorize synthetic accounts and attest the invalid credential is invalid for this target. It must not be another identity's valid token. The executor refuses an invalid credential identical to its control credential. It does not infer token expiry or validity from JWT claims, mint credentials, guess passwords or brute force. Missing/unsafe/unavailable invalid credentials are explicit incomplete coverage; the missing-credential observation can still remain valid. The invalid-token provider is never invoked when `invalidBearer` is false (the default).

## Preconditions and interpretation

This increment supports an effective security requirement consisting of one HTTP bearer scheme, including repeated equivalent alternatives. Anonymous/public operations, ungranted checks, Basic/API-key schemes, different-scheme OR alternatives and multi-scheme AND requirements are skipped or inconclusive without requests. Baselines containing ordinary query/header/cookie parameters are conservatively inconclusive because they may carry additional session authority. The caller must ensure disposable body/resource fixtures contain no other authentication material. There is no cookie jar and Set-Cookie is never replayed.

The control must return a configured success status and satisfy its declared response assertions. A business rejection, missing resource, expired credential, invalid response or server failure leaves the control unavailable and suppresses its negative requests. This prevents a 404 or generic middleware rejection from masquerading as a successful authentication check. Control failure is setup context for this stage; ordinary API server/schema observations remain available through the boundary executor.

After a passing control:

| Negative response                                   | Observation                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Configured 401/403 with valid declared response     | `authentication_rejected`, passed                                                       |
| 2xx                                                 | `authentication_accepted`, failed: configured authentication rejection was not enforced |
| Other 401/403                                       | `authentication_rejection_mismatch`, failed against the configured contract             |
| 5xx                                                 | `server_error`, failed                                                                  |
| Other 4xx, including 400/404                        | `authentication_rejection_unproven`, inconclusive                                       |
| Redirect or 429                                     | Stop the stage, inconclusive                                                            |
| Failed response schema for the configured rejection | Response contract failure or explicit unknown-constraint gap                            |

Acceptance establishes a mismatch with the configured bearer requirement, not proof of data exfiltration, unauthorized mutation, role bypass or IDOR. A rejection does not prove an endpoint has no other authentication defects. Base/PR regression attribution and durable findings are unavailable here. Role and ownership comparisons belong to Phase 4.5.

## Budgets, metadata and production boundary

Controls and negatives share one sequential stage counter, rate interval, request reservation, response-body cap, retry policy and deadline. No separate executor invocation resets budgets between paired checks. Every attempt rechecks current authority after waiting and every response rechecks before observation. Cancellation/authority changes suppress queued negatives; an AbortSignal interrupts in-flight requests. Only safe-method transport failures may retry; mutations never retry. No raw credential, response body, header, exception or query is returned.

Results include `probe` (`control`, `missing`, `invalid_bearer`), `baselineCaseId` and distinct deterministic `caseId`s. Probe IDs bind the baseline ID, run identity, deployment, origin, configured expectation and probe kind without hashing secret values. The output retains contract digest and seed. Changing credentials without changing the fixture scenario can change observations; IDs do not establish equivalent account state. `completed` means all selected probes were assessed, including failed observations; inspect each result. Missing coverage keeps the stage inconclusive.

The PawMart `authentication-bypass` mode intentionally treats every API caller as Alice. The verifier tests GET of Alice's seeded order and a disposable POST against both healthy and bypass modes: the healthy target rejects missing/invalid tokens, while the defective target yields four failed negative observations. Each verifier server has fresh in-memory state and is closed afterward.

Normal worker startup remains dispatch-only; the diagnostic Docker sandbox remains offline. This callable client is not a production consumer or network firewall. Customer execution still requires the isolated supervisor/outbound broker, durable lease, whole-run budget reservation and synthetic resource setup/cleanup described in the execution guide. This phase uses no customer service, real credential or external identity provider. Cleanup and replay integration remain Phase 4.6.

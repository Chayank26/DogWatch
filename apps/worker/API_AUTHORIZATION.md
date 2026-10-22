# Role and ownership probes

Part 4, Phase 4.5 adds `executeApiAuthorization` in `src/api-authorization.ts`. Run `npm run authorization:verify` for real local fixture checks. `npm run api:verify` and the workspace test command include the new suite.

The supported profile verifies read access through HTTP bearer identities and explicit JSON evidence. It detects an authenticated subject reading another subject's known resource and a forbidden role receiving a protected response. Mutation scenarios are inconclusive before credential lookup or HTTP; proving unauthorized state changes requires independent before/after readback and reset controls, which this increment does not provide.

## Scope and operator policy

Use the accepted run identity and matching immutable preview deployment/origin from the [API executor](API_EXECUTION.md). Add an `authorization` policy to that independently scoped grant. Every identity-control and target endpoint must also appear in the grant's exact `operations` allowlist. A generator operation allowlist can only narrow this authority. No contract server, security declaration or public request plan grants access.

An ownership example:

```ts
{
  identityCheck: {
    path: '/api/identity',
    subjectField: ['subjectId'],
    roleField: ['role'],
    successStatus: 200,
  },
  scenarios: [{
    kind: 'ownership',
    id: 'order-ownership',
    method: 'GET',
    path: '/api/orders/{id}',
    allowed: { ref: 'alice-account', subjectId: 'alice', role: 'customer' },
    denied: { ref: 'bob-account', subjectId: 'bob', role: 'customer' },
    resourceParameter: 'id',
    ownerResource: 'order-alice',
    actorResource: 'order-bob',
    resourceIdField: ['id'],
    ownerField: ['owner'],
    successStatus: 200,
    rejectionStatus: 403,
  }],
}
```

The identity endpoint must return independently checkable subject and role fields. The operator attests these are synthetic identities and that the resource belongs to the configured owner. Identity references, subjects, roles and resource values are private configuration. Ownership subjects must be distinct, resources distinct, and roles equal so the scenario isolates ownership. Reverse the identities/resources in a second scenario to check the other direction; one scenario tests only its configured direction.

A role scenario replaces resource bindings with `parameters` (optional explicit path values) and `evidence`, for example `[{field: ['report'], value: 'synthetic-admin-report'}]`. Its allowed and denied subjects and roles must differ. The caller must choose evidence identifying protected response content, rather than a generic success flag or public information. Both kinds require an explicit response schema for their success status, and an explicitly documented configured 403 or 404 rejection. A 404 can represent deliberate resource concealment. GET and success status 200 are defaults.

There are at most 20 scenarios, eight evidence assertions per role scenario, eight segments per field path and 256 characters per string evidence value. Field traversal supports own object properties only; no arrays, wildcards, scripts or arbitrary JSONPath. Unsafe field names are refused. Duplicate scenario IDs and inconsistent identity-reference bindings fail configuration validation. Required path values must bind declared parameters exactly and satisfy the existing schema/serialization checks. Ordinary query/header/cookie parameters, GET bodies, anonymous or compound credential requirements and mismatched bearer schemes remain unsupported coverage gaps.

## Identity and access controls

A trusted `getIdentity(context, identity, scheme)` provider receives the exact run identity plus deployment/origin and the configured synthetic identity. It returns those scope fields plus `identityRef`, `subjectId`, `role` and `bearerToken`. Every returned field must match the independent context and declaration. Missing, unsafe or identical tokens are refused before HTTP. The broker's assertion alone is insufficient: the target's identity response must also match.

Within one shared stage budget, an ownership scenario performs:

1. Verify the owner's subject and role through the identity endpoint.
2. Verify the other subject and role through the same endpoint.
3. Read the owner's known resource as its owner and verify ID and ownership fields.
4. Read the other subject's own resource and verify its ID and ownership fields.
5. Read the owner's resource as the other subject, then evaluate rejection or disclosure.

A role scenario verifies both identities, performs the protected request as the allowed role and matches its configured evidence, then performs the same request as the forbidden role. A failed control suppresses subsequent requests for that scenario. Missing resources, invalid schemas, identity mismatches and unsuccessful control statuses remain setup gaps. Multiple scenarios keep the same request, response-byte, retry, rate and deadline counters; credentials are obtained per scenario rather than cached across identities.

The caller must ensure no additional authentication material is present in fixture path values. There is no ambient cookie jar, header injection or automatic login. These probes do not discover accounts, infer roles from token claims, guess IDs or enumerate resources.

## Evidence and outcomes

For a forbidden response, a strong observation requires both the known successful response schema and every configured evidence field to match. For ownership that means the expected resource ID and its owner, following both successful own-resource controls. For roles that means the explicitly configured protected content, following the allowed-role control.

| Observation                                                                     | Result                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Protected object/content proven in the forbidden response                       | Failed `ownership_access_observed` or `role_access_observed`     |
| Configured 403/404, valid declared rejection response, and no proven disclosure | Passed `authorization_rejected`                                  |
| 2xx with missing, wrong or unverifiable protected evidence                      | Inconclusive `authorization_access_unproven`                     |
| 401 during forbidden access                                                     | Inconclusive credential context                                  |
| Other 403/404                                                                   | Failed configured rejection mismatch, not a proven access defect |
| Other 4xx                                                                       | Inconclusive rejection                                           |
| 5xx without proven disclosure                                                   | Observed server failure                                          |
| Redirect, 429, cancellation, response overflow or transport/budget exhaustion   | Stop remaining requests with explicit incomplete coverage        |

A denial status can still leak the protected resource. Evidence matching is checked before accepting a configured rejection, so a `403` containing the full known object is a failed disclosure observation. Alternate success statuses do not hide the same evidence. Redirects and rate limits stop immediately. Schema-valid evidence is evaluated in memory against the configured success schema; the real HTTP status is retained in metadata.

Results contain scope, contract digest, seed, opaque scenario/case IDs, step, operation template, fixed codes, status and an optional evidence-match boolean. Probe IDs bind the baseline, scenario, expectation, run and deployment. Tokens, account/resource values, raw payloads, field values, headers and exceptions are not retained. IDs and operation templates are still private scoped metadata. `completed` means every step was assessed; failed observations may be present. No raw payload artifact or durable security finding is published.

These are observations at the time of execution, contingent on trusted identity/ownership policy and the configured evidence. They do not establish a comprehensive authorization audit, mutation effects or that a PR introduced a defect. Returned metadata supports deterministic replay with the same policy and disposable state; it is not a substitute for later durable evidence integration.

## Runtime and fixture boundaries

`ApiRuntime` now owns the shared attempt loop used by boundary, authentication and authorization stages. It retains checked/pinned HTTPS transport, no redirects/cookies/proxies, sequential rate spacing, count/wire/body reservations, bounded retries, callback/socket deadlines and pre/post-request current-authority checks. Supply an AbortSignal for immediate in-flight durable cancellation. The shared defaults and limitations are documented in [API execution](API_EXECUTION.md).

PawMart adds a public synthetic `fixture-admin` token, `/api/identity`, `/api/admin/report`, and separate `ownership-bypass` and `role-bypass` modes. The separate `authorization-openapi.yaml` keeps the new read endpoints out of the earlier boundary corpus. The original order response enum now includes `admin`, matching orders created by the new synthetic identity. Each verification target starts with fresh in-memory orders and closes afterward. The healthy target rejects forbidden access; each seeded fault exposes the appropriate protected response.

Normal startup remains dispatch-only and the diagnostic Docker sandbox stays offline. Production customer execution still needs isolated supervision/outbound controls, durable execution leases and whole-run budget reservations. This phase adds no customer requests, real identity-provider integration, database migration or automatic consumer. Phase 4.6 addresses cleanup and reproducibility; unauthorized mutation verification remains unsupported until its independent state controls are implemented.

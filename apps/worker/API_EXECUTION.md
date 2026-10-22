# Bounded API execution

Part 4, Phase 4.3 adds `executeApiCases` in `src/api-execution.ts`. Run `npm run api:verify` for real disposable HTTP fixtures, including PawMart server, authentication, role and ownership failures. `npm test` includes the same checks and builds the fixture first. No new dependency is required.

## Authority and integration

The caller supplies an independently accepted `{tenantId, runId, repositoryId, pullRequestNumber, headSha}`, an immutable deployment binding, and an operator grant for that exact identity, deployment ID and bare origin. The origin must match the bound preview and its allowed origins. Grant operation selectors must exactly name declared operations; duplicate/unknown grants fail closed. GET/HEAD/OPTIONS still require explicit grants. POST/PUT/PATCH/DELETE additionally require per-operation `allowMutation: true` and `disposableData: true`. TRACE is unavailable. Contract servers never select destinations.

The executor regenerates the bounded seeded cases from contract bytes and generator options; external case objects and IDs are not accepted. IDs, contract digest and seed make the observations reproducible when the same disposable state is supplied. Unsupported contracts and missing cases are inconclusive.

`isCurrent()` must check installation/tenant/repository authority, durable cancellation and current SHA. It runs before credential access, after rate waiting before every transport attempt, and after every response before observation. Callback waits, socket work and DNS are abort bounded. Callers must supply an AbortSignal to stop an in-flight request promptly when durable cancellation changes; polling alone cannot interrupt an active socket. Stale or unavailable context prevents a success observation.

Ordinary authenticated requests currently support a single HTTP bearer scheme in a satisfied security alternative, obtained from a trusted `getBearerToken(scope, deploymentId, origin, scheme)` callback. Empty/anonymous requirements need no token. Basic, API-key, multi-scheme AND and unavailable bearer contexts are inconclusive. Tokens must be bounded header-safe values and are never returned or logged. A 401/403 blocks subsequent cases for that operation as unavailable authentication context. The separate Phase 4.4 [authentication stage](API_AUTHENTICATION.md) adds configured negative probes; ordinary boundary-stage 401/403 observations remain unavailable authentication context. Phase 4.5 adds a separate [read-access role/ownership stage](API_AUTHORIZATION.md).

The callable client supports exact-origin HTTPS to public IPv4. It reuses preview DNS range checks, rejects any private/special/non-IPv4 answer, and pins the checked address while retaining the hostname for TLS verification. Literal HTTP 127.0.0.1 is available only through the trusted code-level fixture option. Redirects stop the stage without following Location. Each request has a fresh connection, explicit headers and no cookie jar, proxy integration or decompression. Set-Cookie is ignored. These use the official Node 24 [HTTP request options](https://nodejs.org/download/release/v24.17.0/docs/api/http.html) and [HTTPS client](https://nodejs.org/download/release/v24.17.0/docs/api/https.html).

This is a trusted outbound client, not an OS/container egress firewall. Normal worker startup remains dispatch-only and the diagnostic Docker sandbox remains offline. Customer execution requires a killable isolated supervisor, controlled outbound broker, durable execution lease, whole-run/tenant budget reservation and disposable-state setup/cleanup. No production consumer, public API, artifact storage or GitHub report is added. Do not call this directly with hostile customer content in the control-plane process. Synchronous contract parsing/planning still requires process limits; its work precedes the asynchronous execution deadline.

## Serialization and limits

Supported parameter serialization is deliberately narrow: primitive form/simple parameters with conventional scalar interpretation. Null/structured parameters, missing/empty/traversing/encoded path segments, unsupported literal paths, GET/HEAD bodies and unsafe routing/auth/transport headers yield explicit inconclusive cases. Path values are bounded ASCII slugs; there is no heuristic path prefix. Query/cookie values are escaped. If conversion changes modeled schema validity (for example a wrong-type number becoming a valid string), the case is refused rather than asserting rejection of an input that changed meaning on the wire. Missing parameters remain absent. JSON bodies use canonical UTF-8; malformed bodies remain malformed.

| Limit                                          | Default | Hard ceiling   |
| ---------------------------------------------- | ------- | -------------- |
| Attempt count, including retries               | 100     | 1,000          |
| Safe-method transport retries                  | 0       | 2              |
| Pause between completed attempt and next start | 100 ms  | At least 50 ms |
| DNS/socket attempt deadline                    | 2 s     | 10 s           |
| Asynchronous stage deadline                    | 20 s    | 300 s          |
| Serialized request bytes per attempt           | 16 KiB  | 64 KiB         |
| Accepted response body bytes per attempt       | 16 KiB  | 64 KiB         |
| Aggregate reserved request bytes               | 256 KiB | 1 MiB          |
| Aggregate accepted response body bytes         | 1 MiB   | 4 MiB          |

Concurrency is one. Attempts reserve request-line, explicit HTTP headers, terminator and body bytes before DNS; failed attempts conservatively keep their full reservation. Counts therefore describe charged attempts, not confirmed server receipt. The URL is also capped at 2,048 characters and response headers at 8 KiB. Body caps do not include network/TLS framing or headers. A received overflow chunk is discarded and the socket destroyed; counters charge accepted bytes through the cap, not bytes the kernel may already have buffered. Retries charge all budgets and only apply to GET/HEAD/OPTIONS transport failures, never HTTP statuses or mutations. A lost mutation response is inconclusive and never replayed automatically.

Request/count/aggregate exhaustion, response overflow, cancellation, unavailable context and transport exhaustion stop further work. A per-case request serialization/size failure leaves an explicit coverage gap. Redirects and 429 stop the stage. No limit condition becomes an application pass.

## Observation semantics

Fixed result codes carry scope, contract digest, seed, case ID, operation key and optional status. Raw URL queries, credentials, request/response bodies, response headers and exception strings are absent. Operation paths and IDs remain private scoped metadata; they are not a public-redaction format.

Unexpected 5xx is an observed server failure. An undocumented status, invalid declared JSON/media type/schema, or a faithfully serialized schema-invalid input accepted with 2xx is a contract failure. Documented 4xx responses (apart from unavailable-auth 401/403 and rate-limited 429) are valid observations, including business rejections of schema-valid input. They do not prove a successful user journey. Declared JSON response schemas use the existing bounded interpreter, never customer-schema compilation or arbitrary regex execution. Unknown constraints, oversized/unsupported JSON structures and encodings remain inconclusive. HEAD/204/205 skip body assertions. Responses without declared schemas receive status assertions only.

`status: completed` means all generated cases were assessed without coverage gaps, not that they passed: inspect individual results. `inconclusive` may contain genuine failed observations alongside missing coverage. No base regression attribution, durable finding, role/ownership proof, retained payload evidence or cleanup guarantee is claimed. Phase 4.4 supplies a separate configured authentication stage; Phase 4.6 owns resource cleanup and replay integration. Fixtures use fresh in-memory state and close every server after verification.

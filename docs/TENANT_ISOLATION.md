# Tenant isolation verification

Phase 7.3 provides `npm run tenant-isolation:verify`, a repeatable regression gate for the currently implemented boundaries. Start local Compose first (`docker compose up -d --wait`). The command builds the database package, runs focused HTTP/synthetic GitHub/filesystem tests, then runs three real PostgreSQL suites. Database suites target only the disposable local Compose database and remove their random fixtures. No live GitHub or customer preview is used.

| Boundary                    | Evidence exercised                                                                                                                                     | Limit                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Browser identity/membership | Missing/expired sessions, current roles, inaccessible tenant membership, logout and storage failure                                                    | HTTP tests use an injected store; real persistence is verified separately                      |
| Webhook authorization       | Trusted policy determines tenant; actor, installation and repository scope are checked                                                                 | Synthetic signed HTTP and resolver context, not live App deliveries                            |
| GitHub token minting        | Exact returned installation and App IDs must match before a repository-scoped token is requested; suspension/removal refuse access                     | Mocked Octokit transport; live permissions unverified                                          |
| Installation linking        | Fresh owner session, immutable GitHub identity and organization admin checks; real cross-tenant claim races and revocation                             | Browser linking flow remains pending                                                           |
| Database relationships      | Two real tenants reject swapped installation/repository/run/outbox/delivery relationships with P2003 foreign-key errors                                | Composite keys protect relationships, not arbitrary reads                                      |
| Worker eligibility          | Both tenants' queued runs pass their own scope; swapped tenant/run pairs fail; cancellation leaves the other tenant eligible                           | Exercises the durable eligibility function, not a production queue consumer or execution lease |
| Report delivery             | Scoped journal/remote identity checks prevent adopting foreign reports; retired reports cannot be restored                                             | Local journal and synthetic transport, not distributed publication                             |
| Artifact storage            | Exact tenant/run/repository/SHA/role references; forged metadata, tampering, independent base authorization and same-run-ID cross-tenant substitutions | Storage adapter and authorization callback tests, not an HTTP download endpoint                |

The audit found that the older webhook GitHub resolver did not independently compare returned installation and App IDs before token minting. It now rejects either mismatch or an unrepresentable ID before requesting a token. The new regression checks that only the initial lookup occurs for these failures.

## Authority requirements

A tenant ID is a routing field, not a credential. Browser-facing reads must derive identity from a validated session and resolve current membership. Queue payloads require a durable tenant/run ownership lookup before execution; schema-valid UUIDs alone prove nothing. Service-level artifact readers need trusted scoped metadata and an independent authorization decision. Do not expose low-level storage or persistence functions as direct unauthenticated routes.

Installation ownership does not grant membership, and membership does not prove current installation access. Execution/publication must revalidate remote installation state and immutable head context. Current local guards do not make GitHub checks atomic with a database commit.

## Explicit remaining gaps

The application database role is privileged and can read both tenants. PostgreSQL row-level security is **not enabled**. This suite includes that fact as a positive control; it makes no database-wide isolation claim. Tenant-scoped public query APIs and their transaction/session model must be designed before introducing RLS, including a non-bypass runtime role and pool-context reset tests. Composite foreign keys alone are not RLS.

There is no production QA consumer, public run/evidence dashboard API, authenticated artifact-download route or browser installation-linking route yet. Those surfaces need additional adversarial integration tests when implemented. Hosted storage, distributed leases, live GitHub credentials, production service roles and hosted CI are outside this verification. The suite is a manual local command; the ordinary CI unit-test step includes the added resolver and artifact regressions but does not automatically start this database suite.

Phase 7.4 is onboarding. New surfaces must retain these checks and extend this matrix rather than treating the current passing suite as blanket authorization to expose internal adapters.

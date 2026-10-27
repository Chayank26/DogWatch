# Login and membership

Phase 7.1 adds opt-in GitHub OAuth browser login and persistent DogWatch organization membership. It follows the small-phase roadmap: installation linking is 7.2, broader tenant-isolation verification is 7.3 and onboarding is 7.4. It does not grant access to repositories, runs or artifacts yet, and no membership is inferred from GitHub usernames, emails, organizations or installation IDs.

## Configure and sign in

Apply migrations with `npm run db:migrate`. Register a dedicated GitHub OAuth App for identity, with callback `AUTH_ORIGIN/auth/github/callback`. Export all four values to the API process (the API does not load `.env`):

- `DATABASE_URL`: the intended PostgreSQL database.
- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`: the OAuth App credentials, separate from worker/App installation credentials.
- `AUTH_ORIGIN`: exact HTTPS origin, with no trailing slash, path, query or credentials. Local `http://localhost:4000` or `http://127.0.0.1:4000` is allowed for development.

Any partial configuration refuses startup. Without OAuth configuration, auth routes are absent. Login can run without webhook authorization; it does not enable durable webhook acceptance. The existing App configuration still controls webhook authorization independently.

Open `/auth/github` on the configured origin to sign in. The callback redirects only to `/auth/me` on that origin, currently a JSON identity/membership view. No caller-controlled return URL is accepted. A reverse proxy must route `/auth/*` to the API under that origin, preserve cookies and terminate HTTPS. This phase does not add dashboard or onboarding screens, CORS, cross-origin cookies or proxy trust settings.

## Session and membership behavior

Login uses a ten-minute single-use random state, browser binding and S256 PKCE. State and browser binding are hashed in PostgreSQL; the verifier is kept in an HttpOnly cookie. The callback atomically consumes the bound unexpired attempt before exchanging the code. It revalidates identity through GitHub `/user` on every successful exchange and keys users by immutable numeric GitHub ID, never by login or email. Unrepresentable numeric IDs fail validation rather than being truncated.

No additional OAuth scopes are requested. Previously approved provider grants may still apply; use the dedicated identity App. The access token is used only for `/user` and discarded, never sent to the browser, persisted, logged, or passed to workers. Discarding it does not revoke the user's GitHub authorization. Provider redirects are refused, requests have five-second abort signals, and response reads are capped at 64 KiB. Errors returned to clients omit provider and database diagnostics.

Sessions use random opaque 256-bit tokens with only SHA-256 hashes persisted. They expire after eight hours without sliding extension. Successful login rotates the presented session in a transaction. HTTPS uses `__Host-` cookies with Secure, HttpOnly, SameSite=Lax, path `/` and no Domain. Loopback HTTP uses distinct development cookie names. Auth responses are no-store with no-referrer. Configure proxy/access logs to redact callback query strings and cookies.

`GET /auth/me` returns the user and current DogWatch memberships. `GET /auth/tenants/:tenantId/membership` returns only that user's membership; unknown and inaccessible tenants both return 404. Every request checks session expiry, local user disablement and current database membership. Removal or role changes take effect on the next read. `requireMembership(identity, tenantId, 'owner')` requires the owner role; callers must obtain a fresh identity for each operation, not cache it as permanent authority. Reads do not provide an atomic authorization fence for future tenant mutations.

`POST /auth/logout` requires an exact configured Origin and revokes the server-side session before clearing its cookie. Expired/unknown sessions are idempotently logged out. No GET logout or public membership-grant endpoint exists.

## Operator-controlled membership

Successful login creates a user with zero memberships. A trusted operator must verify the intended GitHub numeric user ID and existing tenant out of band before inserting a `Membership` row for that user's internal UUID and the tenant UUID. Roles are the database enum `owner` or `member`. Membership has a composite tenant/user primary key and foreign keys; a GitHub login is not proof of authority to join a tenant. Do not attach installations or bootstrap tenant owners from untrusted request fields.

Operators can change/delete memberships to alter access, set `User.disabledAt` to disable all session resolution and further login, and delete `LoginSession` rows to revoke sessions. GitHub organization reconciliation, user-deauthorization events, last-owner rules, invitations and self-service membership changes are not implemented. They must not be represented as automatically synchronized permissions.

## Verification and deployment limits

`npm test` includes HTTP tests with mocked GitHub transport; `npm run db:verify:identity` targets only the local Compose database and verifies real state consumption, concurrent replay, expiry, session rotation, disabled users, tenant separation and role/removal changes. It removes its random fixtures afterward.

Live GitHub login and production TLS/proxy behavior remain unverified. Before exposing login publicly, configure ingress rate limits and operational expiry pruning for `LoginAttempt` and `LoginSession`; expired records are rejected on reads but not automatically removed. This phase introduces neither distributed rate limiting nor a cleanup scheduler. Installation access, row-level policies, artifact authorization and end-to-end tenant isolation remain their separate roadmap phases. No GitHub credentials are stored, so token encryption/storage is not introduced here.

Protocol reference: [GitHub OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Phase 7.4 adds an explicit first-workspace bootstrap exception to operator provisioning: authenticated users with no memberships can create a new workspace and its owner membership. It never joins an existing tenant. See [onboarding](ONBOARDING.md); invitations and other membership changes remain operator-controlled.

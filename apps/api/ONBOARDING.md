# Workspace onboarding

Phase 7.4 adds `/onboarding` to the existing Next.js application and optional authenticated API endpoints under `/auth/onboarding`. The page supports signed-out, unavailable, first-workspace and existing-membership states. It shows recorded installation/repository counts with explicit remaining setup steps; it never equates records with live access or execution readiness.

## Local configuration

Run the API with the Phase 7.1 OAuth credentials and DATABASE_URL, setting `AUTH_ORIGIN=http://127.0.0.1:3000` for the browser-facing Next.js origin. Register `http://127.0.0.1:3000/auth/github/callback` as the GitHub OAuth callback. Start the web app normally. Its `/auth/*` rewrite proxies to `DOGWATCH_API_ORIGIN`, default `http://127.0.0.1:4000`. The proxy target is an operator-owned server setting; it must not be supplied by browser input. Use the same hostname consistently for cookies and Origin checks. Production requires HTTPS and an operator-controlled API destination. Restart/rebuild after changing proxy configuration.

When onboarding is wired, successful login redirects to `/onboarding`. The standalone identity router without onboarding retains its `/auth/me` redirect. No secrets are exposed in client environment variables or browser storage.

## API and authority

`GET /auth/onboarding` resolves the current session and returns only memberships for that user, with workspace name, role and recorded installation/repository counts. Missing, expired or disabled-user sessions fail closed. Unknown database failures return a sanitized unavailable response. Responses are no-store.

`POST /auth/onboarding/workspace` requires an exact configured Origin, valid session and strict JSON `{ "name": "Team name" }` (2 KiB body limit, trimmed 1–80 characters, no control characters). It locks the current session/user, confirms expiry and enabled status, and creates one Tenant with its owner Membership atomically. A user with any membership cannot bootstrap another workspace. A repeated identical name with exactly one owner membership returns the same tenant, making concurrent double-submit/retry safe. A different name or member role returns conflict. The caller cannot set tenant IDs or roles.

This replaces operator-only provisioning **for the first workspace only**. It does not allow joining existing organizations by name, invitation, membership editing or ownership escalation. Workspace names are display labels, not verified GitHub organization identities. Direct administrative writes remain trusted operations and must coordinate with the same user lock when changing memberships concurrently with bootstrap.

## Remaining onboarding work

GitHub App user authorization and browser installation linking are still pending. The existing callable linker remains the authorized backend boundary, and the page explicitly directs users to an administrator. Repository registration, preview/test-account/run-policy configuration and actual QA requests are also not exposed here. The UI does not offer fake connect/run actions or mark those steps complete.

Ingress rate limits and expired-session/attempt pruning remain deployment prerequisites from Phase 7.1. The API has no public rate-limiting scheduler or quota service. No migration or dependency was added.

Verification: `npm test` covers the HTTP boundary; `npm run db:verify:onboarding` verifies concurrent bootstrap, owner assignment and revocation against local Compose, with random fixture cleanup. Headless Chromium checks the production-built page with synthetic API responses for signed-out, failure/retry, workspace creation, checklist, mobile overflow and logout. Live OAuth and production proxy/TLS were not exercised.

# Installation linking

Phase 7.2 adds `createInstallationLinker(appId, privateKey, store, requestFetch?)` and `createInstallationLinkStore(database)`. The resulting callable operation takes `{ tenantId, installationId, sessionToken }` and a separate, transient GitHub App user access token. It returns only link status and tenant/installation IDs. It makes read-only GitHub requests and persists an installation-to-tenant relationship in the existing `Installation` table. No schema migration or new dependency is required.

## Authority and token source

The caller must supply the authenticated browser's session token through a trusted server boundary and obtain a GitHub App user access token through a server-side authorization flow for the configured App. Neither a pasted installation ID, an installation setup redirect, a GitHub login nor a token's ability to list repositories proves ownership. Never expose this function directly as an endpoint accepting arbitrary credential fields.

Phase 7.1's separate OAuth login discards its token and does not request organization permissions. It is not sufficient for this operation. This phase deliberately does not add a browser callback, token persistence, public linking route or UI. The future onboarding flow must bind its state to the initiating session and tenant, enforce CSRF protection, and obtain the appropriate App user token before invoking the adapter. Existing login and webhook startup remain unchanged.

The adapter first resolves an active, unexpired DogWatch owner session for the requested tenant. It verifies `/user` using the supplied GitHub token and requires its immutable numeric ID to match that session. It then reads the installation using App authentication, requiring the configured App ID, requested installation ID and unsuspended state. The same installation/account must appear in the user's installation list; enumeration is limited to five pages of 100 entries.

For a personal installation, the GitHub account ID must equal the authenticated user's ID. For an organization installation, `/user/memberships/orgs/{org}` must report an active admin membership with the exact organization and user IDs. Ordinary members, pending admins and public repository visibility do not qualify. Organization verification requires the relevant GitHub App organization Members read permission; missing permissions fail closed and are never widened automatically. The installation is reread before persistence to detect suspension or account changes during verification.

## Durable linking

The persistence adapter hashes no credentials itself: the service passes a SHA-256 session hash, tenant, verified GitHub actor ID and installation ID. It revalidates these inputs and locks the current session, user and membership rows in a transaction. That transaction checks session expiry, user disablement, owner role and actor identity again. Revocation updates serialize with the actual link commit instead of relying solely on an earlier membership snapshot. Expiry is rechecked after any wait for a competing installation insert.

The existing globally unique installation ID arbitrates concurrent claims. Repeating the link for the same tenant returns `unchanged`; a new link returns `linked`. A different tenant receives a conflict. Existing manually provisioned links follow the same rules. No installation can be transferred or silently reassigned, even by a user who owns both tenants. Repository descendants and existing runs are not modified. Database errors and timeouts reject; callers may retry after revalidating authority.

The low-level persistence adapter is trusted internal code and cannot independently verify GitHub attestations. Use it through the verified service, not with client-provided actor claims. Linking does not provision repositories, enable opt-in policies, mint worker tokens, grant tenant membership or claim execution eligibility.

## Limits and verification

GitHub identity/membership checks and the database commit are not a distributed transaction. Remote revocation immediately after a successful check remains possible. Every later execution/publication must independently revalidate installation access. Removed or suspended installations cannot be linked through this operation; existing historical links are not deleted or treated as proof of current access. Automatic lifecycle reconciliation, ownership transfer and unlinking are not added here.

Synthetic Octokit tests cover personal/org ownership, App identity, suspension, absent access, bounded scans and changed accounts. `npm run db:verify:installation-link` uses only the local Compose database, tests concurrent linking and cross-tenant conflicts plus local revocation, and removes its random fixtures afterward. Live App permissions and browser onboarding remain unverified. No user/App token, key or report body is retained in link records or returned to callers.

Primary references: [user-accessible installations](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token) and [authenticated organization membership](https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user).

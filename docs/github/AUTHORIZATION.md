# Event authorization — Phase 2.2

This increment adds a real GitHub App adapter and testable event authorization. No App has been registered or installed by this work; no live credential or webhook delivery was used. Eligible events are still **not saved, queued, or tested**. The response explicitly says `eligible_only`, `queued: false` until durable acceptance is implemented in Phase 2.3.

## Two startup modes

With only `GITHUB_WEBHOOK_SECRET`, the API retains Phase 2.1's signature/JSON verification-only behavior. To enable authorization, supply **all** of these shell variables:

- `GITHUB_APP_ID`: positive safe numeric ID of your registered App.
- `GITHUB_PRIVATE_KEY_FILE`: path to its protected PEM private-key file.
- `GITHUB_POLICIES_FILE`: path to an operator-controlled repository policy JSON array.
- `GITHUB_WEBHOOK_SECRET`: the shared random webhook secret.

Partial authorization configuration fails startup rather than silently downgrading. The API does not load `.env` automatically. Choose an ignored `.local` directory or another protected location for real policies and private keys; do not commit them or send them through HTTP. Restart to load edits. Paths are operator configuration, not payload fields.

The [example JSON](policies.example.json) contains invented IDs. Copy it into your protected local policy file and replace every ID with actual verified records before enabling live authorization. Do not use the sample as working installation credentials. The array fields mean:

| Field              | Meaning                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| tenantId           | Operator-assigned organization identity, never a webhook-supplied identity. Use a UUID compatible with the future database. |
| installationId     | Installation of this App assigned to that tenant.                                                                           |
| repositoryId       | Selected GitHub repository's numeric ID.                                                                                    |
| authorizedActorIds | Explicitly approved human GitHub account IDs; dynamic collaborator/team membership is not implemented.                      |
| enabled            | Allows disabling new eligibility decisions on restart.                                                                      |
| label / command    | Exact opt-in label or whole-comment command.                                                                                |

Omitted budgets/languages receive the shared contract's bounded defaults. Unknown fields, duplicate repository policies, or an installation assigned to multiple tenants fail startup. Configuration is a temporary trusted bootstrap, not a persisted onboarding UI. Database installation/tenant consistency must be reconciled when persistence is connected in the next phase. No installation or membership authority comes from this file being valid JSON alone; operators must configure ownership correctly.

## Processing rules

1. Verify signature and bounded raw JSON exactly as Phase 2.1.
2. Ignore unsupported events/actions. Accept only `pull_request` opened/labeled and `issue_comment` created as candidates. Ignore bot actors; malformed supported payloads return 400.
3. Validate the event's installation/repository/actor IDs and PR number. Ignore ordinary issue comments and sender/comment-author mismatches. Require a bounded delivery ID, while recognizing that headers are not covered by the body signature.
4. Find the operator-owned policy. Ignore unknown/disabled repositories, unauthorized actors, ordinary PRs, non-opt-in labels, and prose containing a quoted command. These paths make no GitHub requests.
5. Fetch current installation state using App authentication. Suspended installations are ignored; unavailable/revoked installations cannot produce eligibility.
6. Mint an installation token limited to the selected repository and Metadata/Pull requests read permissions. Fetch canonical repository identity and PR state using that token. No webhook URL is followed.
7. Require matching repository/base/PR identities and an open PR. Deny forks and missing head repositories. Label-triggered runs require the opt-in label still present. Comment commands do not require a label.
8. Normalize tenant identity from policy and SHA from the current PR API response, then apply the existing domain gate. Return only eligibility/trigger or an ignore reason, never policy contents, credentials, or normalized tenant context.

The adapter uses four GitHub requests on an eligible path (installation, token, repository, PR). Each has a two-second request timeout with SDK retries/throttling disabled. This is not a measured under-10-second acknowledgment guarantee or a global concurrency/rate limit. Transient remote errors fail closed with 503; later durable orchestration will establish bounded retries and acceptance latency under load. A label or SHA can change after lookup; later persistence/worker stages must recheck current authority and supersession before privileged work.

Installation lifecycle notifications currently receive unsupported-event acknowledgment. There is no local lifecycle state/cache to mutate yet: current installation and restricted repository grants are checked for each candidate. In-flight cancellation/revocation propagation belongs to orchestration. Signed deliveries can be replayed until deduplication is implemented; eligibility here is not replay prevention.

## Tests and boundaries

Tests cover opened/labeled/comment triggers, trusted tenant/SHA resolution, unauthorized actors, ordinary issues, unknown installations, command prose, forks, closed PRs, removed labels, scope mismatches, malformed inputs, configuration ambiguity, and lookup failures. A synthetic RSA key and transport exercise the actual Octokit auth/request adapter, including token restrictions and suspended/revoked installation behavior, without external calls. Real HTTP tests check the response contract and sanitized failure handling.

`authorization.ts` handles GitHub-to-domain normalization; `github.ts` implements remote verification; `index.ts` loads operator files; `app.ts` composes the signed webhook route. API pre-dev/build/typecheck/test hooks build `@dogwatch/contracts` so a clean checkout need not already contain ignored package output. JSON cannot have comments; this guide explains its fields and scripts.

Implementation follows [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [App installation endpoints](https://docs.github.com/en/rest/apps/apps), and [PR lookup endpoints](https://docs.github.com/en/rest/pulls/pulls). Real App permissions, owner setup, and live behavior must be confirmed when credentials and a reachable endpoint exist.

## Phase 2.3 update

The eligibility-only behavior remains when persistence is absent. With explicit DATABASE_URL and matching registered ownership, [durable acceptance](DURABLE_ACCEPTANCE.md) saves authorized work before acknowledgment and reconciles duplicate deliveries. Queue execution is still not implemented.

## Phase 2.5 stop-only events

The same enabled repository policy and human actor allowlist authorize `/dogwatch cancel` comments and `pull_request.synchronize` events. Cancellation stops unfinished current-SHA runs; synchronize supersedes unfinished different-SHA runs. Both fetch canonical GitHub scope and SHA and retain the existing installation/fork checks. They never create a run. Subscribe the App to pull requests and issue comments. With no database stop handler configured, responses explicitly say `stop_eligible_only`; durable mode returns `stopped` with an affected count. No tenant policy is returned.

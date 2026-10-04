# GitHub App configuration — Phase 2.1

This is a reviewable setup guide, not an already registered GitHub App. No GitHub account was modified, public endpoint created, or private key generated. Registration/live delivery can be completed when a trusted HTTPS endpoint and owner account are available. Until later phases add authorization and durable acceptance, successful deliveries are acknowledged as **verified_only**, with **queued: false**, and discarded.

## Local endpoint

`POST /webhooks/github` verifies `x-hub-signature-256` against the original JSON bytes. The API reads `GITHUB_WEBHOOK_SECRET` from the shell environment; it does not load root `.env`. A missing secret leaves `/health` available but makes webhook requests return 503. A configured secret must be nonblank and at least 32 characters; generate it randomly rather than repeating a predictable phrase.

For local startup without printing or committing a secret:

```sh
export GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
npm run dev -w @dogwatch/api
```

This local secret is separate from a GitHub App private key, OAuth client secret, and synthetic fixture tokens. Store the same secret securely in the future GitHub App's webhook settings. Do not paste it into PR comments, logs, screenshots, or a repository file. Restart the API when changing the secret; rotation/multiple-secret handling is not implemented yet.

The API listens on loopback. GitHub requires a reachable webhook endpoint; choose a trusted HTTPS hosting/forwarding setup before live testing. Forward only the needed route, preserve raw bytes, retain TLS validation, and do not expose Postgres/Redis. This phase does not install or start a tunnel.

## Registration plan

Follow [GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app): choose a personal/organization owner, register an available app name, provide its real homepage, enable webhooks, and set the trusted HTTPS URL ending in `/webhooks/github` and the shared secret. Keep the development App private and install it only on selected test repositories. Dashboard OAuth/callback settings belong to later onboarding; do not invent a working login URL now.

Initial repository permissions and events for future Phase 2.2:

| Permission    | Initial access        | Purpose                                                   |
| ------------- | --------------------- | --------------------------------------------------------- |
| Metadata      | Read (GitHub default) | Installation/repository identity.                         |
| Pull requests | Read                  | PR details and pull_request events.                       |
| Issues        | Read                  | issue_comment events, including PR conversation commands. |

Subscribe to `pull_request` and `issue_comment`; plan installation lifecycle handling for removal/suspension and repository-access changes. Normalization must distinguish issue comments from PR comments and allow only approved actions. A signed payload or event header alone does not authorize a tenant or actor.

Add permissions only when their consumer is implemented: Contents read for source/diff analysis, Deployments read for preview metadata, Issues write (or Pull requests write as supported by the comment endpoint) for reporting, and Checks write for check results. Do not grant Contents write, Actions write, administration, organization membership access, or all-repository access merely for webhook verification. Reassess exact endpoint permissions in those phases. See [GitHub issue comment permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

Record the App ID and protected private-key reference for the later installation authentication adapter, not in queue payloads. The current API does not use an App ID, private key, installation token, or Octokit, so those credentials need not be created to run its tests.

## HTTP behavior

| Input                                              | Result                                             |
| -------------------------------------------------- | -------------------------------------------------- |
| Secret unset                                       | 503, webhook disabled.                             |
| Missing/wrong/malformed signature                  | 401.                                               |
| Non-JSON media type or compressed body             | 415.                                               |
| Payload larger than 1 MiB                          | 413.                                               |
| Valid signature, malformed JSON or non-object JSON | 400.                                               |
| Valid signed JSON object                           | 200 with `status: verified_only`, `queued: false`. |

Body limits and encoding checks can occur before authentication to bound resource use. Valid JSON is parsed only after signature verification. No event-specific schema, delivery deduplication, opt-in decision, tenant mapping, queue dispatch, or database write is performed. A replayed signed body can verify again: HMAC alone does not prevent replay, and event/delivery headers are not included in GitHub's body signature. These limitations belong to the next phases.

Tests include the [official GitHub signature test vector](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), byte changes, Unicode, whitespace, bad signatures, signed malformed JSON, body limits, unsupported encoding, and absent configuration. Synthetic HTTP tests are not proof of a live GitHub delivery, production latency, or upstream rate limiting.

## Implementation files

`src/webhook.ts` uses Node crypto to compute HMAC-SHA256 and compare equal-length decoded digests with `timingSafeEqual`. `src/app.ts` installs the route-specific raw parser before parsing JSON, exposes a factory for tests, and returns sanitized errors. `src/index.ts` validates process configuration and starts the listener. Test files are excluded from production TypeScript output and executed separately through the API workspace's `test` script. Every source file documents its role inline.

## Phase 2.2 update

The verification-only behavior above is retained when only the webhook secret is configured. The [authorization guide](AUTHORIZATION.md) describes the new optional policy/App-credential configuration, supported-event filtering, current GitHub checks, and eligibility-only responses. Runs are still not durably accepted.

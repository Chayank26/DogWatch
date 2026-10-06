# Durable webhook acceptance — Phase 2.3

Authorized requests can now be recorded in Postgres. Queue dispatch is not implemented. An accepted response means **stored durably**, not that testing started.

## Enable it

1. Start local infrastructure and apply migrations with `npm run infra:up` and `npm run db:migrate`.
2. Configure App authorization following [the authorization guide](AUTHORIZATION.md).
3. Create verified tenant/installation/repository records through an operator-controlled database session. Their ownership must match the policy file. The endpoint never creates or transfers ownership from webhook claims.
4. Export `DATABASE_URL` in the API's shell environment and start the API. Database tools can load root `.env`; the API still does not automatically load it.

Without DATABASE_URL, authorization-enabled requests retain `eligible_only`. Supplying DATABASE_URL without complete authorization fails startup. An unreachable/unmigrated database prevents durable acceptance with a sanitized 503. The health endpoint remains a process check, not database readiness.

For local testing only, this operator SQL demonstrates the invented example IDs. Replace them with verified actual records for real setup. Run it in an explicit transaction; do not add an automatic upsert that can transfer ownership:

```sql
BEGIN;
INSERT INTO "Tenant" ("id", "name")
VALUES ('11111111-1111-4111-8111-111111111111', 'Synthetic PawMart');
INSERT INTO "Installation" ("id", "tenantId")
VALUES (10, '11111111-1111-4111-8111-111111111111');
INSERT INTO "Repository" ("id", "tenantId", "installationId", "fullName")
VALUES (20, '11111111-1111-4111-8111-111111111111', 10, 'fixture/pawmart');
COMMIT;
```

This example is documentation, not a seed automatically applied by DogWatch. Real App access must also pass current GitHub checks. Authenticated onboarding and least-privilege/row-level database access remain later requirements.

## Stored data and transaction

For an eligible signed event, ingress computes SHA-256 over its raw authenticated body. The persistence boundary revalidates the event/policy and opt-in decision, locks/checks the repository's tenant and installation relationship, and creates all three records in one transaction:

- `Run`: original delivery identity, exact tested SHA, PR number, received progress, effective policy/trigger, and budget snapshot.
- `WebhookDelivery`: delivery ID, unique raw-body fingerprint, event name, tenant and run linkage, and acceptance time.
- `OutboxEvent`: one `run.requested` instruction linked to the same tenant/run.

No raw webhook body, comment text, private key, installation token, screenshot, or test-account secret is stored. Fingerprints are deduplication identifiers, not encryption or a replacement for signature verification. The stored local policy contains approved actor IDs; retention for receipt/run history must be defined before production.

A shared repository-row lock prevents operator ownership updates racing the acceptance check. Composite foreign keys and unique indexes remain database enforcement. A failure rolls back the entire transaction. Ingress waits for commit before returning 202 with `status: accepted`, `runId`, and `queued: false`.

## Duplicate and conflicting deliveries

Concurrent copies race on database uniqueness, not process-local memory. After a unique violation rolls back, the loser reconciles against committed receipts. A matching receipt returns 200 with `status: duplicate` and the same run ID. The originally accepted SHA/policy remains authoritative even if a redelivery's fresh lookup sees a newer head.

The same exact signed body under a changed delivery header is also a duplicate. Reusing a delivery ID for different bytes or conflicting scope/event returns 409; ownership mismatch returns 403. Unknown database/upstream failures return 503 and never claim acceptance.

Exact-body deduplication is deliberately conservative: byte-identical legitimate notifications collapse while the receipt is retained. Differently serialized bodies produce different fingerprints. This is delivery replay protection, not semantic deduplication of different user requests, nor a proof of freshness. Ignored and malformed events do not produce receipt rows. Every request still goes through current authorization first, so a revoked or now-ineligible redelivery may be ignored rather than return the historical duplicate outcome.

## Verification and next boundary

`npm run db:verify:acceptance` uses random fixture tenants and committed transactions to test concurrent copies, fingerprint replay under new headers, immutable snapshots, identity conflicts, ownership mismatch, and failure cleanup. Unlike the older rollback-only verification, it briefly commits fixture rows and deletes only its exact random-owned records afterward. Do not interrupt it unnecessarily; an interruption may leave clearly named fixture records for operator cleanup. It does not reset the database.

HTTP unit tests inject the persistence boundary and verify 202 responses happen after it resolves and storage failures return sanitized 503. CI's data-services job runs the real database verification. Live GitHub delivery and hosted CI remain unverified.

Outbox records remain unpublished and runs remain received. No Redis job, browser/model request, or GitHub report is created. Phase 2.4 will implement dispatch/retries; budgets, lifecycle cancellation, run leases, and preview identity are later work. Under-10-second acceptance latency is not yet validated under load.

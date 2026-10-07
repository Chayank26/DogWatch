# Local database package

This package owns the schema, committed migration history, generated Prisma client, and an explicit connection factory. It is not connected to the website, API, or worker yet.

## Start and migrate

From the repository root, with Docker running:

```sh
npm ci
npm run infra:up
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:status
npm run db:verify
```

The CLI and verification command use the disposable local URL by default. Optionally copy `.env.example` to `.env`; existing shell variables take precedence. Postgres listens on loopback port 5433 and Redis on 6380 to reduce conflicts with common local installations. Redis is started and health-checked but has no application client or queue consumer yet.

`infra:down` stops the containers and removes the project network while preserving named volumes. No command automatically deletes volumes. Container images are pinned to major release families, not immutable digests; production image selection and patch upgrades belong to deployment work. Compose credentials are deliberately public local fixtures and must never be used on hosted services.

## What the initial schema stores

- `Tenant`: organization ID and name.
- `Installation`: GitHub installation assigned to a tenant.
- `Repository`: GitHub repository assigned to that tenant's installation.
- `Run`: exact PR head SHA, delivery identity, progress, and redacted policy/budget snapshots.
- `OutboxEvent`: one dispatch instruction per run/kind, saved in the same transaction when ingress is implemented.

Composite foreign keys prevent mismatched tenant relationships. Unique delivery IDs prevent duplicate accepted-run identities. Custom SQL checks validate positive IDs/PR numbers, hexadecimal SHA shape, and JSON object snapshots. Read authorization and row-level security are **not implemented**: the local migration user owns the database. Do not expose this database or factory as a multi-tenant production service. Membership, findings, artifacts, and worker leases will be added when their phases need them.

`db:verify` writes synthetic tenants, installation, repository, run, and outbox rows in a transaction, reads the result, deliberately rolls it back, and verifies no fixture records remain. It also checks that a cross-tenant relationship is rejected. It does not seed customer data or delete existing records.

## Generated files and configuration

Do not edit `src/generated` or `dist`; both are ignored and recreated by generation/build. `prisma.config.ts` loads root environment settings and locates the schema and migrations. `prisma/schema.prisma` explains each model and relation inline. SQL migrations are reviewed history: change the schema with a new migration rather than rewriting a migration already applied by another developer.

`package.json` marks the package private and ESM, exposes compiled code/types, and defines generate, validate, migrate, status, verify, build, and typecheck scripts. The TypeScript configuration inherits strict root checks, compiles Node ESM from `src` to `dist`, and emits declarations for future consumers. Prisma needs generation before type checking because its types depend on the schema. The root scripts delegate to this workspace; build/typecheck do not contact a live database.

The `createDatabase` factory accepts a URL explicitly, caps its connection pool at five, and returns a client whose caller must disconnect on shutdown. The local verification script loads environment settings; the factory itself does not read files or silently open a global client.

Prisma configuration and PostgreSQL adapter setup follow the [official Prisma Client documentation](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction).

## Known toolchain advisories

The Prisma 7.10.0 development CLI dependency tree currently has four high-severity npm audit entries. They concern `deepmerge-ts` recursive merging and `mysql2` protocol behavior, propagated through Prisma configuration/CLI packages. This project does not use MySQL or accept remote input into CLI configuration. Do not expose the migration CLI as a service or apply `npm audit fix --force` blindly: its suggested Prisma major downgrade conflicts with this configuration. Reassess compatible dependency patches before deployment.

The same advisories appear with `npm audit --omit=dev` through npm's workspace/peer dependency graph; this is not a clean production audit. Runtime image dependency isolation must be verified in the deployment phase, even though the client factory does not invoke the CLI.

## Phase 2.3 update

The additive receipt migration enables `acceptDelivery` and database-enforced delivery/body deduplication. See [durable acceptance](../../docs/github/DURABLE_ACCEPTANCE.md) for setup, transaction semantics, and limitations. `npm run db:verify:acceptance` tests actual committed operations and cleans up only exact random fixture tenants; it is separate from the original rollback-only check. Package lifecycle hooks build contracts before consumers run.

## Run stop signals

`stopRuns` validates trusted policy and actor context, locks the owned repository, and conditionally stops unfinished matching runs. `canExecuteRun` checks tenant ownership and an executable state; future executors must call it and use guarded state transitions/abort cleanup. These functions do not authenticate a browser caller, create execution leases, or delete queue evidence. The acceptance verification now checks supersession, cancellation, repeated stops, ownership rejection, and stopped dispatch.

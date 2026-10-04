# CI checks

`.github/workflows/ci.yml` runs on pushes, pull requests, and manual requests. It performs repository checks only, without deployments, model keys, GitHub App secrets, or write permissions. It uses `pull_request`, not the privileged `pull_request_target` trigger. Hosted runs begin when this workflow is pushed to a GitHub repository with Actions enabled; no hosted run is claimed by local verification.

The `verify` job uses Node 24, installs the lockfile, validates the database schema, checks types/lint/format, runs contract and fixture HTTP tests, and builds all workspaces. It needs no database connection. The `data-services` job uses disposable Postgres/Redis through the same Compose file as developers, applies migrations twice to check repeatability, inspects status, runs rollback-only database verification, and checks Redis PING. Failure diagnostics precede unconditional service shutdown.

Both jobs have a 15-minute timeout and read-only contents permission. Checkout does not retain credentials. npm caching caches downloads rather than treating an old `node_modules` folder as an installation. New revisions cancel obsolete CI work. The known Prisma advisory limitation documented in the database README remains; dependency audit is not silently labeled clean or used as a passing security gate here.

Local equivalents:

```sh
npm ci
npm run db:validate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run infra:up
npm run db:migrate
npm run db:migrate
npm run db:status
npm run db:verify
```

Verify Redis with `docker compose exec -T redis redis-cli ping`; expect PONG. Use `npm run infra:down` when finished. Ordinary shutdown preserves volumes. GitHub-hosted jobs have disposable runner storage; local volumes are not automatically deleted.

Workflow choices follow the official [setup-node documentation](https://github.com/actions/setup-node) and [GitHub container service guidance](https://docs.github.com/en/actions/tutorials/use-containerized-services). Exact hosted execution must still be confirmed after pushing.

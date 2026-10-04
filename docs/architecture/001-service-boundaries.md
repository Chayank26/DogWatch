# ADR 001 — Separate the control plane from QA execution

**Status:** Accepted design; partially scaffolded.  
**Phase:** Part 1, Phase 1.3.

## Problem

Webhook requests should finish quickly, while browsers, API probes, and model calls can take minutes and process hostile input. Running them in the request handler would couple request availability to heavy work and make failures harder to contain.

## Decision

- `apps/api` is the Express control plane: future webhooks, authorization, configuration, run queries, and dispatch requests. It never runs repository scripts or browser sessions inside a webhook request.
- `apps/web` is the Next.js user interface. Rendering a page does not grant installation permissions; authorized control APIs remain the authority for mutations and protected data.
- `apps/worker` executes bounded QA jobs. Production orchestration must provide a separate restricted execution environment per run, rather than assuming an ordinary long-lived process is isolation.
- Shared packages hold domain contracts and reusable logic. Keep providers and infrastructure behind adapters so tests can use synthetic fixtures.
- Initial workers inspect source at an immutable SHA without executing install hooks, build scripts, or arbitrary repository commands. Users supply already deployed previews. Running application builds would require a separate future threat model.

## Alternatives

A single server could host everything with fewer services, but heavy jobs could consume resources needed for webhooks and tenant APIs. GitHub Actions could host execution closer to repositories, but would introduce workflow installation, runner trust, and secret-management behavior beyond the selected hosted model. Microservices for every tier would add deployment and communication overhead before workload evidence warrants it.

## Consequences and verification

Local development has three entry points. Later phases must enforce CPU, memory, wall-clock, filesystem, credential, and network boundaries around each run. Containers are one layer, not proof of isolation; do not expose a Docker socket or enable privileged execution. Verify that a terminated worker does not take down ingress and that one run cannot read another run's workspace.

Provider selection and concrete container policies are deferred to isolation and deployment phases. A preview can itself proxy requests elsewhere; synthetic accounts and disposable data remain necessary even with worker egress restrictions.

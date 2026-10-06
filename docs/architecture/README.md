# Architecture decisions

These records explain intended implementation choices, their alternatives, and consequences. **Accepted design** means a direction has been selected for future phases; it does not mean its controls are implemented. Changes to a decision should receive a new record that explicitly supersedes it, rather than silently rewriting history.

| Record                                    | Decision                                                           | Implementation status                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [ADR 001](001-service-boundaries.md)      | Separate control plane, web UI, and isolated execution             | App shells exist; isolation and integrations are planned.                        |
| [ADR 002](002-durable-runs.md)            | Postgres source of truth, transactional outbox, at-least-once jobs | Atomic ingress persistence and receipt deduplication exist; dispatch is planned. |
| [ADR 003](003-authority-and-isolation.md) | Verified authority, explicit opt-in, tenant-scoped access          | Pure opt-in rules are tested; authentication and isolation are planned.          |
| [ADR 004](004-agent-and-evidence.md)      | Constrained model actions and evidence-backed verdicts             | Contract validation exists; agent execution and aggregation are planned.         |

Read the [threat model](../security/THREAT_MODEL.md) alongside these records. The [roadmap](../../ROADMAP.md) controls phase order. No cloud provider, model provider, container runtime security configuration, authentication library, or artifact retention duration is finalized here.

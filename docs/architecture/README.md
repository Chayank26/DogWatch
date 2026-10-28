# Architecture decisions

These records explain intended implementation choices, their alternatives, and consequences. **Accepted design** means a direction has been selected for future phases; it does not mean its controls are implemented. Changes to a decision should receive a new record that explicitly supersedes it, rather than silently rewriting history.

| Record                                    | Decision                                                           | Implementation status                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [ADR 001](001-service-boundaries.md)      | Separate control plane, web UI, and isolated execution             | API/dashboard/dispatcher and local containment are verified; production QA integration remains pending.              |
| [ADR 002](002-durable-runs.md)            | Postgres source of truth, transactional outbox, at-least-once jobs | Atomic ingress, receipt deduplication, outbox dispatch and recovery drills are verified locally.                     |
| [ADR 003](003-authority-and-isolation.md) | Verified authority, explicit opt-in, tenant-scoped access          | Optional OAuth, membership/owner controls and real tenant checks exist; hosted boundaries remain gated.              |
| [ADR 004](004-agent-and-evidence.md)      | Constrained model actions and evidence-backed verdicts             | Callable constrained loops, scoped evidence, deduplication and rendering exist; live orchestration remains disabled. |

Read the [threat model](../security/THREAT_MODEL.md) alongside these records. The [roadmap](../../ROADMAP.md) controls phase order. Cloud/model provider selection, hosted execution and retention policy remain open. Consult the [current security evidence](../security/VALIDATION.md) and [release runbook](../../ops/release/README.md) for implemented controls and remaining gates.

# DogWatch portfolio and pilot preparation

DogWatch explores evidence-backed QA for explicitly opted-in pull requests. The
repository demonstrates durable ingress/handoff, scoped QA primitives, local
private evidence, constrained browser actions and measurable operational checks.
**It is a local engineering demonstration, not a deployed autonomous QA service.**

## Start here

- [Walkthrough and synthetic demo recipes](WALKTHROUGH.md)
- [Rendered synthetic report](sample-report.md)
- [Pilot gates, proposed protocol and acceptance worksheet](PILOT.md)
- [Architecture decisions](../architecture/README.md)
- [Implementation roadmap](../../ROADMAP.md) and [current flow](../../flow.md)

## Claims and supporting evidence

| Demonstrated capability                          | Evidence                                                                                      | Boundary                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Durable acceptance and retained queue identities | [Queue guide](../../packages/queue/README.md), [recovery drill](../../ops/recovery/README.md) | Handoff is not completed QA execution                                                                           |
| Callable HTTP and browser checks                 | [Worker guide](../../apps/worker/README.md), [fixture](../../apps/fixture/README.md)          | Production consumer/orchestration remains disabled                                                              |
| Scope/authority checks and private evidence      | [Security matrix](../security/VALIDATION.md)                                                  | Local checks are not hosted isolation certification                                                             |
| Synthetic labeled evaluation                     | [Benchmark](../../benchmarks/pawmart-v1/README.md)                                            | Six authored defects, no held-out real-PR accuracy claim                                                        |
| Recovery and operability                         | [Monitoring](../../ops/monitoring/README.md), [recovery](../../ops/recovery/README.md)        | No production notification receiver or full-system failover                                                     |
| Production-build rehearsal                       | [Release evidence](../../ops/release/README.md)                                               | Local processes/disposable services; no cloud/TLS deployment                                                    |
| Report generation                                | [Sample](sample-report.md) and `npm run portfolio:verify`                                     | Renderer verifies synthetic local artifact scope/integrity; no GitHub publication or new-regression attribution |

The benchmark recorded HTTP-only recall of 5/6 seeded defects, increasing to 6/6
with scripted UI assertions. Six of 126 repeated observations were inconclusive;
these are visible in the report. This says nothing about a model agent's incremental
contribution or “90% accuracy” on real pull requests. Source-digested benchmark,
security and release snapshots are historical milestone evidence; rerun their
commands to assess a changed checkout.

## Engineering choices worth discussing

PostgreSQL is authoritative and the transactional outbox separates acceptance
from transport. Retained Redis identities handle an acknowledged enqueue followed
by DB rollback. That is at-least-once coordination, not exactly-once side effects.

Model/page content proposes actions; trusted schemas, grants, destination policy,
authority rechecks and budgets constrain execution. The offline diagnostic sandbox
is verified separately from browser fixture adapters. Combining these into secure
customer execution still requires production orchestration and enforced egress.

Evidence is scoped and integrity-checked before rendering. Missing baseline data
remains unavailable, private evidence has no public links, and incomplete coverage
is reported rather than converted to a pass. Usage reservations remain occupied
until trusted measured settlement; failure does not imply zero consumption.

## Honest project status

All planned implementation steps now have local deliverables, including this
portfolio/pilot-preparation pack. The broader live-release completion gate is **not
met**: no opted-in customer PR has completed the complete pipeline. Cloud hosting,
production QA consumption, hosted evidence, live provider validation and the pilot
remain outstanding. There are no invented pilot participants, customer testimonials,
demo PR URLs, production costs or success-rate claims in this pack.

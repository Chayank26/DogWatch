# Pilot preparation — not launched

**Decision: NO-GO for customer QA execution.** This worksheet is a proposed plan,
not an agreed pilot contract or operational authorization. No repositories,
participants, dates, owners or provider budget have been committed.

## Entry gates

| Gate                                       | Current status  | Evidence needed to proceed                                                               |
| ------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| Provider/account/domain and operator owner | Unselected      | Named owner, cost envelope and reviewed infrastructure plan                              |
| Cloud/TLS/secrets/data services            | Not deployed    | Staging deployment, managed credentials, backups and restore rehearsal                   |
| Full scoped PR-to-report path              | Incomplete      | Opted-in staging PR reaches truthful terminal state, settled usage and authorized report |
| Hostile-preview execution                  | Blocked         | Enforced egress, credential isolation/redaction, cancellation and orphan recovery        |
| Live GitHub App/OAuth                      | Unverified      | Correct permissions, callbacks, install/revoke behavior and report ownership             |
| Hosted evidence                            | Not implemented | Tenant-authorized access, expiry/deletion, encryption and retention policy               |
| Independent security/dependency review     | Pending         | Review findings resolved or explicitly accepted by a responsible owner                   |
| Held-out labeled real PRs                  | Not collected   | Human-reviewed clean/broken changes and independent defect labels                        |
| Pilot acceptance thresholds                | Not agreed      | Written category coverage, precision/recall, cost/runtime and abstention targets         |

The [security](../security/VALIDATION.md), [release](../../ops/release/README.md)
and [recovery](../../ops/recovery/README.md) runbooks remain authoritative gates.
Local tests and scripted recordings do not waive any row above.

## Proposed protocol after gates pass

1. Obtain explicit consent from a small number of repository owners. Record the
   repository/installation IDs, permitted actors, opt-in trigger, approved preview
   origin, disposable identity/data scope, limits and revocation contact.
2. Start with staging-only, nonblocking checks and human review before publication.
   No production transactions or arbitrary repository install scripts. Agree
   evidence handling and retention before transmitting real data to any provider.
3. Define a held-out corpus with clean controls and representative defect categories.
   Review labels independently of detector output. Keep authoring/training cases
   separate from evaluation cases and preserve base/head source identity.
4. Record each run's scope, configuration/version, coverage, abstentions, findings,
   reproduction, baseline status, human adjudication, actual resource use and
   publication outcome. Do not aggregate retries as independent defects.
5. Review false positives, missed defects and inconclusive cases together. Report
   category denominators and uncertainty; compare deterministic checks with the
   actual model agent only once that path is implemented and measured.
6. Stop new work for scope violations, secret exposure, uncontrolled spending,
   destructive behavior or unreconciled duplicate side effects. Preserve evidence,
   revoke access as appropriate and follow the recovery/incident procedure.

## Acceptance worksheet to agree before launch

| Field                                      | Required decision                                                   |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Accountable operator and repository owners | Names and escalation contact                                        |
| Repository list and permitted workloads    | Explicit installation/repository/preview grants                     |
| Start/end and review cadence               | Dates chosen by participants                                        |
| Category quality/coverage targets          | Per-category precision, recall, abstention and minimum sample sizes |
| Cost and latency limits                    | Measured per-run/tenant ceilings, stop conditions and funding owner |
| Data retention/provider policy             | Approved storage, access, expiry and deletion plan                  |
| Publish/merge policy                       | Human approval and nonblocking/blocking rules                       |
| Success/stop/extension decision            | Written owner sign-off with evidence and unresolved risks           |

The current six-defect synthetic benchmark cannot establish these targets or
supply statistically meaningful evidence for a general 90% detection claim.

## Work after the planned phases

Select hosting and address the live-release prerequisites first. Then connect the
existing callable QA stages through a durable, cancellable production worker,
implement private hosted evidence and measured settlement/report reconciliation,
and prove the full path on an explicitly authorized staging repository. Only after
those gates should owner onboarding and a live pilot begin. This is substantive
remaining engineering work, not merely publishing the local demo.

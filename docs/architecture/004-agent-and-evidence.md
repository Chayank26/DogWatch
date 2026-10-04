# ADR 004 — Give the model observations, not authority

**Status:** Accepted design; contracts exist, execution is planned.  
**Phase:** Part 1, Phase 1.3.

## Problem

A browser agent sees untrusted pages and can misinterpret behavior. It may encounter instructions asking it to reveal secrets or take unsafe actions. A confident model description is not sufficient evidence of a regression.

## Decision

Treat source code, comments, screenshots, accessibility snapshots, and HTTP responses as untrusted observations. The model proposes actions in a validated schema. Executor code separately enforces allowed targets, actions, credentials, and budgets. Prompt wording is an additional precaution, not the enforcement boundary.

Track limits outside the model: elapsed time, API calls, browser actions, model calls, token use, and model cost. Reserve capacity before calls where possible and stop when any limit is reached. Streaming/timeouts, retries, parallel requests, and failed calls must be accounted for. Concrete spend enforcement requires provider-specific usage and maximum-cost estimates; schema bounds alone do not enforce actual spend.

Capture redacted evidence linked to run ID and exact SHA. Confirm suspected failures through replay where feasible, compare with a compatible base when available, and explicitly disclose missing baseline context. Expected authorization denials are not failures just because they are HTTP 4xx. Distinguish confirmed observations, possible regressions, skipped coverage, and inconclusive checks.

Treat screenshots and traces as potentially sensitive even after redaction. Prefer authenticated evidence access for sensitive content. Signed links are bearer capabilities: use short expiration and do not publish them onto public PRs unless the artifact access policy permits that audience. Escape or neutralize attacker-controlled Markdown/HTML and mentions when rendering reports; report publication must not amplify hostile page instructions.

## Alternatives

Giving the model direct browser or shell authority makes prototyping easier but bypasses external policy enforcement. Fixed scripts are more predictable but miss some exploratory coverage, so keep them for smoke checks and reproducibility alongside the agent. Treating every observed failure as new avoids baseline setup but misattributes existing defects. Public artifact buckets simplify linking but expose tenant evidence.

## Consequences and verification

Exploration may stop with incomplete coverage; disclose that honestly. The initial finding schema requires nonempty evidence references, but storage authorization, evidence truth, and rendering safety remain future responsibilities. Test injected page instructions, invalid actions, forbidden navigation, destructive attempts, budget exhaustion, redaction, and evidence access. Benchmark precision and recall before making detection-rate claims.

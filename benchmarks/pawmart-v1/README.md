# PawMart v1 labeled benchmark

Phase 8.4 provides a reproducible **synthetic development benchmark**, not a
real-PR accuracy claim or a pilot release gate. It evaluates fixed, fixture-specific
HTTP probes and the existing scripted Chromium driver. It does not evaluate the
model-driven browser agent, production orchestration, contract-generated checks,
GitHub PR ingestion, real authentication providers or customer deployments.

## Repeat and review

```sh
npm run benchmark:verify
```

Requires the project's installed Chromium/Playwright and permission to bind local
loopback ports. The command builds PawMart, accepts no target arguments, starts
fresh ephemeral fixtures for every case/category/repetition, closes servers and
browsers, and writes `.local/benchmarks/pawmart-v1.json`. It makes no model, GitHub,
PostgreSQL, Redis, payment or customer requests. A browser-startup failure stops
execution; probe errors are inconclusive, never evidence of a defect.

[results.json](results.json) is the reviewed implementation-run snapshot. A new
run does not overwrite this checked-in snapshot automatically. Compare its
source digest before comparing results: the digest covers the corpus, probes,
runner, browser driver, smoke primitives, fixture source/assets and lockfile.
The report includes the exact Node/Chromium/platform versions, every observation,
fixed reason codes, runtime distributions and request accounting. Raw bodies,
page text, credentials and screenshots are not recorded.

## Labels and independence

| Case                         | Target variant        | Defect label   | Ground truth                                                       |
| ---------------------------- | --------------------- | -------------- | ------------------------------------------------------------------ |
| clean                        | healthy               | None           | Healthy controls and checkout validation                           |
| invalid-address-server-error | missing-address-500   | api            | Blank address yields 500 instead of 400                            |
| missing-auth-accepted        | authentication-bypass | authentication | Missing bearer can read protected identity                         |
| foreign-order-readable       | ownership-bypass      | ownership      | Alice can read Bob's order                                         |
| customer-admin-report        | role-bypass           | role           | Customer can read the administrator report                         |
| validation-ui-stuck          | checkout-stuck        | ui             | Rejected checkout remains on Processing                            |
| quantity-write-read-loss     | quantity-lost         | coupled        | Quantity 2 submitted to order creation is persisted/read back as 1 |

The fixture selects faults at construction; probes receive only the loopback
origin and category, never the fault mode or expected labels. Scoring consumes
labels afterward. Every category runs against every variant, including negative
controls, three times. Fixed inputs and fresh in-memory state make this a
repeatability experiment, not randomized discovery. One positive variant per
category is a very small, deliberately easy development set. Faults and detectors
were authored together; there is no held-out corpus or independent labeling.
Variants are synthetic changes, not actual base/head PR pairs.

The UI check uses the existing bounded, same-origin fixture browser driver. It
asserts the validation message; expected HTTP 400 console diagnostics alone do
not constitute a UI defect. It is a scripted assertion, not autonomous exploration.
The coupled case checks POST→stored state→GET consistency within PawMart; it does
not represent distributed-service or arbitrary coupled-module coverage.

## Scoring

The unit of scoring is `(case, category, repetition)`: 7 × 6 × 3 = 126 rows,
representing 42 unique case/category cells and only six distinct seeded defects.
Repeated trials are not independent examples and must not inflate claims about
sample size.

- Precision = TP / (TP + FP); recall = TP / (TP + FN).
- False-positive rate = FP / (FP + TN), over conclusive negative observations.
- Inconclusive/not-run positive observations count as FN. Inconclusive/not-run
  negatives do not become TN; their counts and coverage are always reported.
- Undefined ratios are `null`, never a fabricated 0% or 100%.
- Missing/duplicate/foreign/malformed rows invalidate scoring.
- Reproducibility measures identical observation states across repetitions for
  each unique cell. Stable inconclusive results are still inconclusive.
- HTTP-only scores mark UI observations not-run. The combined result adds scripted
  UI checks. Model-agent incremental contribution stays `not_evaluated`/`null`.

## Observed implementation run

| Measurement                            | HTTP only | HTTP + scripted browser |
| -------------------------------------- | --------: | ----------------------: |
| True positives (repeated observations) |        15 |                      18 |
| False positives                        |         0 |                       0 |
| False negatives, including not-run     |         3 |                       0 |
| True negatives                         |        84 |                     102 |
| Inconclusive                           |         6 |                       6 |
| Not run                                |        21 |                       0 |
| Precision                              |      100% |                    100% |
| Recall                                 |     83.3% |                    100% |
| Conclusive coverage                    |    99/126 |                 120/126 |

All 42 unique cells were stable across three repetitions. The complete measured
run took 10,633 ms on the recorded machine. Per-category median/p95 times are in
the JSON. Scripted UI checks added one unique seeded defect (16.7 percentage
points of recall here). This does **not** establish 90% accuracy on real PRs.

The six inconclusive rows are ownership and role probes on the authentication-
bypass variant, each repeated three times: their independent allowed-identity
controls fail because that variant treats every bearer as Alice. These are coverage
gaps, not false negatives for the labeled authentication defect or clean outcomes.

Model calls/tokens/model cost are zero because this workload uses no model.
Total monetary cost is unknown (`null`): host/browser energy and infrastructure
cost are not metered. HTTP-probe requests are counted, while browser network
request cost/count is not measured. Runtime is observed, not a production SLA.

No pilot threshold has been agreed. Successful command execution means a complete
measurement report was produced; it does not assert a score threshold or release
approval. Before a pilot claim: add independently labeled held-out real PRs,
more clean controls and defect diversity, paired base/head attribution, a genuine
model-agent comparison, measured total cost and an agreed quality/coverage gate.
Phase 8.5 separately addresses security validation.

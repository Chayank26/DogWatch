# Deterministic API boundary cases

Part 4.2 adds `generateBoundaryCases(context, contractText, options?)` in `src/boundary-cases.ts`. It validates the immutable tenant/repository/head context and reuses Phase 4.1 ingestion internally, so callers cannot substitute a forged normalized inventory. The result includes version, source contract digest, seed, reproducible case IDs, logical request descriptors, coverage gaps and `executionAuthorized: false`.

No requests are sent, URLs constructed, credentials obtained, resources created or application results inferred. Cases are inputs to the future authorized executor. Request execution, rate limits, wire serialization and response assertions belong to Phase 4.3; authentication and ownership probes remain later phases.

```ts
const plan = generateBoundaryCases(authorizedContext, operatorContractText, {
  seed: 42,
  maxCases: 50,
  operationAllowlist: [{ method: 'POST', path: '/api/orders' }],
  fixtures: [
    {
      method: 'POST',
      path: '/api/orders',
      bodyJson: '{"address":"1 Test Lane","quantity":2}',
    },
  ],
});
```

## Selection and reproducibility

`operationAllowlist` restricts selection by exact uppercase method and contract path; omission selects all supported operations, while an empty list selects none. Unknown selectors and duplicate/unknown fixture operation identities are configuration errors. An allowlist permits planning only and does not authorize mutations or API access.

Optional `priority` contains tenantId, repositoryId, headSha and an `operations` selector list. Its scope must match the contract context. A trusted caller can derive that list from the head snapshot's API targets in Phase 3.3 impact output. Base-only targets must not be selected for head execution. Priority operations sort first, then all ties sort lexically. Each feasible operation gets one baseline before round-robin mutations, subject to the global limit. This avoids exhausting the entire budget on the first operation's variants.

Automatic baselines use deterministic synthetic values satisfying the modeled constraints. Optional fixtures provide a JSON body and/or primitive parameter values for known synthetic resources such as `order-alice`. Parameters omitted from a fixture are synthesized. A fixture body must satisfy the modeled request schema; it is not silently repaired or replaced. Unknown parameter identities, invalid data, unmodeled constraints or a baseline exceeding limits produce an operation coverage gap.

The seed is an unsigned 32-bit integer. It affects synthetic value choices and case identities; fixed constraints can still yield the same payload across seeds. IDs hash generator version, tenant/repository/SHA, original contract digest, seed, operation identity and canonical logical request. Equal requests within an operation are deduplicated even if several mutation rules reach them. Returned requests have independent data snapshots. Editing a case changes what its ID represents; a future executor must verify identity and revalidate inputs before use.

## Case families and assertions

Generated families include a baseline, missing body/required fields/parameters, wrong types, null, malformed JSON, unexpected properties, string lengths, numeric bounds and fractional integer inputs, enum outsiders, array lengths and duplicate items. Nested mutations carry a JSON-pointer-style location. Arrays sample nested mutations through their first baseline item. This is a finite representative rule set, not exhaustive fuzzing or a guarantee to find every constraint interaction.

`inputValidity` is `valid` or `invalid` for the modeled logical request. It is computed after mutation against the full request schema, not inferred from the mutation's name. For example, an allowed extra property, an omitted optional parameter, an inclusive numeric boundary or an allowed null remains valid. Nullable does not override an enum excluding null. A mutation can violate multiple constraints; its kind describes the edit, not a uniquely isolated cause.

A schema-valid synthetic request can still fail business rules, reference a nonexistent resource or require authentication. A schema-invalid request is not an application finding. The executor must preserve the intended wire representation and interpret responses using contract and authorization context; it must not call every 4xx a bug or require a 2xx for every schema-valid case. Structured wrong-type parameter values are logical negative inputs, not permission to invent HTTP encodings for unsupported serialization.

The value model supports typed JSON schemas already accepted by ingestion, with required/additional properties, nullable/enum semantics, lengths, numeric/exclusive bounds, decimal multiples and bounded arrays/uniqueness. `multipleOf` uses exact arithmetic over serialized decimal numbers rather than an epsilon test. Number boundaries use adjacent finite floating values; unsafe integers are not labeled valid. String lengths count Unicode characters while budgets count UTF-8 bytes.

Customer schemas are never compiled. Pattern matching is limited to literal predefined implementations for `\S`, `^\S+$`, `^[a-z]+$`, `^[A-Za-z]+$`, `^[0-9]+$`, `^\d+$` and `^[A-Za-z0-9_-]+$`. Other patterns remain unmodeled; if a valid baseline cannot be established, the operation is skipped with a gap. Baseline synthesis may also decline satisfiable schemas it cannot solve within its finite candidate set, such as difficult unique arrays; explicit synthetic fixtures can help. There is no brute-force regex solver or arbitrary pattern execution.

A documented API-key parameter overlapping an effective security scheme is excluded with `credential_parameter_overlap` rather than fuzzed as ordinary data. Broader authentication behavior, role changes and credential injection are deliberately not inferred. Synthetic fixtures must never contain live secrets. Normalized enum values, parameter values and generated payloads may still be sensitive/untrusted data; plans are internal test material and are not redacted report artifacts.

## Limits and outcomes

| Limit                                | Default                 | Maximum   |
| ------------------------------------ | ----------------------- | --------- |
| Cases across selected operations     | 100                     | 200       |
| Cases per operation                  | 32                      | 100       |
| Logical bytes per request descriptor | 4,096                   | 16,384    |
| Aggregate logical payload bytes      | 262,144                 | 1,048,576 |
| Candidate checks                     | 2,000                   | Fixed     |
| Synthesized value work/depth         | 2,000 nodes / 20 levels | Fixed     |
| Array lengths constructed            | 32                      | Fixed     |
| Returned distinct diagnostics        | 100                     | Fixed     |

Logical payload size is UTF-8 canonical JSON for the request descriptor, including parameter metadata and body representation. It is not a measurement of HTTP headers, percent-encoded URLs, multipart framing or compressed transfer sizes. The executor must separately cap actual serialized wire requests and responses. A boundary too large to construct/send is skipped with a gap; it is never truncated into a different boundary value.

`generated` means the selected finite rules finished; it does not claim exhaustive coverage. `partial` means some cases were generated but coverage/resource gaps remain. `unavailable` means no cases could be generated, including invalid/unsupported contracts or unusable baselines. Contract diagnostics are preserved as fixed codes. Option/context errors throw instead of silently widening policy. No scheduler, persistent plan store or production consumer is enabled.

These ceilings bound data and work counts; they do not replace process-level memory/time enforcement for hostile source, cancellation, or whole-run request budgeting. The supervisor must enforce those controls before production use. Normal startup stays dispatch-only.

## Verification

`npm test` includes deterministic replay, SHA/tenant-bound identities, deduplication and independent snapshots, policy/priority selection, payload/count limits, Unicode strings, decimal multiples, nullable enums, nested/array cases, synthetic fixtures and unmodeled-pattern behavior. It loads PawMart's actual contract and independently checks generated body labels with Ajv against that trusted fixture schema. This compile is test-only; customer schemas are not compiled in the generator. No generated case is executed against an API in this phase.

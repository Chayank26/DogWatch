# Security validation — Phase 8.5

This is repeatable evidence for DogWatch's **current local boundaries**, not a
penetration test, independent audit or production security certification. The
production QA consumer is disabled. Fixture browser adapters must not be used
for hostile customer previews or real credentials.

## Run the gates

```sh
docker compose up -d --wait postgres redis
npm run security:verify
```

The existing `dogwatch-sandbox:phase-2.7` image is required. If absent, build the
reviewed offline sandbox with `npm run sandbox:build`. Apply the application's
existing migrations before database verification; this command does not migrate
a customer database or install infrastructure automatically.

The command builds fixture/worker dependencies, runs all application tests, then
executes real local tenant-isolation, session-revocation, installation-ownership
and offline Docker checks. Database verifiers use the fixed local Compose target,
random fixture identities and cleanup. Docker verification uses only disposable
probe containers with no network; it does not launch customer workloads. The
command does not start/stop shared services. Individual stages have a five-minute
timeout and bounded captured output.

`.local/security/validation.json` is replaced with a running report before gates
start, updated after each gate, and marked passed only after every gate succeeds.
Failure stops later gates and exits nonzero. Application tests must report a
positive test count and zero skipped tests. Raw subprocess output is not published;
rerun the named command locally to diagnose failures. A failed prerequisite build
also exits nonzero; always check command status and report timestamp, not an old
report alone. [phase-8.5-results.json](phase-8.5-results.json) is the reviewed passing
snapshot, with source digest, source inventory, stage timings and explicit gaps.
A rerun does not automatically overwrite that checked-in snapshot.

## Threat-to-evidence matrix

| Boundary                                | Evidence exercised                                                                        | What it establishes                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection (T06)                  | `security-validation.test.ts` PI-01–PI-05; browser loop/action/observation tests          | Hostile page text plus adversarial structured proposals cannot add scripts, metadata navigation, destructive targets, secret value references or uploads to the approved action set. Executor closes and summaries omit hostile text.                                                                               |
| SSRF (T04)                              | SSRF-01–SSRF-10; preview/API transport tests                                              | Decimal, hexadecimal, octal and shortened loopback, link-local metadata, shared/private addresses and IPv6 variants are rejected. Existing tests cover exact origin, redirects, bounded requests and private destinations. Public literal resolution is a positive control; tests make no metadata-service request. |
| Secret minimization (T08)               | LEAK-01; telemetry, API authentication, browser loop and Markdown/report tests            | Canary fields do not become logs/metric labels or public metadata; unsafe raw fields and report content are constrained. This does not prove that arbitrary page screenshots or prompts are secret-free.                                                                                                            |
| Malicious source/data (T05/T09)         | Diff, impact, graph, OpenAPI, action vocabulary and isolation tests                       | Bounded parsers, unsafe-path/script refusal and resource ceilings. No untrusted repository installation/build script is executed.                                                                                                                                                                                   |
| Tenant/role/session isolation (T03/T12) | API authorization/identity/run-control tests; three real PostgreSQL verification commands | Current membership, session revocation, tenant-consistent relations and installation ownership checks at implemented boundaries. Application checks are not PostgreSQL RLS.                                                                                                                                         |
| Artifact/report access (T03/T08/T13)    | Private artifact, evidence store, Markdown and GitHub reporting tests                     | Scoped lookup, integrity/expiry, unsafe file/symlink/lock refusal, safe rendering and publication authority fences. No hosted download service is enabled.                                                                                                                                                          |
| Runtime containment (T05/T09)           | `npm run isolation:verify`                                                                | Docker engine settings and live offline probe enforce non-root, read-only filesystem, no mounts/network, dropped capabilities, no-new-privileges, bounded resources and removal after timeout/cancellation. Host canary environment is absent.                                                                      |

The adversarial prompt corpus intentionally supplies hostile model replies to
the real validation loop. This measures enforcement even if a model complies
with an attack; it does not measure whether any live model resists persuasion.
All observations and credentials used here are synthetic.

## Result and limitations

The implementation run passed **328 application tests** with zero skips and all
four subsequent integration gates. The negative prerequisite exercise also
verified a nonzero exit and a failed database gate with later gates unexecuted;
a subsequent complete run produced the passing snapshot. No additional runtime
vulnerability was demonstrated by this bounded corpus; this is not evidence that
none exists. The phase adds tests and repeatable evidence, not broader execution
authority or new credential handling.

Before enabling production workloads, resolve and validate these gates:

- Enforced egress and credential/redaction policy for hostile customer browsers;
  fixture routing and form-field masking are insufficient.
- Active QA-worker isolation, authority/lease/revocation propagation and orphan
  recovery. The verified container currently runs an offline diagnostic only.
- Live GitHub App/OAuth integration, hosted artifact authorization/retention and
  deployment-specific IAM, TLS, secrets, backups and incident response.
- Production database isolation strategy, including explicit RLS decisions.
- Dependency vulnerability assessment and independent penetration testing.
- Real model/provider data handling and prompt-injection evaluation without
  exposing real tenant secrets.

These remain deployment/pilot prerequisites. A passing local report does not
waive them. The next implementation phase is 8.6, deployment preparation.

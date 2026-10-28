# Reproducible walkthrough

## Generate the recorded fixture demo

From the repository root with Node 24, locked dependencies and installed Chromium:

```sh
npm run portfolio:verify
```

This builds the fixture/contracts, runs headless Chromium against three ephemeral
loopback targets and records three WebM clips plus PNG screenshots. It checks real
HTTP responses and visible status text, then passes one checked synthetic checkout
observation through DogWatch's private-artifact verifier and Markdown renderer.
Output lives in a unique `.local/portfolio/<id>/` directory with a manifest and
SHA-256 hashes. See [demo-results.json](demo-results.json) for the implementation
run's output location; these ignored local recordings are not hosted assets.
The checked-in sample is a reviewed copy of the generated Markdown.

| Clip                     | Submitted input      | Verified outcome                         |
| ------------------------ | -------------------- | ---------------------------------------- |
| healthy.webm             | Alice, blank address | HTTP 400 and visible address validation  |
| missing-address-500.webm | Same input           | HTTP 500; UI still shows validation text |
| checkout-stuck.webm      | Same input           | HTTP 400 but UI remains Processing       |

The clips are short, silent recordings. They demonstrate seeded differences, not
a live PR flow or an autonomous model discovering a defect. Temporary private
report evidence is removed after rendering; its displayed IDs are synthetic and
not download links. Servers and browser contexts close after each run. Retained
videos/screenshots contain only public synthetic fixture data. Review any new
recordings before sharing and delete local outputs when no longer needed.

## Suggested five-minute presentation

1. **0:00–0:45 — Problem and scope.** Explain opt-in QA and evidence-backed findings.
   State immediately that customer execution and live deployment are disabled.
2. **0:45–1:45 — Observable faults.** Play the three clips in order. Contrast API
   correctness and UI behavior; show why HTTP checks alone miss the stuck UI.
3. **1:45–2:30 — Report.** Open `sample-report.md`. Show reproduction steps, missing
   baseline, private artifact references and the renderer's limits. Do not call
   this a newly introduced PR regression without base/head evidence.
4. **2:30–3:30 — Architecture and recovery.** Show the outbox/run/queue boundary and
   the recovery drill's process-termination test. Explain why lost published jobs
   require reconciliation rather than blind replay.
5. **3:30–4:30 — Evidence.** Show the benchmark's small denominators, inconclusive
   cases, local security matrix and release-rehearsal manifest.
6. **4:30–5:00 — Next steps.** Show the blocked pilot checklist and remaining cloud,
   orchestration and live-integration work. Ask reviewers for concrete feedback;
   do not imply that a pilot has already happened.

## Optional hands-on recipes (no real PR creation)

Run `npm run fixture:dev` and submit an empty address. Stop it, then repeat with
`FIXTURE_MODE=missing-address-500` and `FIXTURE_MODE=checkout-stuck`. These are local
synthetic target modes. They are not actual Git commits or GitHub PRs.

For a future authorized demo repository, prepare reviewed branches that reproduce
those two changes and a clean control, open draft PRs only with repository-owner
approval, then validate opt-in/installation/scope and current SHA before testing.
No repository, issue, PR, check or comment is created by this phase.

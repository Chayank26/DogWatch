# ADR 003 — Verify authority before using opt-in rules

**Status:** Accepted design; only pure policy evaluation is implemented.  
**Phase:** Part 1, Phase 1.3.

## Problem

A repository URL, login session, signed webhook, or valid schema proves different things. None alone proves that a particular person may spend a tenant's budget, retrieve evidence, or use an installation's credentials.

## Decision

Future ingress verifies GitHub's signature over raw bytes before parsing and normalizing supported events. Resolve installation, repository, and tenant relationships from trusted records and authorized GitHub lookups. Then validate normalized data and apply the existing opt-in evaluator. Signed content can still contain malicious text; signature verification does not make repository content trusted instructions.

Initially require configured numeric actor IDs for all triggers. Validate current installation/repository access and revoke it on removal or suspension. An installation connection and dashboard login are distinct: verify organization membership and application roles for every protected request. Do not let a browser-supplied tenant ID select a different organization's records.

Every tenant-owned row, artifact, queue operation, credential reference, and report action must resolve to the authorized tenant and run. Database policies provide defense in depth alongside API authorization. Future worker input requires authoritative revalidation before obtaining credentials; queue contents are not independent permission grants.

Default-deny unapproved preview destinations and redirects. Use an explicit target policy, prohibit loopback/private/link-local/metadata destinations for the hosted public-preview MVP, and enforce destination restrictions in both application code and the network layer. Protect against DNS rebinding by validating and constraining the actual connection destination. Private previews require a separate connectivity design, not disabling these checks globally.

Use synthetic credentials scoped to the configured preview and role. Credentials are short-lived where feasible, stored through a protected secret mechanism, and never embedded in queue JSON, screenshots, model prompts, or PR comments. Default-deny destructive actions; selectively enable only configured disposable-data operations. Fork PRs do not automatically inherit trusted repository secrets or environments.

## Alternatives

Trusting a repository link is convenient but grants no authority. Allowing any commenter is simple but exposes tenant spend and test accounts. Dynamic collaborator/team checks may improve onboarding later but need explicit revocation, API-failure, and caching rules. A shared superuser credential simplifies implementation but greatly increases cross-tenant impact.

## Consequences and verification

Onboarding requires explicit grants and test setup. Invalid or uncertain authority fails closed. Test each scope independently, membership revocation, installation removal, forged queue inputs, fork handling, cross-tenant artifact access, redirects, private addresses, and DNS changes. The existing policy tests cover only in-memory ID matching and configured actor checks; they do not verify these future integration boundaries.

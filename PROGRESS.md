# Sentinel 2.0 Progress

**Last documentation update:** 2026-07-18  
**Release target:** 2.0.0  
**Overall status:** implementation and documentation in progress; goal proof and release pending  
**Canonical repository:** `/home/michel/projects/sentinel-sweep`

This file is the restart point for the 2.0 goal-hardening work. A source module or
focused test is not a completed release gate. Update the evidence fields only from
the exact commit that will be published.

## Safety backup

| Item | State | Evidence |
|---|---|---|
| Pre-hardening remote backup branch | Complete | `backup/pre-hardening-v1.8.5-20260718` |
| Backed-up commit | Complete | `848dc7cf72de68c8d7e78e46e921edf4c3054f16` |
| User-owned `.sentinal/` and unrelated changes | Preserve | Never include, delete, or rewrite them as part of 2.0 packaging |

## Implementation phases

| Phase | Source state | Verification state | Notes |
|---|---|---|---|
| Strict v2 contracts and zero-dependency runtime | Implemented | Focused verification exists; final exact-release gate pending | Settings, manifest, findings, history contracts; Node 18 floor |
| Trusted config, target/output boundaries, origins, secrets | Implemented | Focused/adversarial verification exists; final gate pending | External private config, exact origin, redaction, descriptor anchoring |
| OpenAPI and Vue discovery | Implemented | Focused/golden verification exists; real-goal repeat proof pending | Explicit complete/partial/unsupported coverage |
| Fail-closed policy | Implemented | Focused/adversarial verification exists; zero-mutation goal proof pending | Every subject has execute/skip decision |
| API and Chrome runners | Implemented | Integration verification exists; packaged real-goal proof pending | Built-in fetch; system Chrome over CDP |
| Canonical findings, reports, exports, history | Implemented | Focused consistency/lifecycle verification exists; archive proof pending | One canonical summary; transactional publication |
| CLI and thin Claude/Codex hosts | Implemented | Contract verification exists; clean plugin/Codex smoke pending | Explicit commands and 0/1/2 exits |
| Real supported-target/adversarial E2E | In progress | Pending complete goal gate | Must run API + real Chrome twice and prove canaries/counters |
| Packaging, mirror, version, docs | In progress | Pending full release gate | Root/mirror parity, 2.0.0 consistency, clean archive/plugin install |
| Remote release | Not started | Pending exact-main-SHA CI | Main push, CI, annotated tag, GitHub release, fresh archive |

## Product scope fixed for 2.0

- OpenAPI 3.0/3.1 JSON
- static literal Vue Router routes
- explicit bearer-token roles using environment references
- exact-origin API checks and system Chrome/Chromium over CDP
- Linux and Node.js 18+
- zero or one canonical approved origin and zero or one configured service per
  invocation; executable work requires exactly one approved origin

Everything outside that matrix remains unsupported or explicit enrichment. Do not
reintroduce 1.x broad claims during release-note or mirror updates.

## Goal and release gates

| Gate | Required evidence on exact release commit | State | Evidence to record |
|---|---|---|---|
| Deterministic discovery | Two normalized supported manifests match exact expectations; adversarial/dynamic targets are blocked or partial | Pending | Test command and output |
| Real API | Live loopback status, RBAC, schema, timeout, redirect observations match fixture | Pending | E2E subtest/result |
| Real browser | Real Chrome detects expected console, exception, network, overflow, empty-content, screenshot issues | Pending | Chrome version and E2E result |
| Safety counters | POST/DELETE counters zero; cross-origin receiver authorization count zero | Pending | Counter assertions |
| Secret containment | Admin/user canaries absent from all artifacts and captured stdout/stderr | Pending | Recursive scan result |
| Canonical consistency | JSON, Markdown, dashboard, PR Markdown, history, trends, diff, exit status agree | Pending | Consistency assertions |
| Mode/readiness | Zero-origin discovery is non-executable; `apiReady`, `browserReady`, `sweepReady`; API/browser/sweep isolation; no all-skipped success | Pending | Contract/E2E assertions |
| Concurrency/recovery | Unique concurrent runs; crashes do not advance/adopt incomplete output; valid recovery succeeds | Pending | Lifecycle test output |
| Node/runtime | Full suite, lint, and audit under actual Node 18; zero dependencies | Pending | Node version and command outputs |
| Packaging | Committed `git archive` clean install; Claude plugin and Codex wrapper smoke; root/mirror hashes | Pending | Archive SHA and test output |
| Local release candidate | Full gate on final release commit; clean diff/status except intended state | Pending | Exact commit SHA and logs |
| Remote CI | GitHub CI passes for exact pushed main SHA | Pending | Workflow run URL/conclusion |
| Tag/release | Annotated `v2.0.0` and GitHub release resolve to tested main SHA | Pending | Tag SHA and release URL |
| Downloaded archive | Fresh GitHub source archive passes version, parity, install, and goal checks | Pending | Archive URL/hash/result |

## Release coordinates

| Coordinate | Current value |
|---|---|
| Final tested commit | Pending |
| Pushed `main` SHA | Pending |
| Exact-SHA CI run | Pending |
| Annotated tag | Pending |
| GitHub release | Pending |
| Downloaded archive SHA-256 | Pending |
| Fresh-archive verification | Pending |

## Required local gate

Run from the committed release candidate, using actual Node 18 and real Chrome:

```bash
npm test
npm run lint
npm run audit
bash tests/e2e/clean-install.test.sh
bash tests/e2e/plugin-install.test.sh
claude plugin validate --strict .
git diff --check
git status --short
```

The clean-install gate must archive `HEAD`, not an uncommitted working tree. After
any fix, mirror or version update, rerun the affected focused test and the complete
release gate.

## Release sequence

1. Finish the real goal fixture and all adversarial assertions.
2. Finish 2.0 docs, migration, version bump, metadata, and installable mirror.
3. Run independent correctness and security/packaging review; address every
   confirmed issue.
4. Commit the release candidate and run the full local gate from that commit.
5. Fetch and inspect `origin/main`; integrate without rewriting published history.
6. Push main and wait for GitHub CI on the exact main SHA.
7. Create and push annotated tag `v2.0.0` at that SHA.
8. Publish the GitHub release from the 2.0.0 changelog notes.
9. Download a fresh source archive and rerun version/parity/install/goal checks.
10. Record exact evidence here and in the canonical review report, then change the
    status to goal-proven/released.

## Durable references

- Approved design: `docs/superpowers/specs/2026-07-18-sentinel-2.0-goal-hardening-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-18-sentinel-2.0-goal-hardening.md`
- Architecture: `ARCHITECTURE.md`
- Decision: `docs/adr/0001-deterministic-trusted-core.md`
- Canonical 28-issue report:
  `docs/reports/2026-07-18-sentinel-plugin-review-and-architecture.md`
- Migration: `docs/guides/migrating-to-2.0.md`
- History contract: `docs/sweep-history-spec.md`

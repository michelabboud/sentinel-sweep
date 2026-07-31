# CLAUDE.md

This file contains project-specific guidance for work in Sentinel. Read the root
`VERSION`, `PROGRESS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `docs/adr/README.md`
before making release or architecture claims.

## Product contract

Sentinel 2.0.0 is a deterministic QA runner with a narrow, testable goal:

> From a private trusted config, safely discover supported OpenAPI and Vue Router
> surfaces in an untrusted target, execute only policy-approved API and browser
> checks, and publish one canonical redacted result.

The deterministic execution matrix is:

- OpenAPI 3.0/3.1 JSON with literal relative paths and local component references;
- static literal Vue Router arrays;
- explicit bearer-token roles using environment references;
- built-in HTTP plus system Chrome/Chromium over CDP; and
- Linux with Node.js 18+.

Sentinel 2.0 accepts zero or one canonical approved origin and zero or one configured
service per invocation; executable work requires exactly one origin. Multi-service
projects require separate invocations/configs.
Do not restore or advertise the old unproved multi-framework/auth/ORM, GraphQL,
gRPC, tRPC, automatic-fix, direct-PR, Playwright-MCP, or multi-service execution
claims without a new approved design and complete real E2E proof.

## Architecture

```text
operator / CI / thin Claude or Codex host
                    |
                    v
           runtime/cli.mjs
             /           \
 private external config  descriptor-pinned target
             \           /
        deterministic discovery
        OpenAPI JSON + Vue literals
                    |
          strict v2 manifest
                    |
        fail-closed complete plan
             /              \
       API runner        Chrome/CDP runner
             \              /
        canonical redacted findings
                    |
       transactional publication/history
```

Safety-critical logic belongs in the dependency-free Node core. Claude and Codex
hosts collect explicit operator intent, invoke one documented core command, preserve
exit status, and explain canonical output. They do not parse target source, choose
origins, resolve credentials, compute policy, execute HTTP/browser work directly, or
recalculate reports.

## Trust boundary

- Bundled runtime/defaults/schemas are trusted release assets.
- Operator config is trusted only after location, owner, mode, identity, and schema
  validation. It must be outside the target.
- Target source, imported contracts, comments, docs, pages, responses, redirects,
  manifests, and existing reports are untrusted data.
- Environment secret values are transient request inputs, never persisted data.
- Target source can add evidence or increase risk; it cannot grant origin, role,
  parameter, mutation, output, or host authority.

Never evaluate/import target code or invoke target-local executables during
discovery. Never scan `.env`, seed, SSH, cloud, or arbitrary documentation files for
credentials.

## Core invariants

1. Exact origins are operator-approved; redirects are manually revalidated.
2. At most one canonical origin/service is accepted per invocation, and executable
   work requires exactly one approved origin.
3. Every operation and route receives an explicit execute/skip decision.
4. `GET`, `HEAD`, and `OPTIONS` still require known origin, parameters, auth,
   responses, and side effects.
5. Every other method is a mutation and requires all six documented sandbox gates,
   plus complete auth/parameter evidence.
6. Secret values never enter config, manifests, findings, errors, subprocess
   arguments, stdout/stderr, screenshots metadata, reports, exports, or history.
7. Coverage is explicit `complete`, `partial`, or `unsupported`; unknown does not
   become empty success.
8. `sentinel-findings.json` is canonical; every report/history/diff/exit consumer
   uses its stored summary.
9. A failed engine or artifact write does not advance history or `latest`.
10. Outputs remain private, run-scoped, descriptor-anchored, and transactional.
11. Same-UID processes with output-parent write access must cooperate; this is not a
    sandbox against a malicious process inside the Unix principal boundary.

## Repository structure

```text
runtime/                    deterministic core
  cli.mjs                  command parser and lifecycle
  lib/                     boundaries, config, origins, secrets, schemas
  discovery/               OpenAPI and Vue adapters
  policy/                  complete execute/skip planner
  api/                     HTTP/RBAC/schema execution
  browser/                 WebSocket/CDP/Chrome execution
schemas/                    strict settings/manifest/findings/history contracts
commands/, skills/          thin Claude host
agents/                     explanation-only host roles
codex/                      transparent Node launcher and Codex docs
plugins/sentinel/           installable mirror of shipped assets
tests/                      unit/contract/adversarial/integration/E2E + legacy shell
docs/adr/                   append-only architectural decisions
docs/reports/               durable reviews and release evidence
docs/guides/                migration/operator guidance
PROGRESS.md                 exact release-gate state
VERSION                     version source of truth
```

## Public CLI

Commands are `setup`, `manifest`, `api`, `browser`, `sweep`, `report`, `dashboard`,
`export`, `trends`, `diff`, and `clean`. `--help` and `--version` are sole-argument
metadata invocations. Read `runtime/cli.mjs` before changing the explicit command/
flag matrix; do not infer aliases or retain removed 1.x flags.

Exit codes:

- `0`: command completed; an execution result has no critical/error findings;
- `1`: usage/config/readiness/runtime/engine/validation/publication failure; and
- `2`: completed execution with critical/error findings.

For `setup`, `executionReady` is a compatibility alias for `sweepReady`. The public
mode-specific fields are `apiReady`, `browserReady`, and `sweepReady`. A successful
setup invocation can return readiness false.

## Configuration

The loaded config is bundled defaults merged with one explicit external JSON file.
The config must be current-UID owned, mode `0600` or `0400`, a non-symlink regular
file with one hard link, and outside the target both lexically and canonically.

`reportDir` is relative beneath the target; the core appends `sentinel-v2`. Role
values are references such as `env:SENTINEL_ADMIN_TOKEN`. Stable-ID overrides may
add roles, parameter examples, mutation side effects, rollback, target model, and
delete mode, but cannot erase provenance or directly lower computed risk.

## Artifacts

A completed run contains:

```text
<reportDir>/sentinel-v2/<run-id>/
  .sentinel-run-identity-v2
  sentinel-manifest.json
  sentinel-findings.json
  sweep.md
  dashboard.html
  pr-comment.md
  browser-<digest>.png       # only when captured
```

The versioned root also owns `sweep-history.json` and `latest`. Files are `0600`,
directories are `0700`, and history is capped at 128 runs. Existing artifacts are
untrusted and must be revalidated before every consumer uses them.

## Testing

Use Node 18 for the release floor. Focused tests should cover happy, failure, and
adversarial paths. The complete local gate is:

```bash
npm test
npm run lint
npm run audit
bash tests/e2e/clean-install.test.sh
bash tests/e2e/plugin-install.test.sh
claude plugin validate --strict .
git diff --check
```

The real goal E2E may not skip for missing Chrome. It must prove exact repeated
discovery, expected API/RBAC/schema/browser findings, zero mutation counters, zero
cross-origin authorization forwarding, no fixture token in any artifact or captured
output, canonical consumer consistency, and process cleanup.

Run the aggregate gates again after mirror/version changes and from a committed
archive. Never claim the goal or release from focused tests alone.

## Documentation and decisions

Document every non-obvious invariant, operating constraint, and failure mode. Add an
ADR for security/architecture/public-contract decisions with real alternatives.
ADRs are append-only; supersede rather than rewrite accepted history.

Keep these synchronized with behavior:

- `README.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `docs/guides/migrating-to-2.0.md`
- `docs/sweep-history-spec.md`
- `docs/reports/2026-07-18-sentinel-plugin-review-and-architecture.md`

The canonical report contains all 28 historical findings and exact release-evidence
placeholders. Change a pending gate to passed only after recording evidence from the
exact release commit.

## Package and release

Root assets are canonical; `plugins/sentinel/` is the installable mirror. Changes to
runtime, schemas, settings, package metadata, commands, skills, agents, README,
security docs, Codex assets, or plugin metadata require mirror parity verification.

`VERSION` is the source of truth. Use `scripts/bump-version.sh`, then run structure,
version, mirror, full local, clean-archive, and plugin-install gates. Push main, wait
for CI on the exact main SHA, then create the annotated tag and GitHub release and
test the downloaded archive. A plan does not override these closeout requirements.

Preserve user-owned `.sentinal/`, `sentinel-reports/`, unrelated worktree changes,
and historical 1.x docs/changelog entries. Never rewrite published history.

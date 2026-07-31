# Migrating from Sentinel 1.x to 2.0

Sentinel 2.0 is a breaking trust-model and product-scope change. Migration means
creating a new private operator config and rediscovering the target with the
deterministic core. It is not an in-place conversion of a 1.x manifest or history.

## Why migration is required

In 1.x, natural-language agents were expected to discover source frameworks, infer
credentials and roles, classify risk, choose URLs, execute requests/browser work,
and synthesize reports. Those responsibilities mixed untrusted repository evidence
with execution authority and made broad coverage claims impossible to verify.

In 2.0, safety-critical behavior lives in one dependency-free Node 18 core. Only a
private config outside the target can approve origins, roles, parameter examples, or
mutations. Target content is evidence only.

## Compatibility summary

| 1.x behavior | 2.0 behavior |
|---|---|
| Prompt/source parsers for many frameworks | Deterministic OpenAPI 3.0/3.1 JSON and static Vue Router literals only |
| Credentials inferred from `.env`, docs, or seed files | Bearer-token `env:NAME` references in private external config; Sentinel never scans those files |
| Broad JWT/session/OAuth/API-key support claims | Explicit bearer-token role mapping only |
| Implicit/local URL guesses and multi-service dispatch | Zero or one exact approved origin and zero or one service per invocation; executable work requires exactly one origin |
| Source/manual manifest entries could survive regeneration | Generated manifest is immutable evidence; trusted stable-ID overrides live outside the target |
| Prompt-derived risk and permissive POST/PUT/PATCH | Method-based fail-closed plan; every non-read method needs all mutation gates |
| Playwright MCP/browser agents | Trusted system Chrome/Chromium controlled directly over CDP |
| Separate API/browser finding files and recomputed reports | One canonical `sentinel-findings.json` drives every consumer |
| 1.x report root/history shape | Isolated `<reportDir>/sentinel-v2/` artifacts and strict v2 history |
| Auto-fix, direct PR comments, live serve/config commands | Not 2.0 core claims; PR-ready Markdown is emitted but publishing/editing stays explicit |

## 1. Preserve 1.x evidence

Before switching, back up the target repository and any 1.x `sentinel-reports`
directory required for audit or comparison. Do not move old runs into
`sentinel-v2`; their schemas and trust assumptions differ.

Sentinel 2.0 appends `sentinel-v2` beneath the configured relative `reportDir`, so a
default migration naturally preserves old output alongside the new isolated root.

## 2. Verify prerequisites

- Linux with `/proc` mounted
- Node.js 18+
- A system Chrome/Chromium executable for browser/full sweeps
- A running development or test deployment
- OpenAPI 3.0/3.1 JSON and/or static Vue Router literal files inside the target
- Dedicated development/test bearer tokens supplied by your secret system

Unsupported stacks should remain explicitly partial or unsupported. Do not use an
LLM explanation to relabel them complete.

## 3. Create a private v2 config outside the target

Create a current-user-owned directory and JSON file outside the repository:

```bash
install -d -m 0700 /home/alice/.config/sentinel
install -m 0600 codex/config.example.json /home/alice/.config/sentinel/example.json
```

The file must be a non-symlink regular file with one hard link and mode `0600` or
`0400`. Edit the privately created copy, then use one exact origin and, optionally,
one service:

```json
{
  "schemaVersion": "2.0",
  "reportDir": "sentinel-reports",
  "approvedOrigins": ["http://127.0.0.1:4173"],
  "services": [
    {
      "name": "example",
      "approvedOrigin": "http://127.0.0.1:4173"
    }
  ],
  "roles": {
    "admin": { "tokenRef": "env:SENTINEL_ADMIN_TOKEN" },
    "user": { "tokenRef": "env:SENTINEL_USER_TOKEN" }
  },
  "allowMutations": false,
  "mutationAllowlist": [],
  "allowNonLoopback": false,
  "targetEnvironment": "test",
  "requireCompleteCoverage": true,
  "responseTimeoutMs": 5000,
  "browserSettleMs": 500,
  "viewports": [375, 768, 1280],
  "screenshotOnError": true,
  "discovery": {
    "openapi": ["openapi.json"],
    "vueRouter": ["src/router.js"]
  }
}
```

Never copy a credential value from a 1.x manifest into this file. Rotate any
credential that was previously persisted and configure only its environment
reference.

## 4. Run setup and interpret readiness

```bash
export SENTINEL_ADMIN_TOKEN='sentinel-admin-example+canary/2026alpha=='
export SENTINEL_USER_TOKEN='sentinel-user-example+canary/2026beta=='

node runtime/cli.mjs setup \
  --target /srv/apps/example \
  --config /home/alice/.config/sentinel/example.json \
  --json
```

Inspect all mode-specific fields:

- `apiReady`: an API operation is policy-approved and required API credentials are
  available;
- `browserReady`: a route is policy-approved, required route credentials are
  available, and Chrome resolves;
- `sweepReady`: both are true; and
- `executionReady`: compatibility alias for `sweepReady`.

Setup exit `0` means the readiness analysis completed, not that all fields are true.
With `requireCompleteCoverage: true`, partial or unsupported discovery makes the
execution modes not ready.

## 5. Generate a fresh v2 manifest

Do not reuse or hand-edit a 1.x manifest:

```bash
node runtime/cli.mjs manifest \
  --target /srv/apps/example \
  --config /home/alice/.config/sentinel/example.json \
  --output /tmp/example-sentinel-manifest.json \
  --json
```

Review:

- `coverage.status` and every diagnostic;
- discovered 64-hex operation IDs derived from the canonical method and path;
- 64-hex route IDs derived from the canonical route path;
- auth states and required role evidence;
- required path/query/header parameters without examples; and
- mutation side effects and rollback fields.

If a protected record needs trusted role or parameter evidence, add a matching
stable-ID override to the external config, then regenerate. Unknown override IDs and
conflicting records fail closed.

Example (the hashes shown correspond to `GET /api/admin`,
`GET /api/items/{itemId}`, and route `/admin` in this sample target):

```json
{
  "trustedOverrides": {
    "operations": {
      "4ebcfbf48f6c96aeeb09c6a09bb2ae383d006ff8198a62c0fe6a1d3335c00acf": {
        "allowedRoles": ["admin"]
      },
      "3836a1b4250fb823592a4d018239b35150663fc90e9129af456a4409b2cddc51": {
        "parameterExamples": [
          { "location": "path", "name": "itemId", "value": "known-item" }
        ]
      }
    },
    "routes": {
      "9fce8a089929fb3b2fcd7c2b4f4dabd2aa5f0ad6581e4eb955b5308bfd0ad345": {
        "allowedRoles": ["admin"]
      }
    }
  }
}
```

Merge that object into the full config; do not replace the required fields with the
fragment alone.

## 6. Replace 1.x commands and flags

Use only the explicit 2.0 command matrix:

| Purpose | 2.0 command |
|---|---|
| Readiness | `setup --target <path> --config <path>` |
| Discovery artifact | `manifest --target <path> --config <path> --output <path>` |
| API-only run | `api --target <path> --config <path>` |
| Browser-only run | `browser --target <path> --config <path>` |
| Full required run | `sweep --target <path> --config <path>` |
| Existing Markdown | `report --target <path> --config <path> --run <id> --output <path>` |
| Existing dashboard | `dashboard --target <path> --config <path> --run <id> --output <path>` |
| Collection export | `export --target <path> --config <path> --run <id> --format <postman\|insomnia\|bruno> --output <path>` |
| History summaries | `trends --target <path> --config <path>` |
| Finding identity comparison | `diff --target <path> --config <path> --run <newer> --against <older>` |
| Retention | `clean --target <path> --config <path> --keep <1-128>` |

Removed flags/commands are not aliases. This includes 1.x `--dry-run`,
`--reuse-manifest`, `--risk-level`, `--safe-only`, `--ci`, `--changed-only`,
`--dashboard`, `--severity`, `--list`, `--verify`, `--visual-regression`, and the
old `fix`, `config`, `serve`, and direct `pr` flows.

Use `--json` for machine-readable output. Use `--run-id` only on execution commands
and `--run` only for existing-run consumers.

## 7. Split multi-service projects

A 1.x `services` array with several entries cannot be copied to one v2 invocation.
Create one private config per service, each with:

- zero or one canonical `approvedOrigins` entry (exactly one for executable work);
- zero or one matching `services` entry; when present, it must reference the sole
  approved origin, so a zero-origin discovery config has no service entry;
- only that service's adapter files and overrides; and
- a distinct relative `reportDir` when histories must be isolated by name.

Run and gate each service separately. Aggregating multiple canonical results is an
external reporting concern until service identity is part of the strict manifest and
execution contract.

## 8. Validate API-only first

Keep `allowMutations: false` and run:

```bash
node runtime/cli.mjs api \
  --target /srv/apps/example \
  --config /home/alice/.config/sentinel/example.json \
  --json
```

Exit `2` means the run completed and found at least one critical/error issue; inspect
the canonical artifacts. Exit `1` means the run was incomplete or failed and must
not be treated as a QA result.

Confirm the expected origin, role matrix, coverage, skipped decisions, and schema
findings before adding the browser engine.

## 9. Validate browser and full sweep

```bash
node runtime/cli.mjs browser \
  --target /srv/apps/example \
  --config /home/alice/.config/sentinel/example.json \
  --json

node runtime/cli.mjs sweep \
  --target /srv/apps/example \
  --config /home/alice/.config/sentinel/example.json \
  --json
```

`sweep` is all-or-nothing at the engine level: API and browser must both complete
before publication. The run's `sentinel-findings.json` is canonical; Markdown,
dashboard, PR-ready Markdown, history, trends, diff, and exit status must agree with
its summary.

## 10. Migrate mutations only when necessary

Do not translate a 1.x risk threshold into blanket v2 approval. A non-read operation
requires all of:

1. `allowMutations: true`;
2. exact stable ID in `mutationAllowlist`;
3. trusted known side effects and rollback;
4. `targetEnvironment` equal to `development` or `test`;
5. exact approved origin; and
6. valid explicit `--sandbox-acknowledged`.

Auth and required parameters must also be complete. For non-interactive use, bind
acknowledgement to an explicit `--run-id` with `SENTINEL_CI_SANDBOX_ACK` equal to the
same ID. Use a disposable environment and prove rollback independently.

## Rollback

Keep a previously published immutable 1.x release available for operational
rollback. Do not point v2 at 1.x manifests/history or weaken v2 schemas to accept
them. Reverting the deployed plugin and selecting the old artifact root are separate
from modifying the preserved evidence.

## Migration acceptance checklist

- [ ] Private external v2 config passes setup validation.
- [ ] At most one canonical origin/service is configured per invocation, and every
      executable invocation has exactly one approved origin.
- [ ] No credential value exists in config or a checked-in file.
- [ ] Fresh manifest has expected exact operations/routes and honest coverage.
- [ ] Stable-ID role/parameter overrides are reviewed and minimal.
- [ ] `apiReady`, `browserReady`, and `sweepReady` have the expected values.
- [ ] API-only run has the expected RBAC/schema/security observations.
- [ ] Browser run has the expected console/network/layout/content observations.
- [ ] Full sweep publishes one canonical run with internally consistent consumers.
- [ ] Default mutation counters remain zero and cross-origin receivers see no auth.
- [ ] Token canaries are absent from every artifact and captured stdout/stderr.
- [ ] CI treats exit `2` as completed-with-findings and exit `1` as incomplete.
- [ ] Old 1.x evidence remains backed up and separate.

Release-wide evidence is tracked in `PROGRESS.md` and the canonical review report.
Migration of one target does not replace the exact-commit release gate.

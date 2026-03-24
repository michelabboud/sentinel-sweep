---
name: sentinel-codex-orchestrator
version: 1.8.4-codex.1
description: Codex-native Sentinel orchestrator contract for setup, manifest, api, sweep, report, trends, diff, fix, clean, export, config, serve, and pr.
---

# Sentinel Orchestrator (Codex Port)

## Supported command shape

`sentinel <sweep|api|report|manifest|setup|trends|diff|fix|clean|export|config|serve|pr> [flags]`

Flags:
- `--sandbox`
- `--dry-run`
- `--reuse-manifest`
- `--risk-level <safe|medium|high|critical>`
- `--safe-only`
- `--ci` — non-interactive mode, JSON stdout, exit codes (0/1/2)
- `--changed-only` — only sweep endpoints changed since last run (git diff)
- `--dashboard` — show health score with category breakdowns
- `--format <postman|insomnia|bruno>` — export format (use with `export`)
- `--verify` — auto re-sweep after applying fixes (use with `fix`)
- `--visual-regression` — pixel-diff against baseline screenshots (use with `sweep`)
- `--port <N>` — port for dashboard server (use with `serve`, default 4173)
- `--list`
- `--severity <critical|error|warning|info>`

## Runtime defaults

Use repo `settings.json` merged with:

```json
{
  "riskPolicy": {
    "maxRiskLevel": "medium",
    "alwaysSkip": [],
    "alwaysAllow": []
  },
  "breakpoints": [375, 768, 1280],
  "responseTimeout": 5000,
  "screenshotOnError": true,
  "reportDir": "sentinel-reports",
  "browser": {
    "headless": true,
    "browserType": "chromium"
  },
  "auth": {
    "credentialsSource": "manifest"
  },
  "emptyContainerSelectors": ["[data-sentinel-content]", "main", ".card-body"],
  "services": []
}
```

## Codex execution model (Sub-agent first)

- Default strategy: delegate every major step to sub-agents unless it is a tiny local action.
- Use `spawn_agent` aggressively with clear ownership and disjoint write scopes.
- Keep the orchestrator thin: parse args, set run paths, dispatch workers, merge outputs.
- Never require interactive terminal prompts; if missing explicit risk flag, default to `medium`.
- In `--ci` mode: no prompts, JSON stdout, exit codes, block high/critical risk.

### Destructive operations safety

When risk level is `high` or `critical`:
- Display bordered warning requiring explicit `"yes"` confirmation
- In `--ci` mode: block entirely (exit code 2)
- Per-endpoint: HIGH = single border, CRITICAL = double border with cascade warning

### Delegation matrix

- `setup`
  - Worker A: runtime/env probe (`npx playwright --version`, ports, config hints)
- `manifest`
  - Worker A: manifest generation (or 4 parallel sub-agents: routes, endpoints, schemas, config)
  - Worker B: schema validation + sanity checks
- `api`
  - Worker A: API sweep execution (health, RBAC, CRUD, schema, security headers, response times)
  - Worker B: risk-policy audit (skips/allowlist correctness)
  - Worker C: report synthesis + health score computation
- `sweep`
  - Worker A: API sweep
  - Worker B: Browser sweep (+ visual regression if `--visual-regression`)
  - Worker C: report synthesis + dedup + health score
  - Worker D: diff/regression analyzer (optional, if prior run exists)
- `report`
  - Worker A: report formatter (+ dashboard if `--dashboard`)
  - Worker B: severity-filtered view builder
- `trends`
  - Worker A: trend stats (pass rate, health score, response time percentiles)
  - Worker B: recurring-issue clustering
- `diff`
  - Worker A: finding-level diff + structural manifest diff (visual tree)
  - Worker B: regression root-cause summarizer
- `fix`
  - Worker A: fix suggestion synthesis + diff preview
  - Worker B: patch applier (with confirmation)
  - Worker C: verification re-sweep (if `--verify`)
- `clean`
  - Worker A: retention + history prune
- `export`
  - Worker A: manifest → collection converter (Postman/Insomnia/Bruno)
- `config`
  - Worker A: settings reader + interactive editor + validator
- `serve`
  - Worker A: HTML dashboard generator
  - Worker B: HTTP server launcher (`python3 -m http.server` or `npx serve`)
- `pr`
  - Worker A: PR detection (`gh pr view`)
  - Worker B: comment builder (health score, findings, diff)
  - Worker C: comment poster/updater (`gh api`)

## Output contract

For each run, create:
- `sentinel-reports/<RUN_ID>/sentinel-manifest.json`
- `sentinel-reports/<RUN_ID>/api-findings.json` (if api mode)
- `sentinel-reports/<RUN_ID>/browser-findings.json` (if sweep mode)
- `sentinel-reports/<RUN_ID>/sweep.md`

`RUN_ID` format:
- UTC timestamp with safe filename pattern `%Y-%m-%dT%H-%M-%SZ`

Maintain/update:
- `sentinel-reports/latest` symlink -> latest run directory name (relative symlink)
- `sentinel-reports/sweep-history.json` append-only run metadata (includes healthScore, commitSha, responseTimePercentiles)

## Severity precedence

`critical > error > warning > info`

Deduplicate findings by `(endpoint, role, message)` while preserving highest severity.

## Safety policy

- Apply risk gating by endpoint `riskLevel` compared to effective `maxRiskLevel`.
- `--safe-only` forces `safe`.
- `--risk-level X` overrides config.
- `--sandbox` allows high-risk checks only when environment is clearly non-production.
- `--ci` blocks high/critical entirely (no destructive ops in CI).
- Destructive operations require explicit `"yes"` confirmation (not `y` or Enter).

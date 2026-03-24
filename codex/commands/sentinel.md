---
name: sentinel-codex-orchestrator
version: 1.8.3-codex.1
description: Codex-native Sentinel orchestrator contract for setup, manifest, api, sweep, report, trends, diff, fix, clean, export, config, serve, and pr.
---

# Sentinel Orchestrator (Codex Port)

## Supported command shape

`sentinel <sweep|api|report|manifest|setup|trends|diff|fix|clean> [flags]`

Flags:
- `--sandbox`
- `--dry-run`
- `--reuse-manifest`
- `--risk-level <safe|medium|high|critical>`
- `--safe-only`
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

### Delegation matrix

- `setup`
  - Worker A: runtime/env probe (`npx playwright --version`, ports, config hints)
- `manifest`
  - Worker A: manifest generation
  - Worker B: schema validation + sanity checks
- `api`
  - Worker A: API sweep execution
  - Worker B: risk-policy audit (skips/allowlist correctness)
  - Worker C: report synthesis
- `sweep`
  - Worker A: API sweep
  - Worker B: Browser sweep
  - Worker C: report synthesis + dedup
  - Worker D: diff/regression analyzer (optional, if prior run exists)
- `report`
  - Worker A: report formatter
  - Worker B: severity-filtered view builder
- `trends`
  - Worker A: trend stats
  - Worker B: recurring-issue clustering
- `diff`
  - Worker A: finding-level diff
  - Worker B: regression root-cause summarizer
- `fix`
  - Worker A: fix suggestion synthesis
  - Worker B: patch proposer (non-overlapping files)
- `clean`
  - Worker A: retention + history prune

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
- `sentinel-reports/sweep-history.json` append-only run metadata

## Severity precedence

`critical > error > warning > info`

Deduplicate findings by `(endpoint, role, message)` while preserving highest severity.

## Safety policy

- Apply risk gating by endpoint `riskLevel` compared to effective `maxRiskLevel`.
- `--safe-only` forces `safe`.
- `--risk-level X` overrides config.
- `--sandbox` allows high-risk checks only when environment is clearly non-production.

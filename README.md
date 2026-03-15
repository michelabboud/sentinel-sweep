# Sentinel

Automated QA sweep plugin for Claude Code. Catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys in web applications.

## Installation

```bash
claude plugin add /path/to/sentinel-plugin
```

## Quick Start

```
/sentinel setup       # Check environment, detect framework, verify Playwright
/sentinel api         # Fast API-only sweep (no browser)
/sentinel sweep       # Full browser + API sweep
```

## Commands

| Command | Description |
|---------|------------|
| `/sentinel setup` | Check environment, install Playwright, configure settings |
| `/sentinel sweep` | Full browser + API sweep (generates manifest, runs both sweepers) |
| `/sentinel sweep --sandbox` | Include high/critical actions with per-action approval |
| `/sentinel api` | API-only sweep — endpoint health, RBAC, CRUD flows, schema contracts |
| `/sentinel report` | View last sweep report or regenerate from existing findings |
| `/sentinel manifest` | Generate/inspect manifest without sweeping |

## Configuration

Settings are in `settings.json` at the plugin root. All fields have sensible defaults.

| Field | Default | Description |
|-------|---------|------------|
| `riskPolicy.maxRiskLevel` | `"medium"` | Maximum risk level to execute automatically (`safe`, `medium`, `high`, `critical`) |
| `riskPolicy.alwaysSkip` | `[]` | Endpoints to never test (e.g., `["DELETE /api/v1/users/{id}"]`) |
| `riskPolicy.alwaysAllow` | `[]` | Endpoints to always test regardless of risk level |
| `breakpoints` | `[375, 768, 1280]` | Viewport widths for responsive testing (px) |
| `responseTimeout` | `5000` | API request timeout (ms) |
| `screenshotOnError` | `true` | Capture screenshots when layout issues are found |
| `reportDir` | `"sentinel-reports"` | Directory for findings, reports, and screenshots |
| `browser.headless` | `true` | Run browser in headless mode |
| `browser.browserType` | `"chromium"` | Browser engine (`chromium`, `firefox`, `webkit`) |
| `emptyContainerSelectors` | `["[data-sentinel-content]", "main", ".card-body"]` | CSS selectors for empty container layout checks |

## Manifest

Running `/sentinel manifest` analyzes your codebase and produces `sentinel-manifest.json` in your project root. This file describes every frontend route, backend endpoint, Pydantic schema, auth configuration, and CRUD flow. All sweeps are driven by this manifest.

The manifest is auto-regenerated before every sweep to stay fresh. You can also inspect and manually override entries:

- Add `"manual": true` to any entry to prevent it from being overwritten on regeneration
- Add `"schemaOverride"` entries for complex schemas that can't be auto-parsed
- Edit `auth.roles` credentials if they differ from what was detected in CLAUDE.md

## Risk Levels

Every endpoint and route is scored and classified:

| Level | Score | Examples | Default Policy |
|-------|-------|----------|---------------|
| **safe** | 0-25 | GET routes, read-only views, list pages | Execute freely |
| **medium** | 26-50 | Create forms, profile edits, status changes | Execute (default threshold) |
| **high** | 51-75 | Bulk operations, payment mutations, role changes | Skip, flag in report |
| **critical** | 76-100 | DELETE endpoints, purge actions, hard-deletes | Never execute, warn loudly |

Risk scores are computed from HTTP method, auth requirements, keyword detection, cascade behavior, and `?confirm=true` patterns.

## Sandbox Mode

`/sentinel sweep --sandbox` unlocks high and critical actions with safeguards:

**Pre-flight checks (all must pass):**
- `APP_ENV` is not `production`
- Database name contains `dev`, `test`, `staging`, or `local`
- Base URL is localhost or contains `dev`/`staging`

**Per-action approval:** Each high/critical action shows its risk score, description, and side effects, then asks for confirmation before executing.

**Post-sweep:** All sandbox actions are logged in the report with suggested restore steps.

## Report Format

After a sweep, Sentinel produces:

1. **Terminal summary** — finding counts by severity, top 5 issues, report file path
2. **Markdown report** (`sentinel-reports/YYYY-MM-DD-sweep.md`) — full findings organized by severity, RBAC matrix, skipped actions, checkbox task list
3. **Findings JSON** — machine-readable findings in `sentinel-reports/.api-findings.json` and `.browser-findings.json`
4. **Screenshots** — saved to `sentinel-reports/screenshots/` when layout issues are detected

## Framework Support

v1 targets **Vue 3 + FastAPI** projects. The manifest generator understands:
- Vue Router route definitions with `meta.role` guards
- FastAPI endpoint decorators with `Depends()` auth injection
- Pydantic v2 response schemas
- SQLAlchemy model relationships (for cascade/side-effect detection)

The architecture is designed to support additional frameworks in future versions.

## Known Limitations

- **Authentication:** v1 supports JWT-based auth only. Session cookies, CSRF tokens, and OAuth PKCE flows are not supported.
- **i18n coverage:** Browser sweep catches missing keys rendered during navigation. Keys behind conditional UI (modals, error states) may not trigger. Static analysis planned for v2.
- **Schema parsing:** Complex Pydantic models using deep inheritance, `computed_field`, or runtime validators may not parse correctly. Use `schemaOverride` in the manifest for these cases.

## License

Apache-2.0

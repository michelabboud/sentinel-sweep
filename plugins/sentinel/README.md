# Sentinel

Automated QA sweep plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys in web applications.

> **v1.1.0** | Vue 3 + FastAPI | JWT auth | Playwright MCP

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Manifest](#manifest)
- [Risk Levels](#risk-levels)
- [Sandbox Mode](#sandbox-mode)
- [Report Format](#report-format)
- [Framework Support](#framework-support)
- [Architecture](#architecture)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

### From GitHub

```bash
claude plugin marketplace add https://github.com/michelabboud/claude-sentinel-sweep
claude plugin install sentinel
```

### From local path

```bash
claude plugin marketplace add /path/to/claude-sentinel-sweep
claude plugin install sentinel
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.16+
- [Node.js](https://nodejs.org) 18+ (for Playwright)
- A web application with a running dev server

### Verify installation

```
/sentinel setup
```

This checks your environment, detects frameworks, verifies Playwright, and shows a readiness report.

### Uninstall

```bash
claude plugin uninstall sentinel
```

---

## Quick Start

```bash
# 1. Start your dev server (frontend + API)
docker-compose up -d

# 2. Check everything is ready
/sentinel setup

# 3. Run a full sweep
/sentinel sweep

# 4. View the report
/sentinel report
```

**First time?** Start with `/sentinel api` (no browser needed) to verify your endpoints, then graduate to `/sentinel sweep` for full browser + API coverage.

---

## Commands

| Command | Description |
|---------|-------------|
| `/sentinel setup` | Check environment, install Playwright, detect framework, configure settings |
| `/sentinel sweep` | Full browser + API sweep (generates manifest, runs both sweepers in parallel) |
| `/sentinel sweep --sandbox` | Include high/critical actions with per-action approval (dev only) |
| `/sentinel sweep --dry-run` | Generate manifest and show test plan without executing sweeps |
| `/sentinel api` | API-only sweep — endpoint health, RBAC, CRUD flows, schema contracts |
| `/sentinel api --dry-run` | Show what would be tested without executing |
| `/sentinel report` | View the most recent sweep report |
| `/sentinel report --list` | List all past sweep runs |
| `/sentinel manifest` | Generate and inspect the manifest without sweeping |
| `/sentinel trends` | Show pass-rate and finding trends across recent runs |

---

## How It Works

```
/sentinel sweep
    |
[1] Generate manifest
    Reads your codebase: router files, API endpoints,
    Pydantic schemas, auth config, database models
    |
[2] Risk assessment
    Scores every route and endpoint (0-100)
    Classifies as safe / medium / high / critical
    |
[3] Execute sweeps (in parallel)
    API sweeper: curl-based endpoint testing
    Browser sweeper: Playwright navigation + screenshots
    |
[4] Collect and deduplicate findings
    Merges results, removes duplicates, keeps highest severity
    |
[5] Generate report
    Terminal summary + markdown report + task list
```

### What gets tested

| Category | API Sweep | Browser Sweep |
|----------|-----------|---------------|
| Endpoint health (2xx responses) | Yes | - |
| RBAC enforcement (role-based access) | Yes | Yes |
| CRUD flow correctness | Yes | - |
| Response schema validation | Yes | - |
| Console errors | - | Yes |
| Network failures | - | Yes |
| Layout issues (empty containers) | - | Yes |
| Responsive breakpoints | - | Yes |
| Missing i18n keys | - | Yes |

---

## Configuration

Settings are in `settings.json` at the plugin root. All fields have sensible defaults — you only need to change what matters for your project.

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
  "emptyContainerSelectors": ["[data-sentinel-content]", "main", ".card-body"]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `riskPolicy.maxRiskLevel` | `"medium"` | Maximum risk level to execute automatically (`safe`, `medium`, `high`, `critical`) |
| `riskPolicy.alwaysSkip` | `[]` | Endpoints to never test (e.g., `["DELETE /api/v1/users/{id}"]`) |
| `riskPolicy.alwaysAllow` | `[]` | Endpoints to always test regardless of risk level |
| `breakpoints` | `[375, 768, 1280]` | Viewport widths for responsive testing (px) |
| `responseTimeout` | `5000` | API request timeout (ms) |
| `screenshotOnError` | `true` | Capture screenshots when layout issues are found |
| `reportDir` | `"sentinel-reports"` | Directory for findings, reports, and screenshots |
| `browser.headless` | `true` | Run browser in headless mode |
| `browser.browserType` | `"chromium"` | Browser engine (`chromium`, `firefox`, `webkit`) |
| `emptyContainerSelectors` | see above | CSS selectors for empty container layout checks |

### Tailwind breakpoint auto-detection

If you use Tailwind CSS, Sentinel auto-detects your custom breakpoints from `tailwind.config.js` or `@theme` CSS blocks. Detected breakpoints override the defaults unless you've explicitly set them in `settings.json`.

---

## Manifest

The manifest is the single source of truth for what gets tested. It's auto-generated by analyzing your codebase before each sweep.

### What it captures

- **Routes** — Vue Router paths with `meta.role` guards, dynamic params, risk scores
- **Endpoints** — FastAPI decorators with auth dependencies, response schemas, confirm patterns
- **Schemas** — Pydantic v2 model definitions with field types and nullability
- **CRUD flows** — Auto-detected lifecycle patterns (create → read → update → delete)
- **Auth config** — Login endpoint, role hierarchy, test credentials from CLAUDE.md or seed files
- **Risk scores** — Computed from HTTP method, keywords, cascade relationships, confirm requirements

### Manual overrides

The manifest supports manual entries that survive re-generation:

```json
{
  "path": "/api/v1/custom-endpoint",
  "method": "POST",
  "requiredRole": "admin",
  "manual": true,
  "description": "Custom endpoint not auto-detected"
}
```

- `"manual": true` — Preserves the entry across re-generations
- `"schemaOverride"` — Override auto-parsed schema for complex models
- Edit `auth.roles` credentials if they differ from what was auto-detected

### Parameter resolution

Dynamic parameters are resolved using lookup expressions:

```json
{
  "path": "/api/v1/groups/{group_id}/members/{member_id}",
  "params": {
    "group_id": "lookup:groups[0].id",
    "member_id": "lookup:groups/{group_id}/members[0].id"
  }
}
```

For parameters that can't be resolved, use `"static:00000000-0000-0000-0000-000000000001"` as a fallback.

---

## Risk Levels

Every endpoint and route is scored and classified:

| Level | Score | Examples | Default Policy |
|-------|-------|----------|----------------|
| **safe** | 0-25 | GET routes, read-only views, list pages | Execute freely |
| **medium** | 26-50 | Create forms, profile edits, status changes | Execute (default threshold) |
| **high** | 51-75 | Bulk operations, payment mutations, role changes | Skip, flag in report |
| **critical** | 76-100 | DELETE endpoints, purge actions, hard-deletes | Never execute, warn loudly |

### How scores are computed

**Base score by HTTP method:** GET=0, POST=25, PUT/PATCH=30, DELETE=60

**Modifiers (additive):**
- Admin-only endpoint → +10
- Path contains "delete" → +15
- Path contains "purge" or "reset" → +20
- Path contains "bulk" → +15
- Requires `?confirm=true` → +15
- Has cascade delete relationships → +10
- Hard-delete bypassing soft-delete → +15

---

## Sandbox Mode

`/sentinel sweep --sandbox` unlocks high and critical actions with safeguards:

### Pre-flight checks (all must pass)

- `APP_ENV` is not `production`
- Database name contains `dev`, `test`, `staging`, or `local`
- Base URL is localhost or contains `dev`/`staging`

### Per-action approval

Each high/critical action shows its risk score, description, and side effects, then asks for your confirmation before executing.

### Post-sweep

All sandbox actions are logged in the report with suggested restore steps.

---

## Report Format

Each sweep produces a **run-scoped output directory** using a filesystem-safe ISO timestamp as the run ID:

```
sentinel-reports/
├── latest -> 2026-03-15T14-30-00Z/
├── 2026-03-15T14-30-00Z/
│   ├── sentinel-manifest.json    # Manifest used for this run
│   ├── api-findings.json         # API sweeper results
│   ├── browser-findings.json     # Browser sweeper results
│   ├── sweep.md                  # Full markdown report
│   └── screenshots/              # Layout issue screenshots
└── 2026-03-14T09-15-00Z/
    └── ...
```

### Report sections

1. **Summary** — Mode, roles tested, routes/endpoints tested, duration, pass rate
2. **Critical Issues** — Checkbox list with file refs, expected vs actual, screenshots
3. **Errors** — Same format as critical
4. **Warnings** — Same format
5. **Info** — Bullet list of informational findings
6. **Skipped Actions** — High/critical actions not executed due to risk policy
7. **Sandbox Actions** — Actions executed in sandbox mode (if applicable)
8. **RBAC Matrix** — Table showing pass/fail for each endpoint+role combination
9. **Task List** — Prioritized checklist of all actionable findings

### Terminal summary

After each sweep, you get a quick summary:

```
--- Sentinel Sweep Report ---

  Mode: browser + api | Roles: admin, manager, user
  Routes tested: 24 | Endpoints tested: 84
  Breakpoints: 375px, 768px, 1280px
  Duration: 2m 34s

  Critical: 0
  Error:    3
  Warning:  7
  Info:     12
  Passed:   86

  Top issues:
  1. [ERROR] rbac: Unauthorized role 'user' got 200 on DELETE /api/v1/groups/{id}
  2. [ERROR] schema: Missing required field 'email' in UserRead response
  3. [ERROR] health: Endpoint returned 500: POST /api/v1/sessions
  ...

  Full report: sentinel-reports/2026-03-15T14-30-00Z/sweep.md
```

---

## Framework Support

### v1 (current)

| Component | Supported |
|-----------|-----------|
| Frontend | Vue 3 (Vue Router with `meta.role` guards) |
| Backend | FastAPI (`@router` decorators, `Depends()` auth) |
| Schemas | Pydantic v2 (`BaseModel` classes) |
| ORM | SQLAlchemy (cascade relationship detection) |
| Auth | JWT (via `python-jose` / `PyJWT`) |
| Browser | Playwright MCP (Chromium, Firefox, WebKit) |

### Planned (v2+)

- React Router, Next.js, SvelteKit
- Express.js, Django, Rails
- Session/cookie auth, OAuth PKCE
- Static i18n analysis
- OpenAPI spec import (skip manifest generation)

---

## Architecture

Sentinel is a Claude Code plugin built from 5 components:

```
/sentinel (orchestrator skill)
    ├── manifest-generator (agent, opus)
    │   Reads codebase → produces sentinel-manifest.json
    │
    ├── api-sweeper (agent, sonnet)
    │   Tests endpoints via curl → api-findings.json
    │
    ├── browser-sweeper (agent, sonnet)
    │   Navigates via Playwright → browser-findings.json
    │
    └── sentinel-setup (skill, context: fork)
        Environment detection + configuration
```

- The **orchestrator** parses arguments, loads settings, generates a run ID, dispatches agents, collects findings, and generates the report
- **Agents are stateless** — they receive everything they need via the dispatch prompt (manifest path, settings, flags)
- **Browser and API sweepers run in parallel** during `/sentinel sweep`
- All agents implement the **Hello Protocol** (`hello` / `hello <name> ID`)

---

## Security Considerations

### Manifest credentials

The manifest's `auth.roles` section may contain test credentials (usernames, passwords, tokens) auto-detected from `CLAUDE.md`, seed files, or environment variables. These credentials are written to `sentinel-manifest.json` inside `sentinel-reports/`.

**Recommendations:**
- Add `sentinel-reports/` to `.gitignore` (already included by default)
- Never commit `sentinel-manifest.json` to version control
- Use dedicated test/dev credentials — never production secrets
- Review the manifest before sharing sweep reports externally

### Sandbox mode safety

Sandbox mode (`--sandbox`) executes destructive actions (DELETE, bulk operations) against your dev server. Pre-flight checks verify you're not targeting production, but always:
- Confirm `APP_ENV` is not `production`
- Verify your database is a dev/test instance
- Have a seed script ready to restore data after sandbox runs

---

## Known Limitations

| Limitation | Workaround |
|------------|------------|
| **JWT auth only** (v1) | Session cookies, CSRF tokens, and OAuth PKCE are not supported |
| **Vue 3 + FastAPI only** (v1) | Other frameworks produce empty manifests — endpoints/routes must be added manually |
| **i18n coverage** | Browser sweep catches missing keys during navigation; keys behind modals or conditional UI may not trigger |
| **Complex Pydantic models** | Deep inheritance, `computed_field`, and runtime validators may not parse — use `schemaOverride` |
| **Playwright required for browser sweep** | Falls back to API-only mode if Playwright MCP is unavailable |

---

## Troubleshooting

### `/sentinel setup` shows services unreachable

Make sure your dev server is running. Sentinel pings `localhost` URLs discovered from `.env`, `CLAUDE.md`, `docker-compose.yml`, or `vite.config.js`.

```bash
# Start your dev server first
docker-compose up -d
# Then run setup
/sentinel setup
```

### Browser sweep falls back to API-only

Playwright MCP plugin is not installed or not configured. Install it:

```bash
claude plugin install @anthropic-ai/claude-code-playwright
npx playwright install chromium
```

### Manifest has no routes or endpoints

Your project may use a framework Sentinel v1 doesn't support. Check `/sentinel setup` output for the detected framework. For unsupported frameworks, add entries manually to `sentinel-manifest.json` with `"manual": true`.

### RBAC tests show unexpected results

Check that test credentials in `auth.roles` (in the manifest) are correct. Sentinel auto-detects credentials from `CLAUDE.md` and seed files, but may miss them if they're in an unusual format.

### Report overwrites

This was fixed in v1.1.0. Each run now writes to its own timestamped directory under `sentinel-reports/`. If you're seeing overwrites, update to the latest version.

---

## License

Apache-2.0

---

**Author:** [Michel Abboud](https://github.com/michelabboud) | Built with [Claude Code](https://claude.ai/code)

# Changelog

All notable changes to Sentinel are documented in this file.

## [1.1.0] - 2026-03-15

### Added
- **Run-scoped output directories** — each sweep writes to `sentinel-reports/{ISO-timestamp}/` with a `latest` symlink, preventing parallel run collisions
- **Skills 2.0 migration** — added `skills/sentinel/SKILL.md` and `skills/sentinel-setup/SKILL.md` with enriched frontmatter (tags, triggers, author, repository, license)
- **Hello Protocol** — all agents now implement the standard greeting handshake (`hello` / `hello <name> ID`)
- **Parallel sweeper dispatch** — browser and API sweepers launch simultaneously in `/sentinel sweep`
- **`--dry-run` flag** — generate manifest and show test plan without executing sweeps
- **`/sentinel report --list`** — list all previous sweep runs
- **`.gitignore`** — excludes `sentinel-reports/`, `sentinel-manifest.json`, `node_modules/`, `*.log`

### Changed
- Manifest path passed via dispatch prompt instead of hardcoded CWD lookup
- Findings files renamed from `.api-findings.json` → `api-findings.json` (no dot prefix)
- All output paths are run-scoped (`{reportDir}/{runId}/`)
- Plugin metadata now includes `repository`, `license`, `homepage` fields
- Agent frontmatter includes `version`, `triggers`, and `references` fields

### Fixed
- Report overwrites when multiple sweeps run in the same project
- Hardcoded `SmartSessions` reference replaced with generic instruction

## [1.0.0] - 2026-03-14

### Added
- **Orchestrator command** (`/sentinel`) — parses arguments, loads settings, routes to subcommands
- **Manifest generator agent** — reads Vue Router files, FastAPI endpoints, Pydantic schemas, SQLAlchemy models, and auth config to produce `sentinel-manifest.json`
- **API sweeper agent** — tests endpoint health, RBAC enforcement, CRUD flow correctness, and response schema validation via curl
- **Browser sweeper agent** — navigates routes via Playwright MCP, checks console errors, network failures, empty containers, responsive breakpoints, and missing i18n keys
- **Setup skill** — checks Playwright installation, detects frameworks, verifies dev server connectivity, detects Tailwind breakpoints
- **Risk scoring system** — base score by HTTP method with additive modifiers (admin-only, cascade, confirm, keywords)
- **Sandbox mode** (`--sandbox`) — unlocks high/critical actions with pre-flight safety checks and per-action approval
- **Settings** — configurable risk policy, breakpoints, timeouts, browser options, and empty container selectors
- **Marketplace structure** — `.claude-plugin/` with `plugin.json` and `marketplace.json`
- **Plugin mirror** — installable copy in `plugins/sentinel/`

### Supported Stack
- Frontend: Vue 3 (Vue Router with `meta.role` guards)
- Backend: FastAPI (`@router` decorators, `Depends()` auth)
- Schemas: Pydantic v2 (`BaseModel` classes)
- ORM: SQLAlchemy (cascade relationship detection)
- Auth: JWT (via `python-jose` / `PyJWT`)
- Browser: Playwright MCP (Chromium, Firefox, WebKit)

# Changelog

All notable changes to Sentinel are documented in this file.

## [1.2.0] - 2026-03-15

### Added
- **`--risk-level` flag** — override risk policy at runtime without editing settings.json (safe, medium, high, critical)
- **`--safe-only` flag** — shorthand for `--risk-level safe`, limits sweep to read-only GET requests
- **Interactive risk level prompt** — when no risk flag is provided, Sentinel asks which risk level to use (defaults to medium)
- **Risk level in report header** — the active risk level is now always visible in both the terminal summary and the markdown report
- **`--reuse-manifest` flag** — skip manifest regeneration by reusing the manifest from the latest run; also available as an interactive prompt when a previous manifest is detected
- **Clearer safety documentation** — help text now explains the risk model upfront with a dedicated "Safety & Risk Control" section

## [1.1.0] - 2026-03-15

### Added
- **Run-scoped output directories** — each sweep writes to `sentinel-reports/{ISO-timestamp}/` with a `latest` symlink, preventing parallel run collisions
- **Skills 2.0 migration** — added `skills/sentinel/SKILL.md` and `skills/sentinel-setup/SKILL.md` with enriched frontmatter (tags, triggers, author, repository, license)
- **Hello Protocol** — all agents, skills, and the orchestrator implement the standard greeting handshake (`hello` / `hello <name> ID`)
- **Parallel sweeper dispatch** — browser and API sweepers launch simultaneously in `/sentinel sweep`
- **`--dry-run` flag** — generate manifest and show test plan without executing sweeps
- **`/sentinel report --list`** — list all previous sweep runs
- **`.gitignore`** — excludes `sentinel-reports/`, `sentinel-manifest.json`, `node_modules/`, `*.log`
- **`/sentinel trends`** — new subcommand showing pass-rate and finding trends across recent runs with issue deltas
- **Sweep history tracking** — `sweep-history.json` accumulates summary data from each run for cross-run trend analysis
- **GitHub Actions CI** — validates JSON, plugin mirror parity, YAML frontmatter, and version consistency
- **Integration test suite** — 108 tests across 6 suites (structure, frontmatter, schema, mirror parity, version consistency, runtime behavior)
- **JSON Schema files** — formal schemas for manifest, findings, settings, and sweep-history (`schemas/`)
- **Security documentation** — credential handling guidance and sandbox safety checklist in README
- **`/sentinel diff`** — compare two runs side-by-side showing new, fixed, and regressed findings
- **`/sentinel fix`** — auto-suggest and apply code patches for common findings (i18n, RBAC, schema, health)
- **`/sentinel clean`** — prune old sweep runs, keeping the N most recent (default: 5)
- **`--severity` flag** — filter report output by minimum severity level (critical, error, warning, info)
- **Enhanced help text** — usage block now includes descriptions, examples, and getting-started tip
- **`CONTRIBUTING.md`** — contributor guide covering setup, development, testing, and PR workflow
- **Example report** — sample sweep.md in `docs/example-report/` showing realistic output
- **Marketplace.json in plugin mirror** — `plugins/sentinel/.claude-plugin/marketplace.json` now included
- **Command/skill parity test** — CI now verifies `commands/sentinel.md` body matches `skills/sentinel/SKILL.md`

### Changed
- Manifest path passed via dispatch prompt instead of hardcoded CWD lookup
- Findings files renamed from `.api-findings.json` → `api-findings.json` (no dot prefix)
- All output paths are run-scoped (`{reportDir}/{runId}/`)
- Plugin metadata now includes `repository`, `license`, `homepage` fields
- Agent frontmatter includes `version`, `triggers`, and `references` fields

### Fixed
- Report overwrites when multiple sweeps run in the same project
- Hardcoded project-specific reference replaced with generic instruction
- Agent Hello Protocol version strings now match frontmatter (v1.0.0 → v1.1.0)

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

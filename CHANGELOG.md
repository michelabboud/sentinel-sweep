# Changelog

All notable changes to Sentinel are documented in this file.

## [1.8.4] - 2026-03-24

### Fixed
- **Codex orchestrator** — updated command shape with all v1.7+ subcommands (export, config, serve, pr) and flags (--ci, --changed-only, --dashboard, --format, --verify, --visual-regression, --port). Delegation matrix expanded with workers for all 13 subcommands. Added destructive operations safety section, CI mode behavior, and sweep-history metadata (healthScore, commitSha, responseTimePercentiles).
- **codex/CODEX.md and codex/README.md** — version refs updated from v1.8.1 to v1.8.3
- **CONTRIBUTING.md** — updated test suite count (106 → 218), added 2 new test suites, updated framework support section from "Vue 3 + FastAPI" to current 5-language coverage with step-by-step guide

### Added
- **SECURITY.md** — vulnerability disclosure policy, credentials handling, sandbox mode safety, destructive operations gate, data handling, dependency info
- **Finding categories → analyzers mapping** in README — documents which analyzer produces each of the 10 finding categories with severity ranges and examples

## [1.8.3] - 2026-03-24

### Added
- **test-feature-coverage.sh** — 93 tests validating v1.7+ features: subcommand declarations (export, config, serve, pr), flag declarations (--ci, --changed-only, --dashboard, --format, --verify, --visual-regression, --port), health score, CI mode, incremental sweep, visual regression, security headers, response time percentiles, all 10 cross-cutting analyzers (Sections 6.5-6.14), 9 cross-cutting schema fields, multi-service fields, framework enum completeness (7 frontend + 17 backend), auth method enums, endpoint extensions (protocol, sweepable), README feature coverage (14 checks), Codex port version sync
- **test-bump-version.sh** — 18 tests validating bump-version.sh: regex safety (escaped dots, no blind replace), dangerous version patterns (1.7.0, 1.2.0, etc. vs 127.0.0.1), input validation (non-semver, incomplete semver, same-version), targeted replacement patterns, content preservation (IP addresses, localhost)
- **Codex files added to bump-version.sh** — Codex port now auto-bumped with `X.Y.Z-codex.1` format during version bumps

### Changed
- Test suite expanded from 107 tests / 6 suites to **218 tests / 8 suites**

## [1.8.2] - 2026-03-24

### Fixed
- **JSON schemas updated to v1.8.1 parity** — `findings.schema.json` now includes `visual` category, `service` field, `responseTimePercentiles` metadata. `settings.schema.json` now includes `services` array. `sentinel-manifest.schema.json` now includes all 8 frontend frameworks, 20 backend frameworks, 5 auth methods, `oauth` config, `services` array, and all 9 cross-cutting analysis fields (i18n, a11y, deadCode, deadCss, n1Queries, vulnerabilities, apiVersioning, migrationDrift, rateLimiting). `sweep-history.schema.json` now includes `healthScore`, `commitSha`, `responseTimePercentiles`.
- **Codex port synced to v1.8.1** — all 4 Codex files updated from v1.6.0-codex.1 to v1.8.1-codex.1 with full feature parity: 7 frontend parsers, 14+ backend parsers, 15 cross-cutting analyzers, 5 auth methods, visual regression, response time percentiles, security headers audit.
- **Codex test added to run-all.sh** — `codex/tests/test-codex-port.sh` now included as optional test in the main suite.

## [1.8.1] - 2026-03-24

### Fixed
- **bump-version.sh regex bug** — the script used blind `sed "s/$OLD_VERSION/$NEW_VERSION/g"` which corrupted `127.0.0.1` into `1.8.0.0.1` when the old version matched inside IP addresses (regex `.` matches any character). Now uses escaped dots (`\.`) and targeted patterns (`^version:`, `"version":`, `vX.Y.Z\b`) instead of global replace. Verified safe across all version transitions.

## [1.8.0] - 2026-03-24

### Added
- **Database query N+1 detection** — Section 6.13: static analysis of ORM queries inside loops for SQLAlchemy, Django ORM, Prisma, TypeORM, Eloquent, GORM. Detects lazy relationship access in loops and suggests eager loading fixes.
- **API response time percentile tracking** — Section 4.5 in api-sweeper: computes p50/p95/p99/avg per endpoint, flags slow endpoints, stores in metadata for trend tracking across sweeps
- **Multi-language i18n completeness matrix** — enhanced Section 6.5: compares all locale files against each other, produces per-locale coverage scores, flags keys missing in specific locales
- **Dependency vulnerability scanning** — Section 6.14: runs `npm audit`, `pip-audit`, `cargo audit`, `composer audit`, `govulncheck`. Parses results into manifest with severity, CVE, fix version.
- **Live dashboard web UI** (`serve`) — generates self-contained HTML dashboard from sweep data. Health score cards, filterable findings table, RBAC matrix, trends chart, i18n coverage, response times, vulnerability summary. Dark theme, no build step.
- **GitHub PR integration** (`pr`) — auto-posts/updates sweep results as PR comments via `gh api`. Shows health score, critical issues, diff vs previous run. Updates existing comment on re-run.
- **Playwright visual regression** — Section 6.5 in browser-sweeper: pixel-diff comparison against baseline screenshots from previous run. Thresholds: <0.1% noise, 0.1-5% info, 5-20% warning, >20% error. Canvas-based diff with ImageMagick fallback.

## [1.7.2] - 2026-03-24

### Changed
- **Tailwind v3 + v4 explicit support** — Dead class analysis now differentiates between Tailwind v3 (JS config, `content` array, `theme.extend`, `safelist`) and v4 (CSS-first `@theme`, `@utility`, `@variant`, `@source`). v4 analysis parses `--color-*`, `--font-*`, `--breakpoint-*`, `--animate-*` tokens, `@utility` custom classes, `@variant` custom prefixes, and handles `@theme reference`/`@theme inline` modifiers. Breakpoint detection also updated with explicit v3 vs v4 paths.
- **`deadCss` manifest output expanded** — Now includes `tailwindVersion` (3 or 4), `deadTokens` (v4 `@theme` tokens never used), `customUtilities` (v4 `@utility`), `customVariants` (v4 `@variant`), `safelistCount` (v3), `configExtensions` (v3).

## [1.7.1] - 2026-03-24

### Added
- **CSS/Tailwind dead class analysis** — Section 6.12: detects unused Tailwind utilities (via template scanning of `className`, `cn()`, `clsx()`, `cva()`, `tv()`), CSS Module dead classes (`styles.X` reference checking), and plain CSS orphaned selectors. Handles safelists, dynamic class warnings, and confidence levels. Produces `deadCss` manifest field with coverage metric.

## [1.7.0] - 2026-03-24

### Added
- **Performance Scoring Dashboard** (`--dashboard`) — composite health score (0-100) with weighted category breakdowns (API health, RBAC, schema, layout, i18n, a11y). Grade A-F. Always computed, `--dashboard` shows visual bar chart.
- **CI/CD Integration Mode** (`--ci`) — non-interactive mode with JSON stdout, exit codes (0=clean, 1=critical, 2=errors), no screenshots, blocked high/critical risk levels
- **Incremental Sweep** (`--changed-only`) — uses `git diff` against previous sweep's commit SHA to only test changed endpoints/routes. 10x faster for large apps.
- **Visual Diff** — upgraded `diff` subcommand with tree-style endpoint comparison showing +NEW/-REMOVED/~CHANGED with risk and RBAC changes
- **Auto-Fix Agent upgrade** — `fix` now shows diff previews, applies patches with confirmation, supports batch "all" mode. Added i18n key insertion, RBAC middleware injection, schema field addition.
- **Regression Guard** (`fix --verify`) — after applying fixes, auto-re-sweeps affected endpoints to verify fixes worked. Offers to revert regressions.
- **Export Collections** (`export --format postman|insomnia|bruno`) — generates API collections from manifest with auth config, sample bodies, resource grouping
- **Interactive Config** (`config`) — settings editor for risk policy, breakpoints, browser, auth, services with validation
- **Parallel Manifest Generation** — dispatches 4 sub-agents (routes, endpoints, schemas, config) in parallel for faster manifest creation on large projects
- **WebSocket Endpoint Detection** — detects WS endpoints across all frameworks, tagged with `protocol: "websocket"` and `sweepable: false`
- **API Versioning Analysis** — detects URL/header versioning, flags deprecated endpoints still in use, version gaps
- **Database Migration Drift Detection** — compares migrations against ORM models for Alembic, Django, Prisma, Laravel, Diesel. Flags missing migrations and orphaned columns.
- **Rate Limiting Detection** — detects rate limit libraries, maps protected vs unprotected endpoints, flags public endpoints without limits
- **Security Headers Audit** — checks HSTS, CSP, X-Content-Type-Options, X-Frame-Options, CORS wildcards, cookie flags (HttpOnly, Secure, SameSite), server info disclosure

## [1.6.1] - 2026-03-24

### Changed
- **Destructive operations warning** — mandatory confirmation gate for `high` and `critical` risk levels. Displayed as a bordered warning box requiring the user to type `"yes"` (not just `y` or Enter). Applies to both orchestrator risk-level selection and per-endpoint sandbox prompts.
- **Upgraded sandbox confirmation prompts** — HIGH risk endpoints now show a bordered warning box; CRITICAL endpoints show a double-bordered box with cascade warning. Both require explicit `"yes"` confirmation instead of `y/n`.
- **Consecutive skip hint** — after 3+ critical endpoint skips, suggests `--risk-level medium` or `--safe-only`

## [1.6.0] - 2026-03-24

### Added
- **Go full support** — Gin, Echo, and Chi endpoint parsers; Go struct schema parser (JSON tags, pointer nullability); GORM cascade detection
- **PHP/Laravel full support** — Laravel route parser (`Route::get/post/apiResource`, Sanctum/Spatie auth); FormRequest validation schema parser; Eloquent API Resource parser; Eloquent cascade detection (migrations + model events)
- **Remix route/action parser** — file-system routes (v2 flat conventions), `loader` (GET) and `action` (POST) function extraction with auth detection
- **gRPC endpoint discovery** — `.proto` service/rpc parsing, message type → schema extraction
- **tRPC endpoint discovery** — router procedure parsing (`query`/`mutation`), `protectedProcedure`/`adminProcedure` auth detection, Zod input/output linking
- **GraphQL schema introspection** — SDL type/query/mutation parsing, code-first support (type-graphql, NestJS, Pothos), resolver auth detection, GraphQL type → schema extraction
- **OpenAPI auto-generation from code annotations** — detects and extracts specs from utoipa (Rust), swagger-jsdoc (JS), drf-spectacular (Django), FastAPI auto-docs, NestJS Swagger, swag (Go), @hono/zod-openapi, rocket_okapi, flask-restx
- **Accessibility (a11y) static analysis** — detects missing alt text, form labels, keyboard handlers, heading hierarchy, button text, tabIndex issues; produces `a11y` manifest section with score
- **Dead endpoint/route detection** — cross-references frontend API calls (fetch, axios, SWR, tRPC, GraphQL) with backend endpoints to find dead endpoints and phantom frontend references
- **GORM cascade detection** (Go) — `gorm:"constraint:OnDelete:CASCADE"` tags
- **Eloquent cascade detection** (PHP) — migration `onDelete('cascade')`, model `deleting` events, `SoftDeletes` trait

## [1.5.0] - 2026-03-24

### Added
- **Rust full support** — Actix-web, Axum, and Rocket endpoint parsers; Rust serde struct schema parser (`#[derive(Serialize)]` with serde attributes, utoipa `ToSchema`); Diesel and SeaORM cascade detection
- **Angular route parser** — full parser for `Routes` arrays, `canActivate`/`canActivateChild` guards, lazy-loaded modules
- **Flask endpoint parser** — `@app.route()`, Blueprints, `flask-login`, `flask-jwt-extended`, `flask-marshmallow`
- **Hono endpoint parser** — `app.get/post/...`, `jwt()` middleware, `zValidator()` schema linking
- **Koa endpoint parser** — `koa-router`, `koa-jwt`/`koa-passport`/`koa-session` middleware
- **OpenAPI / Swagger spec import** — reads `openapi.json`/`.yaml` as primary or supplementary endpoint and schema source; merges with code-parsed data
- **Static i18n analysis** — cross-references locale files (JSON/YAML/FTL) with code usage (`$t()`, `t()`, `useTranslation()`, etc.) to find missing and unused translation keys; adds `i18n` manifest section with coverage metric
- **OAuth PKCE auth** — full Authorization Code with PKCE flow for both API sweeper (curl-based code exchange) and browser sweeper (Playwright-based authorize → consent → redirect → token)
- **Diesel ORM cascade detection** — `ON DELETE CASCADE` in migrations, `joinable!` macros
- **SeaORM cascade detection** — `#[sea_orm(on_delete = "Cascade")]`, relation enums

### Fixed
- **Known Limitations table** — removed stale v1.0.0 entries ("JWT auth only", "Vue 3 + FastAPI only") that no longer apply

## [1.4.0] - 2026-03-23

### Added
- **Multi-framework support** — Sentinel now has full parsers for 5 frontend frameworks, 5 backend frameworks, 4 schema systems, 4 auth methods, and 5 ORMs:
  - **Frontend**: Vue 3, Nuxt 3 (file-system routing), Next.js App Router, React Router, SvelteKit
  - **Backend**: FastAPI, Express.js, Django REST Framework, NestJS, Next.js API routes
  - **Schemas**: Pydantic v2, Zod, TypeScript interfaces/types, Django serializers
  - **Auth**: JWT, NextAuth/Auth.js, session/cookie, API key
  - **ORM cascade detection**: SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose
- **Session/cookie auth for API sweeper** — API sweeper now supports cookie-based auth (session, NextAuth) in addition to JWT
- **Codex port synced** — multi-service support, multi-framework docs, and dispatch patterns updated

## [1.3.0] - 2026-03-18

### Added
- **Multi-service architecture support** — sweep projects with multiple APIs and frontends (e.g., Internal Archive + Public Portal)
  - New `services` array in `settings.json` for explicit service configuration
  - Auto-detection from multiple `docker-compose.yml` files
  - Per-service manifest tagging (routes/endpoints tagged with `"service"` field)
  - Parallel sweeper dispatch per service (one api-sweeper + one browser-sweeper each)
  - Report findings grouped by service name
  - Full backward compatibility — single-service projects work unchanged

## [1.2.2] - 2026-03-16

### Fixed
- **Enforce parallel sweep dispatch** — added explicit parallelism instruction so browser and API sweepers run concurrently during `/sentinel:run sweep`

## [1.2.1] - 2026-03-16

### Changed
- **Skill renamed `sentinel` → `run`** — invocation is now `/sentinel:run <command>` instead of `/sentinel:sentinel <command>`
- **Updated plugin descriptions** — plugin.json and marketplace.json now show actionable invocation syntax
- **Email updated** — author email changed to info@maicore.dev
- **Help text updated** — all examples and error messages use `/sentinel:run` syntax

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
- **Skills 2.0 migration** — added `skills/run/SKILL.md` and `skills/sentinel-setup/SKILL.md` with enriched frontmatter (tags, triggers, author, repository, license)
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
- **Command/skill parity test** — CI now verifies `commands/sentinel.md` body matches `skills/run/SKILL.md`

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

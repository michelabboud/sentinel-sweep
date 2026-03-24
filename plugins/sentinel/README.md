# Sentinel

Automated QA sweep plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys in web applications.

> **v1.8.0** | Python + TypeScript + Rust + Go + PHP | 14 backend frameworks + GraphQL/gRPC/tRPC | 5 auth methods | Playwright MCP

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Multi-Service Projects](#multi-service-projects)
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
claude plugin marketplace add https://github.com/michelabboud/sentinel-sweep
claude plugin install sentinel
```

### From local path

```bash
claude plugin marketplace add /path/to/sentinel-sweep
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
| `/sentinel api --reuse-manifest` | Reuse manifest from the last run (skip codebase analysis) |
| `/sentinel sweep --safe-only` | Read-only sweep — only GET requests, nothing gets modified |
| `/sentinel sweep --risk-level high` | Override risk policy at runtime (safe, medium, high, critical) |
| `/sentinel report` | View the most recent sweep report |
| `/sentinel report --list` | List all past sweep runs |
| `/sentinel report --severity error` | Filter report to show only errors and critical issues |
| `/sentinel diff` | Compare latest two runs — shows new, fixed, and regressed findings |
| `/sentinel fix` | Auto-suggest and apply code patches for common findings |
| `/sentinel clean` | Remove old sweep runs, keeping the 5 most recent (or specify N) |
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
  "emptyContainerSelectors": ["[data-sentinel-content]", "main", ".card-body"],
  "services": []
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
| `services` | `[]` | Multi-service configuration (see [Multi-Service Projects](#multi-service-projects)) |

### Tailwind breakpoint auto-detection

If you use Tailwind CSS, Sentinel auto-detects your custom breakpoints from `tailwind.config.js` or `@theme` CSS blocks. Detected breakpoints override the defaults unless you've explicitly set them in `settings.json`.

---

## Multi-Service Projects

Sentinel supports projects with multiple APIs and frontends — for example, an Internal Archive (admin API + admin dashboard) and a Public Portal (public API + SSR frontend) under the same repository.

### Configuration

Add a `services` array to `settings.json`:

```json
{
  "services": [
    {
      "name": "internal-archive",
      "apiBaseUrl": "http://localhost:18000",
      "baseUrl": "http://localhost:13001",
      "sourcePath": "internal/"
    },
    {
      "name": "public-portal",
      "apiBaseUrl": "http://localhost:18001",
      "baseUrl": "http://localhost:13000",
      "sourcePath": "public/"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Service identifier (used in findings, reports, and output filenames) |
| `apiBaseUrl` | Yes | Base URL for API requests |
| `baseUrl` | No | Base URL for browser navigation (omit for API-only services) |
| `sourcePath` | No | Path to service source code (default: `"."` — project root) |
| `auth` | No | Per-service auth override (inherits top-level `auth` if not set) |

### Auto-detection

If `services` is empty, the manifest generator auto-detects multi-service projects from multiple `docker-compose.yml` files in different subdirectories. Each docker-compose file with distinct API ports becomes a separate service.

### How it works

1. **Manifest generation** — The manifest generator processes each service's `sourcePath` independently, tagging every route and endpoint with `"service": "service-name"`
2. **Parallel dispatch** — The orchestrator dispatches one API sweeper + one browser sweeper per service, all in a single parallel batch
3. **Findings merge** — Results from all service sweepers are merged, with each finding tagged by service
4. **Grouped reports** — Report sections group findings under service name subheadings

### Output structure (multi-service)

```
sentinel-reports/
└── 2026-03-18T10-00-00Z/
    ├── sentinel-manifest.json
    ├── internal-archive-api-findings.json
    ├── internal-archive-browser-findings.json
    ├── public-portal-api-findings.json
    ├── public-portal-browser-findings.json
    └── sweep.md
```

### Backward compatibility

Single-service projects work exactly as before. The `services` field defaults to `[]`, no `service` tags are added to findings, and output filenames remain `api-findings.json` / `browser-findings.json`.

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
│   ├── api-findings.json         # API sweeper results (single-service)
│   ├── browser-findings.json     # Browser sweeper results (single-service)
│   ├── sweep.md                  # Full markdown report
│   └── screenshots/              # Layout issue screenshots
└── 2026-03-14T09-15-00Z/
    └── ...
```

In multi-service mode, findings files are prefixed with the service name (e.g., `internal-archive-api-findings.json`). See [Multi-Service Projects](#multi-service-projects).

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

### Frontend Routing (7 parsers)

| Framework | Language | Status | Route Source |
|-----------|----------|--------|-------------|
| **Vue 3** | JS/TS | Full parser | Vue Router (`router/index.ts`) with `meta.role` guards |
| **Nuxt 3** | JS/TS | Full parser | File-system routing (`pages/`) with `definePageMeta` |
| **Next.js** | JS/TS | Full parser | App Router (`app/`) with layout auth, also API routes |
| **React Router** | JS/TS | Full parser | `createBrowserRouter`, `<Route>` JSX, wrapper auth |
| **SvelteKit** | JS/TS | Full parser | File-system routing (`src/routes/`) with server hooks |
| **Angular** | TypeScript | Full parser | `Routes` arrays, `canActivate` guards, lazy-loaded modules |
| **Remix** | JS/TS | Full parser | File-system routing (`app/routes/`) with v2 flat conventions, `loader`/`action` auth |

### Backend API (14 parsers + OpenAPI + GraphQL/gRPC/tRPC)

| Framework | Language | Status | Endpoint Source |
|-----------|----------|--------|----------------|
| **FastAPI** | Python | Full parser | `@router` decorators, `Depends()` auth, `response_model` |
| **Express.js** | JS/TS | Full parser | `router.get/post/...`, middleware auth patterns |
| **Django REST** | Python | Full parser | `urlpatterns`, `ViewSet`, `permission_classes` |
| **NestJS** | TypeScript | Full parser | `@Controller`, `@Get/@Post`, `@UseGuards`, `@Roles` |
| **Next.js API** | JS/TS | Full parser | `app/api/` route handlers (`GET`, `POST` exports) |
| **Flask** | Python | Full parser | `@app.route()`, Blueprints, `flask-login`/`flask-jwt-extended` |
| **Hono** | JS/TS | Full parser | `app.get/post/...`, `jwt()` middleware, `zValidator()` |
| **Koa** | JS/TS | Full parser | `koa-router`, `koa-jwt`/`koa-passport` middleware |
| **Remix** | JS/TS | Full parser | `loader` (GET) + `action` (POST) exports with auth detection |
| **Actix-web** | Rust | Full parser | `#[get]`/`#[post]` macros, `web::scope`, `actix-web-grants` |
| **Axum** | Rust | Full parser | `Router::new().route()`, `Extension<Claims>`, tower middleware |
| **Rocket** | Rust | Full parser | `#[get]`/`#[post]` attributes, request guards, `.mount()` |
| **Gin** | Go | Full parser | `r.GET/POST/...`, group middleware, handler struct types |
| **Echo** | Go | Full parser | `e.GET/POST/...`, `middleware.JWT()`, group prefixes |
| **Chi** | Go | Full parser | `r.Get/Post/...`, `.With()` per-route middleware, `{param}` native |
| **Laravel** | PHP | Full parser | `Route::get/post/apiResource`, Sanctum/Spatie middleware |
| **GraphQL** | Any | Full parser | SDL `Query`/`Mutation` types, resolver auth, type-graphql/NestJS/Pothos |
| **gRPC** | Any | Full parser | `.proto` service/rpc definitions, message types as schemas |
| **tRPC** | TypeScript | Full parser | `createTRPCRouter` procedures, `protectedProcedure`, Zod I/O |
| **OpenAPI/Swagger** | Any | Full import | `openapi.json`/`.yaml` + auto-gen from utoipa, swagger-jsdoc, drf-spectacular, swag |

### Schema Validation (8 parsers)

| System | Language | Source |
|--------|----------|--------|
| **Pydantic v2** | Python | `BaseModel` classes with field annotations |
| **Zod** | TypeScript | `z.object()` definitions with chain methods |
| **TypeScript** | TypeScript | `interface` and `type` declarations |
| **Django serializers** | Python | `ModelSerializer` with Meta class |
| **Rust serde** | Rust | `#[derive(Serialize)]` structs, serde attributes, utoipa `ToSchema` |
| **GraphQL types** | Any | SDL `type`/`input`/`enum` definitions |
| **Go structs** | Go | Structs with `json:` tags, pointer nullability |
| **Laravel** | PHP | `FormRequest` validation rules, API Resources, Eloquent `$casts` |

### Auth Methods (5)

| Method | API Sweep | Browser Sweep |
|--------|-----------|---------------|
| **JWT** | `Authorization: Bearer` header | Token injection via localStorage |
| **NextAuth / Auth.js** | Session cookie from login (cookie jar) | Form-based sign-in |
| **Session / cookie** | `Cookie` header from login (cookie jar) | Form-based login |
| **API key** | `x-api-key` header | N/A |
| **OAuth PKCE** | PKCE challenge + code exchange → Bearer token | Navigate to authorize → fill form → consent → redirect → token |

### ORM Cascade Detection (9)

| ORM | Language | Cascade Pattern |
|-----|----------|----------------|
| **SQLAlchemy** | Python | `relationship(cascade="all, delete-orphan")` |
| **Django ORM** | Python | `ForeignKey(on_delete=models.CASCADE)` |
| **Prisma** | TypeScript | `@relation(onDelete: Cascade)` |
| **TypeORM** | TypeScript | `@ManyToOne({ onDelete: 'CASCADE' })` |
| **Mongoose** | JS/TS | `pre('deleteOne')` hooks |
| **Diesel** | Rust | `ON DELETE CASCADE` in migrations, `joinable!` macros |
| **SeaORM** | Rust | `#[sea_orm(on_delete = "Cascade")]`, relation enums |
| **GORM** | Go | `gorm:"constraint:OnDelete:CASCADE"` struct tags |
| **Eloquent** | PHP | Migration `onDelete('cascade')`, model `deleting` events, `SoftDeletes` |

### Cross-Cutting Analysis (4)

| Feature | Description |
|---------|-------------|
| **Static i18n analysis** | Cross-references locale files with code usage to find missing/unused translation keys; coverage metric |
| **Accessibility (a11y) analysis** | Detects missing alt text, form labels, keyboard handlers, heading hierarchy, button text; a11y score |
| **Dead endpoint detection** | Cross-references frontend API calls with backend endpoints to find dead code and phantom references |
| **OpenAPI auto-generation** | Extracts OpenAPI specs from code annotations (utoipa, swagger-jsdoc, drf-spectacular, swag, @hono/zod-openapi) |
| **WebSocket detection** | Detects WS endpoints across all frameworks, tags as `protocol: websocket`, documents but doesn't sweep |
| **API versioning analysis** | Detects URL/header versioning strategy, flags deprecated endpoints still in use, version gaps |
| **Migration drift detection** | Compares ORM models against migrations for Alembic, Django, Prisma, Laravel, Diesel — flags missing migrations and orphaned columns |
| **Rate limiting detection** | Maps protected vs unprotected endpoints, flags public endpoints without rate limits |
| **Security headers audit** | Checks HSTS, CSP, X-Content-Type-Options, CORS wildcards, cookie flags, server info disclosure |
| **CSS/Tailwind dead class analysis** | Detects unused Tailwind v3/v4 utilities, CSS Module dead classes, plain CSS orphaned selectors; coverage metric |
| **N+1 query detection** | Static analysis of ORM queries inside loops — SQLAlchemy, Django, Prisma, TypeORM, Eloquent, GORM |
| **Dependency vulnerability scanning** | Runs `npm audit`, `pip-audit`, `cargo audit`, `composer audit`, `govulncheck` — maps to Sentinel severity |
| **Response time percentiles** | p50/p95/p99 per endpoint, flags slow endpoints, tracks trends across runs |
| **i18n completeness matrix** | Per-locale coverage comparison across all locale files (en vs fr vs de) |
| **Visual regression** | Pixel-diff screenshot comparison against previous run baselines (0.1%/5%/20% thresholds) |

### Platform Features

| Feature | Description |
|---------|-------------|
| **Health score dashboard** | Composite 0-100 score with A-F grade and category breakdowns (API, RBAC, schema, layout, i18n, a11y) |
| **CI/CD mode** (`--ci`) | Non-interactive JSON output, exit codes (0/1/2), blocked destructive ops |
| **Incremental sweep** (`--changed-only`) | Only sweeps endpoints whose source files changed since last run via git diff |
| **Visual diff** | Tree-style diff showing +NEW/-REMOVED/~CHANGED endpoints with risk and RBAC changes |
| **Auto-fix + regression guard** | Applies fixes with diff preview, re-sweeps to verify, offers to revert regressions |
| **Collection export** | Generates Postman, Insomnia, or Bruno collections from manifest |
| **Interactive config** | Settings editor for risk policy, breakpoints, browser, auth, services |
| **Parallel manifest gen** | Dispatches 4 sub-agents for routes, endpoints, schemas, config in parallel |
| **Live dashboard** (`serve`) | Self-contained HTML dashboard with health scores, findings table, trends chart, RBAC matrix |
| **GitHub PR comments** (`pr`) | Auto-posts sweep results to current PR via `gh api`, updates on re-run |

### Browser Automation

Playwright MCP (Chromium, Firefox, WebKit) + visual regression testing

### Planned

- Custom rule engine (`.sentinel-rules.yml`)
- Multi-repo sweep (monorepo-aware)
- Swagger UI hosting from generated specs
- GraphQL query complexity analysis

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
| **i18n coverage** | Static analysis catches most missing keys; keys behind modals or conditional UI may be missed — browser sweep provides additional runtime coverage |
| **Complex Pydantic/serde models** | Deep inheritance, `computed_field`, and complex serde attributes may not fully parse — use `schemaOverride` |
| **Playwright required for browser sweep** | Falls back to API-only mode if Playwright MCP is unavailable |
| **OAuth PKCE provider variance** | OAuth login form differs per provider; Sentinel uses heuristic selectors — may need manual credential configuration for non-standard providers |
| **OpenAPI spec completeness** | If the spec is partial or outdated, some endpoints may be missed or have incorrect schemas — code-parsed endpoints take precedence when both sources exist |

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

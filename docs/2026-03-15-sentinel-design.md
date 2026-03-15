# Sentinel — Automated QA Sweep Plugin for Claude Code

> **Status:** Design reviewed — ready for implementation planning
> **Author:** Michel Abboud
> **Date:** 2026-03-15

## Goal

A standalone Claude Code plugin that performs automated QA sweeps on web applications after development, catching console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys — before a human has to find them manually.

## Architecture

Sentinel is a Claude Code plugin with three operating modes:

1. **Browser Mode** (`/sentinel sweep`) — Playwright-based. Navigates every route as each role, captures console errors, network failures, layout issues, and responsive problems across configurable breakpoints.
2. **API Mode** (`/sentinel api`) — No browser. Tests every endpoint for health, RBAC enforcement, CRUD flow correctness, and response schema compliance against Pydantic models.
3. **Report Mode** (`/sentinel report`) — View the last sweep report or regenerate.

### Core Flow

```
/sentinel sweep
    |
[1] Generate manifest (reads codebase: router, endpoints, models, roles)
    |
[2] Risk assessment (classify every route/action as safe/medium/high/critical)
    |
[3] Execute sweep (API calls + browser navigation, filtered by risk policy)
    |
[4] Collect findings (errors, warnings, layout issues, RBAC violations, schema drift)
    |
[5] Generate report (terminal summary + markdown file + task list)
```

### Plugin Components

| Component | Type | Purpose |
|-----------|------|---------|
| `/sentinel` | Command | Main entry point, routes to subcommands |
| manifest-generator | Agent | Reads codebase, produces sentinel-manifest.json |
| api-sweeper | Agent | API-only sweep (endpoint health, RBAC, schemas, CRUD) |
| browser-sweeper | Agent | Playwright-based browser sweep |
| sentinel-setup | Skill | Environment detection, dependency checks, configuration |

---

## Manifest Generation

The manifest-generator agent reads the codebase and produces `sentinel-manifest.json`. This file drives every sweep — it defines what to test, how to authenticate, and what's dangerous.

### Manifest Schema

```json
{
  "app": {
    "name": "string — project name",
    "framework": {
      "frontend": "vue | react | svelte | angular | none",
      "backend": "fastapi | express | django | rails | none"
    },
    "baseUrl": "string — frontend URL (e.g. http://localhost:5193)",
    "apiBaseUrl": "string — API URL (e.g. http://localhost:8020)"
  },
  "auth": {
    "method": "jwt | session | none",
    "loginEndpoint": "string — e.g. /api/v1/auth/login",
    "roles": {
      "<role_name>": {
        "email": "string",
        "password": "string"
      }
    }
  },
  "routes": [
    {
      "path": "string — frontend route path",
      "view": "string — component name",
      "requiredRole": "string | null — minimum role needed",
      "riskLevel": "safe | medium | high | critical",
      "riskScore": "number 0-100",
      "params": "object | null — parameter resolution (e.g. { id: 'lookup:groups[0].id' })",
      "description": "string — what this route does (required for high/critical)"
    }
  ],
  "endpoints": [
    {
      "method": "GET | POST | PUT | PATCH | DELETE",
      "path": "string — API path with {param} placeholders",
      "requiredRole": "string | null",
      "riskLevel": "safe | medium | high | critical",
      "riskScore": "number 0-100",
      "responseSchema": "string | null — Pydantic model name",
      "description": "string — what this endpoint does",
      "sideEffects": ["string — affected data/tables (for high/critical)"],
      "requiresConfirm": "boolean — needs ?confirm=true"
    }
  ],
  "crudFlows": [
    {
      "name": "string — flow identifier",
      "steps": ["string — ordered endpoint references (e.g. POST /users)"],
      "riskLevel": "safe | medium | high | critical"
    }
  ],
  "schemas": {
    "<SchemaName>": {
      "source": "string — file path (e.g. schemas/user.py:15)",
      "fields": {
        "<field_name>": {
          "type": "string | number | boolean | array | object | null",
          "required": "boolean",
          "nullable": "boolean"
        }
      }
    }
  },
  "breakpoints": [375, 768, 1280],
  "riskPolicy": {
    "maxRiskLevel": "medium",
    "alwaysSkip": ["DELETE /api/v1/users/{id}"],
    "alwaysAllow": ["POST /api/v1/groups/{id}/members"]
  }
}
```

**`alwaysSkip` / `alwaysAllow` entry format:** Each entry is an endpoint string matching `"METHOD /path"` (for API endpoints) or `"/route/path"` (for frontend routes). Entries are matched against manifest entries by exact string comparison. Manifest `riskPolicy` is the base; settings.json `riskPolicy` overrides it (settings take precedence on conflict).

### Manifest Sources

| Source | What it extracts |
|--------|-----------------|
| `router/index.js` (or framework equivalent) | Frontend routes, role guards, lazy-load components |
| `api/v1/endpoints/*.py` | API endpoints, HTTP methods, auth decorators, query params |
| `schemas/*.py` | Pydantic response models, field names, types, required/optional |
| `models/*.py` | Database models, relationships, cascade behavior (for side effects) |
| `CLAUDE.md` | Seed credentials, architecture context, port mappings |
| `.env` / `.env.example` | Base URLs, ports, environment detection |
| Tailwind config (if present) | Custom breakpoint values |

### Parameter Resolution

Parameterized routes (e.g. `/groups/:id/members`) need real values. The manifest uses a lookup syntax:

- `"lookup:groups[0].id"` — fetch the first group from GET /groups and use its id
- `"lookup:users[0].id"` — fetch the first user from GET /users and use its id
- `"static:00000000-0000-0000-0000-000000000001"` — hardcoded value
- `"env:SEED_ADMIN_ID"` — from environment variable

The sweep engine resolves these before navigating.

**Failure handling:**
- If a lookup returns empty results (no records): skip the route, log as "Info: skipped — no test data for parameter"
- If a lookup is permission-blocked (role can't access the list endpoint): use a static fallback from the manifest if available, otherwise skip
- If all parameter resolution fails for a route: the route is skipped with a clear entry in the report

### Manifest Lifecycle

- `/sentinel sweep` and `/sentinel api` **always regenerate** the manifest before sweeping (ensures freshness)
- `/sentinel manifest` generates and saves without sweeping (for inspection)
- Manual edits to `sentinel-manifest.json` are supported: the generator uses a **merge strategy** — auto-generated fields are overwritten, but fields marked with `"manual": true` in the entry are preserved
- The manifest includes a `generatedAt` timestamp; the report shows which manifest version was used

### Role Hierarchy

The manifest includes an explicit role ordering so the plugin knows which roles are "above" or "below" others:

```json
"auth": {
  "roleHierarchy": ["admin", "manager", "user"],
  ...
}
```

The first role has the most access, the last has the least. RBAC negative testing uses this: for a route requiring "manager", the plugin tests that "user" and unauthenticated get 401/403, while "admin" and "manager" get 200.

### CRUD Flow Detection

The manifest-generator auto-detects CRUD flows by grouping endpoints that share a resource path pattern:
- Endpoints matching `POST /resource`, `GET /resource/{id}`, `PATCH /resource/{id}`, `DELETE /resource/{id}` are grouped into a flow
- The generator names the flow after the resource (e.g., "users-lifecycle")
- Flows can be manually overridden in the manifest (`"manual": true`)
- Not all resources have full CRUD — partial flows (e.g., create + read only) are valid

### Known Limitations (v1)

- **Auth**: v1 supports JWT-based authentication only. Session cookies, CSRF tokens, and OAuth PKCE browser flows are not supported.
- **i18n coverage**: Browser sweep only catches missing i18n keys that are rendered during navigation. Keys behind conditional UI (modals, error states) may not be triggered. A supplemental static analysis pass (grep translation calls against locale files) is planned for v2.
- **Schema parsing**: The manifest-generator reads Pydantic model source files and extracts field definitions via pattern matching. Complex models using deep inheritance chains, `computed_field`, or runtime validators may not parse correctly. For these cases, the manifest supports a `"schemaOverride"` field where the correct schema can be specified manually.

---

## Risk Assessment & Safety

### Risk Classification

| Level | Score | Examples | Default Policy |
|-------|-------|----------|---------------|
| **safe** | 0-25 | GET routes, read-only views, list pages | Execute freely |
| **medium** | 26-50 | Create forms, profile edits, status changes | Execute (default threshold) |
| **high** | 51-75 | Bulk operations, payment mutations, role changes | Skip, flag in report |
| **critical** | 76-100 | DELETE endpoints, "purge" buttons, database resets, hard-deletes | Never execute, warn loudly |

### Risk Scoring Signals

Base score from HTTP method, plus modifiers. Final score is **clamped to 0-100**.

- HTTP method: GET=0, POST=25, PUT/PATCH=30, DELETE=60
- Auth decorator: `require_admin` adds +10
- Keyword detection: "delete"=+15, "purge"/"reset"=+20, "remove all"/"bulk"=+15
- `?confirm=true` pattern: +15
- Cascade behavior (deletes related records): +10
- Irreversible action (hard-delete vs soft-delete): +15

Score is calculated as `min(100, base + sum(modifiers))`. Classification follows the score ranges in the table above.

### Sandbox Mode

`/sentinel sweep --sandbox` unlocks high and critical actions with safeguards:

**Pre-flight checks:**
- Verifies `APP_ENV != production`
- Checks database name contains "dev", "test", "staging", or "local"
- Checks base URL is localhost, 127.0.0.1, or contains "dev"/"staging"
- If any check fails: sandbox mode is blocked entirely

**Per-action approval for high/critical:**

```
WARNING — HIGH RISK action detected:

  Route: DELETE /api/v1/groups/{id}/members/{mid}
  Description: Soft-deletes a member from a group
  Risk Score: 62/100
  Risk Factors: DELETE method, member mutation
  Side Effects: Sets deleted_at on member record

  Execute this action? [y/n]
```

```
CRITICAL action detected:

  Route: DELETE /api/v1/users/{id}?confirm=true
  Description: Hard-deletes a user and all associated data
  Risk Score: 91/100
  Risk Factors: Hard delete, cascade deletion, requires ?confirm=true
  Side Effects:
    - Removes user record permanently
    - Cascades to linked members
    - Deletes payment history
    - Removes attendance records

  Execute this action? [y/n]
```

**Post-sweep:**
- All destructive actions logged in "Sandbox Actions" report section
- Report suggests restore steps (e.g. "Run `docker-compose exec api python -m app.seed.seed_data` to restore demo data")

### Production Safeguards

The plugin refuses destructive actions if it detects production:
- `APP_ENV=production` → sandbox mode blocked
- URL contains no localhost/dev/staging keywords → sandbox mode blocked
- These checks cannot be overridden

---

## Browser Sweep Engine

Uses Playwright MCP (must be installed — `/sentinel setup` checks this). If Playwright MCP is unavailable, browser mode is disabled and `/sentinel sweep` falls back to API-only mode with a warning. The setup skill verifies Playwright availability and offers installation.

### Sweep Sequence

For each role (admin, manager, user, unauthenticated):

1. Launch browser at desktop breakpoint (1280px)
2. Login as role (or skip for unauthenticated)
   - **If login fails**: emit a Critical finding ("Login failed for role X"), skip all routes for this role, continue with next role
3. For each route accessible to this role:
   - Navigate to route, wait for network idle
   - **Console capture**: `console.error`, unhandled exceptions, missing i18n keys
   - **Network capture**: 4xx/5xx responses, failed requests
   - **DOM inspection**: (see Layout Checks below)
   - Screenshot on any error found
4. **RBAC negative testing**:
   - Navigate to routes this role should NOT access
   - Verify redirect to login or 403
   - Flag if unauthorized content is visible
5. Repeat at each configured breakpoint (375px, 768px)
   - Run all layout checks again at each width
   - Screenshot if issues found at specific breakpoint

### Layout Checks

| Check | Severity | Detection Method |
|-------|----------|-----------------|
| Horizontal overflow (sideways scroll) | Warning | `document.body.scrollWidth > viewport.width` |
| Overlapping interactive elements | Warning | Bounding box intersection of buttons/links |
| Content hidden behind other elements | Warning | `elementFromPoint` returns different element |
| Broken images | Error | `img.naturalWidth === 0 && img.complete` |
| Empty containers that should have content | Info | Configurable selector list (default: `[data-sentinel-content]`, `main`, `.card-body`); checked via `el.children.length === 0 && el.textContent.trim() === ''` |
| Text truncation cutting off meaning | Warning | `scrollWidth > clientWidth` on headings/buttons |
| Missing responsive nav collapse | Warning | Nav items overflowing at mobile breakpoint |
| Invisible buttons (0 size or off-screen) | Error | `offsetWidth === 0` or position outside viewport |

### Responsive Breakpoints

Default: 375px (mobile), 768px (tablet), 1280px (desktop)

**Configuration sources (priority order):**
1. Settings override (`settings.json` → `breakpoints`)
2. Tailwind config auto-detection (reads `tailwind.config.js` or CSS `@theme`)
3. Hardcoded defaults

### Screenshot Strategy

- Only captured when errors or warnings are found
- Saved to `sentinel-reports/screenshots/`
- Naming: `{role}-{route-slug}-{breakpoint}-{timestamp}.png`
- Referenced in markdown report with relative paths

---

## API Sweep Engine

No browser required. Pure HTTP requests via the API client.

### Layer 1: Endpoint Health

For each endpoint in manifest, for each role:

| Role vs Endpoint | Expected | Flagged If |
|-----------------|----------|-----------|
| Authorized role | 200/201 | 4xx, 5xx, timeout |
| Unauthorized role | 401/403 | 200 (RBAC violation) |
| Unauthenticated | 401/403 | 200 (auth bypass) |

Additional checks:
- Response is valid JSON (not HTML error page or stack trace)
- Response time < configurable timeout (default 5s)
- No sensitive data in error responses (no stack traces, no SQL)

### Layer 2: Business Logic (CRUD Flows)

For each crudFlow in manifest (filtered by risk policy):

```
1. POST /resource      → capture created ID, verify 201
2. GET /resource/{id}  → verify resource exists, matches created data
3. PATCH /resource/{id} → modify a field, verify 200
4. GET /resource/{id}  → verify update persisted
5. DELETE /resource/{id} → verify 200/204 (if risk allows)
6. GET /resource/{id}  → verify 404 or soft-delete behavior
```

Also tests:
- Invalid input returns 400/422 (not 500)
- Missing required fields return descriptive error
- Duplicate creation returns 409 (if applicable)

### Layer 3: Contract Testing (Schema Drift)

For each endpoint with `responseSchema` in manifest:

1. Parse the Pydantic model from source (field names, types, required/optional, nullable)
2. Send a real request to the endpoint
3. Compare actual response fields against schema:

| Finding | Severity |
|---------|----------|
| Missing required field | Error |
| Type mismatch (string where number expected) | Warning |
| Field present in response but not in schema | Info |
| Nullable field assumed non-null by frontend | Warning |
| Nested object structure mismatch | Error |

Schema source: the `schemas` section of the manifest, extracted from Pydantic models during manifest generation.

---

## Report & Output

Three output layers:

### 1. Terminal Summary (immediate)

Printed after sweep completes:

```
--- Sentinel Sweep Report ---

  Mode: browser + api | Roles: admin, manager, user
  Routes tested: 32 | Endpoints tested: 84
  Breakpoints: 375px, 768px, 1280px
  Duration: 2m 34s

  Critical:  2
  Error:     5
  Warning:  12
  Info:      8
  Passed:  189

  Top issues:
  1. [CRITICAL] RBAC: /admin/settings accessible as manager
  2. [ERROR] Console: "Cannot read property 'name' of undefined" on /groups/:id
  3. [ERROR] Schema drift: GET /users missing 'phone_verified' field
  4. [WARNING] Layout: horizontal overflow at 375px on /payments
  5. [WARNING] i18n: missing key 'events.ticketType' in he locale

  Full report: sentinel-reports/2026-03-15-sweep.md
```

### 2. Markdown Report (persistent)

Saved to `sentinel-reports/YYYY-MM-DD-sweep.md`. Sections:

1. **Summary table** — mode, routes/endpoints tested, breakpoints, duration, pass rate
2. **Critical Issues** — checklist format with severity, file:line, expected vs got, screenshot
3. **Errors** — same format
4. **Warnings** — same format
5. **Info** — logged observations
6. **Skipped Actions** — high/critical actions not executed, with risk score and description
7. **Sandbox Actions** — (if sandbox mode) what was executed and restore instructions
8. **RBAC Matrix** — table of every route x role with pass/fail status

Each finding is a checkbox (`- [ ]`) for tracking fixes.

### 3. Task List (actionable)

The markdown report includes a prioritized task list section with checkbox items grouped by severity:

| Finding Severity | Task Priority | Auto-listed |
|-----------------|---------------|-------------|
| Critical | 1 | Yes |
| Error | 2 | Yes |
| Warning | 3 | Yes |
| Info | — | No (logged in report only) |

Each task includes file:line reference and fix suggestion when possible. The task list is pure markdown (no tool dependencies) — compatible with any workflow.

---

## Plugin Structure

```
sentinel-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── sentinel.md
├── agents/
│   ├── manifest-generator.md
│   ├── api-sweeper.md
│   └── browser-sweeper.md
├── skills/
│   └── sentinel-setup/
│       └── SKILL.md
├── settings.json
├── README.md
└── LICENSE
```

### Settings Schema

```json
{
  "riskPolicy": {
    "maxRiskLevel": "medium",
    "alwaysSkip": ["DELETE /api/v1/users/{id}"],
    "alwaysAllow": ["POST /api/v1/groups/{id}/members"]
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
  }
}
```

### Commands

| Command | Description |
|---------|------------|
| `/sentinel setup` | Check environment, install Playwright, configure settings |
| `/sentinel sweep` | Full browser + API sweep |
| `/sentinel sweep --sandbox` | Include high/critical actions with per-action approval |
| `/sentinel api` | API-only sweep (fast, no browser) |
| `/sentinel report` | View last report or regenerate |
| `/sentinel manifest` | Generate/view manifest without sweeping |

### Setup Skill (`/sentinel setup`)

1. Check Playwright installation (`npx playwright --version`)
2. If missing: offer to install (`npx playwright install chromium`)
3. Detect framework (Vue/React + FastAPI/Express/Django)
4. Detect if app is running (ping base URL)
5. Check for existing settings, offer to configure
6. Report readiness status

---

## Framework Support

v1 targets **Vue 3 + FastAPI** (SmartSessions stack). The architecture supports other frameworks via the manifest-generator agent — each framework needs its own parsing logic:

| Framework | Router Source | Endpoint Source | Schema Source |
|-----------|-------------|-----------------|--------------|
| Vue 3 | `router/index.js` | — | — |
| React | `App.tsx` / react-router | — | — |
| FastAPI | — | `endpoints/*.py` decorators | Pydantic models |
| Express | — | `routes/*.js` | Zod / Joi schemas |
| Django | — | `urls.py` + `views.py` | Serializers |

The manifest-generator agent is framework-aware and selects the right parsing strategy based on detection.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Browser automation | Playwright MCP |
| API testing | HTTP requests via Bash (curl) or agent-internal |
| Schema parsing | Agent reads Python/JS source files |
| Report generation | Agent writes markdown |
| Task creation | Markdown checklist in report (tool-agnostic) |
| Configuration | JSON settings file |

---

## Success Criteria

A successful Sentinel sweep should:

1. Discover all routes and endpoints from the codebase without manual configuration
2. Correctly classify risk levels for every action
3. Never execute a destructive action without explicit approval in sandbox mode
4. Never execute any destructive action against a production environment
5. Catch the categories of bugs found during the SmartSessions development session:
   - User count cartesian product (schema drift / wrong API response)
   - Manager UUID display (missing data resolution)
   - Missing i18n keys
   - CORS configuration issues
   - Console errors visible in browser
6. Produce a clear, actionable report with file:line references
7. Complete an API-only sweep in under 2 minutes and a full browser+API sweep in under 8 minutes for a typical app (30 routes, 80 endpoints, 3 breakpoints)

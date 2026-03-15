# Sentinel Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that performs automated QA sweeps (browser + API) on web applications, catching console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys.

**Architecture:** Sentinel is a Claude Code plugin where every component is a markdown/JSON file — no traditional code. A slash command (`/sentinel`) routes to subcommands. Three agents handle manifest generation, API sweeps, and browser sweeps. A setup skill handles environment detection. All agents communicate via a shared `sentinel-manifest.json` file.

**Tech Stack:** Claude Code plugin system (markdown + YAML frontmatter), Playwright MCP (browser automation), curl (API testing), JSON (configuration)

**Spec:** `docs/2026-03-15-sentinel-design.md`

---

## File Structure

All files live under `/home/michel/projects/sentinel-sweep/`.

| File | Responsibility |
|------|---------------|
| `.claude-plugin/plugin.json` | Plugin metadata — name, description, author |
| `settings.json` | Default configuration — risk policy, breakpoints, timeouts, browser settings |
| `commands/sentinel.md` | Main slash command — parses subcommands (`sweep`, `api`, `report`, `manifest`, `setup`), routes to agents/skills |
| `agents/manifest-generator.md` | Reads codebase (router, endpoints, schemas, models, CLAUDE.md, .env), produces `sentinel-manifest.json` |
| `agents/api-sweeper.md` | API-only sweep — endpoint health, RBAC verification, CRUD flows, schema contract testing |
| `agents/browser-sweeper.md` | Browser sweep via Playwright MCP — console errors, layout checks, responsive testing, RBAC navigation |
| `skills/sentinel-setup/SKILL.md` | Environment detection — checks Playwright, detects framework, verifies app is running, configures settings |
| `README.md` | Plugin documentation — installation, usage, configuration |
| `LICENSE` | Apache-2.0 license |

---

## Chunk 1: Plugin Scaffold

### Task 1: Plugin Manifest and Settings

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `settings.json`
- Create: `LICENSE`

- [ ] **Step 1: Create plugin directory structure**

```bash
cd /home/michel/projects/sentinel-sweep
mkdir -p .claude-plugin commands agents skills/sentinel-setup
```

- [ ] **Step 2: Write plugin.json** (schema follows Claude Code plugin conventions — not defined in sentinel spec)

```json
{
  "name": "sentinel",
  "description": "Automated QA sweep plugin — catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys in web applications",
  "author": {
    "name": "Michel Abboud",
    "email": "michel@devport.cc"
  }
}
```

- [ ] **Step 3: Write settings.json with defaults from spec**

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
  "_note_emptyContainerSelectors": "Exposes the configurable selector list from spec Layout Checks section as a setting"
}
```

- [ ] **Step 4: Write LICENSE (Apache-2.0)**

```
Copyright 2026 Michel Abboud

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

- [ ] **Step 5: Commit scaffold**

```bash
git add .claude-plugin/plugin.json settings.json LICENSE
git commit -m "feat: plugin scaffold — manifest, default settings, license"
```

---

### Task 2: Sentinel Command (Main Entry Point)

**Files:**
- Create: `commands/sentinel.md`

This is the main `/sentinel` slash command. It parses the `$ARGUMENTS` variable to route to the correct subcommand and dispatches the appropriate agent or skill.

- [ ] **Step 1: Write the command file with frontmatter and full body**

Write the complete `commands/sentinel.md` file. The file must contain:

**Frontmatter:**

```yaml
---
description: Automated QA sweep — catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys
argument-hint: <sweep|api|report|manifest|setup> [--sandbox]
allowed-tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"]
---
```

**Body content (include ALL of the following in the markdown):**

**Section 1 — Argument Parsing:**
- Parse `$ARGUMENTS` into subcommand (first word) and flags (remaining words)
- Supported subcommands: `sweep`, `api`, `report`, `manifest`, `setup`
- Supported flags: `--sandbox`
- If no arguments or unrecognized subcommand, print usage:
  ```
  Sentinel — Automated QA Sweep

  Usage: /sentinel <command> [flags]

  Commands:
    setup       Check environment, install Playwright, configure settings
    sweep       Full browser + API sweep
    api         API-only sweep (fast, no browser)
    report      View the last sweep report
    manifest    Generate manifest without sweeping

  Flags:
    --sandbox   Enable high/critical actions with per-action approval (dev only)
  ```

**Section 2 — Settings Loading:**
- Read `$CLAUDE_PLUGIN_ROOT/settings.json` for configuration
- Merge with defaults if keys are missing

**Section 3 — Subcommand Routing:**

For `setup`:
- Invoke the `sentinel-setup` skill using the Skill tool

For `manifest`:
- Dispatch manifest-generator agent with prompt: "Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to sentinel-manifest.json in the project root."
- Print "Manifest generated: sentinel-manifest.json"

For `api`:
- Dispatch manifest-generator agent (same as above)
- Then dispatch api-sweeper agent with prompt including: path to manifest, settings (risk policy, timeout), and `--sandbox` flag if present
- Collect findings JSON from api-sweeper
- Generate report (see Section 4)

For `sweep`:
- Dispatch manifest-generator agent
- Check if Playwright MCP tools are available (try listing browser tools)
- If Playwright available: dispatch browser-sweeper agent with manifest path, settings, and sandbox flag
- If Playwright NOT available: print warning "⚠ Playwright MCP not available — falling back to API-only mode. Run /sentinel setup to install."
- Dispatch api-sweeper agent (always runs)
- Merge findings from both agents (deduplicate by endpoint+role+message)
- Generate report (see Section 4)

For `report`:
- Read `sentinel-reports/` directory, sort filenames alphabetically descending (ISO date prefix ensures correct ordering)
- Read and display the first (most recent) `.md` file
- If no reports found: print "No reports found. Run /sentinel sweep or /sentinel api first."

**Section 4 — Report Generation:**

After sweeps complete, generate two outputs:

**Terminal summary** (print to user immediately):
```
--- Sentinel Sweep Report ---

  Mode: {browser + api | api-only} | Roles: {comma-separated roles tested}
  Routes tested: {count} | Endpoints tested: {count}
  Breakpoints: {comma-separated breakpoints}px
  Duration: {elapsed time}

  Critical: {count}
  Error:    {count}
  Warning:  {count}
  Info:     {count}
  Passed:   {count}

  Top issues:
  1. [{SEVERITY}] {category}: {message}
  ...up to 5 top issues sorted by severity...

  Full report: {reportDir}/{date}-sweep.md
```

**Markdown report** (write to `{reportDir}/YYYY-MM-DD-sweep.md`):

Sections in order:
1. `## Summary` — table with mode, counts, breakpoints, duration, pass rate
2. `## Critical Issues` — `- [ ] **[CRITICAL]** {category}: {message}` with file:line, expected vs actual, screenshot path
3. `## Errors` — same checkbox format
4. `## Warnings` — same checkbox format
5. `## Info` — bullet list (no checkboxes)
6. `## Skipped Actions` — high/critical actions not executed, with risk score and description
7. `## Sandbox Actions` — (only if sandbox mode) what was executed, restore instructions
8. `## RBAC Matrix` — table: rows = routes/endpoints, columns = roles, cells = ✅/❌/⏭
9. `## Task List` — prioritized checkboxes grouped by severity (Critical → Error → Warning), each with file:line and fix suggestion

Create `sentinel-reports/` directory if it doesn't exist.

- [ ] **Step 2: Verify command is discoverable**

```bash
# Check file exists and has valid frontmatter
head -5 commands/sentinel.md
```

- [ ] **Step 3: Commit**

```bash
git add commands/sentinel.md
git commit -m "feat: /sentinel command — argument routing and report generation"
```

---

### Task 3: Setup Skill

**Files:**
- Create: `skills/sentinel-setup/SKILL.md`

- [ ] **Step 1: Write SKILL.md with frontmatter**

```yaml
---
name: sentinel-setup
description: Set up and configure Sentinel QA plugin. Use when user says "sentinel setup", "configure sentinel", "check sentinel dependencies", or when sentinel needs environment verification before sweeping.
---
```

- [ ] **Step 2: Write the skill body**

The SKILL.md body must contain ALL of the following instruction sections:

**Section 1 — Playwright Check:**
```
Run `npx playwright --version` via Bash.
- If it succeeds: note Playwright version, set playwright_available = true
- If it fails (command not found): ask the user "Playwright is not installed. Install it now? (npx playwright install chromium)"
  - If user agrees: run `npx playwright install chromium`
  - If user declines: set playwright_available = false, note browser mode will be unavailable
```

**Section 2 — Framework Detection:**
```
Use Glob to check for these files:
- `**/router/index.js` or `**/router/index.ts` → Vue 3
- `**/App.tsx` or `**/App.jsx` with react-router imports → React
- `**/endpoints/*.py` with `@router` decorators → FastAPI
- `**/routes/*.js` with `express.Router()` → Express
- `**/urls.py` with `urlpatterns` → Django
Also check package.json for `vue`, `react`, `@angular/core`, `svelte` dependencies.
Also check requirements.txt or pyproject.toml for `fastapi`, `django`, `flask`.
Report: "Frontend: {framework or 'not detected'} | Backend: {framework or 'not detected'}"
```

**Section 3 — App Status:**
```
Read .env and .env.example files (Glob for them). Extract:
- VITE_API_URL, API_URL, or similar → API base URL
- Frontend port from vite.config.js, package.json scripts, or docker-compose.yml
- Also check CLAUDE.md for a Ports table

Ping services via Bash:
- `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 {frontendUrl}` → expect 200
- `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 {apiUrl}/health` → expect 200
Report: "Frontend ({url}): {reachable/unreachable} | API ({url}): {reachable/unreachable}"
```

**Section 4 — Settings Check:**
```
Read $CLAUDE_PLUGIN_ROOT/settings.json. Show current config:
- Risk policy: maxRiskLevel={value}
- Breakpoints: {list}
- Response timeout: {value}ms
- Screenshot on error: {value}
- Report directory: {value}

If Tailwind detected and breakpoints are defaults: check tailwind.config.js or grep CSS for
`@theme { --breakpoint-` to extract custom breakpoints. Offer to update settings.

Ask user: "Would you like to adjust any settings? (risk policy, breakpoints, timeouts)"
```

**Section 5 — Readiness Report:**
Print this formatted block:
```
--- Sentinel Readiness ---

  Framework:    {frontend} + {backend}
  Frontend:     {url} — {✅ reachable | ❌ unreachable}
  API:          {url} — {✅ reachable | ❌ unreachable}
  Playwright:   {✅ installed (v{version}) | ❌ not installed}
  Settings:     {✅ configured | ⚠ using defaults}

  Available modes:
    /sentinel sweep   — {✅ browser + API | ⚠ API only (no Playwright)}
    /sentinel api     — ✅ ready
```

- [ ] **Step 3: Commit**

```bash
git add skills/sentinel-setup/SKILL.md
git commit -m "feat: sentinel-setup skill — environment detection and configuration"
```

---

## Chunk 2: Manifest Generator Agent

### Task 4: Manifest Generator Agent

**Files:**
- Create: `agents/manifest-generator.md`

This is the largest and most complex component. It reads the target app's codebase and produces `sentinel-manifest.json`.

- [ ] **Step 1: Write agent frontmatter**

```yaml
---
name: manifest-generator
description: Use this agent to generate a sentinel-manifest.json by analyzing the target application's codebase. Reads router files, API endpoints, Pydantic schemas, database models, CLAUDE.md, and environment files. <example>Context: User runs /sentinel sweep\nassistant: "Dispatching manifest-generator to analyze the codebase"\n<commentary>The sweep command triggers manifest generation before any sweep.</commentary></example><example>Context: User runs /sentinel manifest\nassistant: "Generating sentinel manifest from codebase analysis"\n<commentary>Direct manifest generation for inspection.</commentary></example>
model: opus
tools: ["Read", "Glob", "Grep", "Bash", "Write"]
---
```

- [ ] **Step 2: Write the manifest generation instructions — Framework Detection section**

This section tells the agent how to detect what framework the target app uses:

- Glob for `router/index.js`, `src/router/index.js`, `src/App.tsx`, `app/api/`, `routes/`, `urls.py`
- Read `package.json` for Vue/React/Svelte/Angular dependencies
- Read `requirements.txt` or `pyproject.toml` for FastAPI/Django/Flask
- Set `app.framework.frontend` and `app.framework.backend`


- [ ] **Step 3: Write the manifest generation instructions — App Configuration section**

Tells the agent how to extract:
- `app.name` from package.json, pyproject.toml, or directory name
- `app.baseUrl` from .env, .env.example, docker-compose.yml, or CLAUDE.md port table
- `app.apiBaseUrl` from same sources
- `auth.method` from code inspection (JWT imports, session middleware)
- `auth.loginEndpoint` from auth router/endpoint files
- `auth.roles` from CLAUDE.md seed credentials section
- `auth.roleHierarchy` from role enum or CLAUDE.md RBAC description


- [ ] **Step 4: Write the manifest generation instructions — Route Extraction section (Vue 3 focus)**

Tells the agent how to parse Vue 3 router:
- Read `router/index.js`
- For each route object: extract `path`, `name`, `component` (view name from lazy import), `meta.role` (requiredRole), `meta.requiresAuth`
- Handle nested routes (children array)
- Handle dynamic segments (`:id` → `{id}`)
- For parameterized routes: generate `params` object with `lookup:` syntax based on the resource name (e.g., `/groups/:id` → `lookup:groups[0].id`)
- Set initial `riskLevel` to "safe" for all routes (risk scoring comes later)


- [ ] **Step 5: Write the manifest generation instructions — Endpoint Extraction section (FastAPI focus)**

Tells the agent how to parse FastAPI endpoints:
- Glob for `endpoints/*.py` or `api/v1/endpoints/*.py`
- For each file: read and extract decorated functions (`@router.get`, `@router.post`, etc.)
- Extract: HTTP method, path (with prefix from router), dependencies (auth decorators like `Depends(require_admin)`)
- Map auth dependencies to `requiredRole`
- Extract `response_model` for `responseSchema` reference
- Detect `?confirm=true` patterns: look for `confirm: bool = Query(False)` or `confirm: bool = Query(...)` in endpoint function signatures. If found, set `requiresConfirm: true`
- For parameterized endpoints: generate `params` object with lookup syntax. Example: for `GET /groups/{id}/members/{mid}`, generate `{ "id": "lookup:groups[0].id", "mid": "lookup:groups[0].members[0].id" }`
- Derive `sideEffects` for high/critical endpoints: read SQLAlchemy model relationships (`relationship(...)` with `cascade=`). For DELETE endpoints, list affected models. Example: `["Removes member record", "Cascades to attendance_records"]`. If no cascade info found, use the endpoint description.

- [ ] **Step 6: Write the manifest generation instructions — Schema Extraction section**

Tells the agent how to parse Pydantic models:
- Glob for `schemas/*.py`
- For each schema class: extract class name, field names, field types, Optional/required, nullable
- Map Python types to JSON types (str→string, int→number, bool→boolean, list→array, dict→object)
- Handle `Optional[X]` as nullable
- Handle `extra="allow"` models (note in schema)
- Record source file:line for each schema
- Note in agent instructions: skip models with deep inheritance chains or `computed_field` — flag them for manual override


- [ ] **Step 7: Write the manifest generation instructions — Risk Scoring section**

Tells the agent how to calculate risk scores:
- Base scores: GET=0, POST=25, PUT/PATCH=30, DELETE=60
- Modifiers: `require_admin` +10, "delete" keyword +15, "purge"/"reset" +20, "bulk" +15, `?confirm=true` +15, cascade relationships +10, hard-delete +15
- Final score: `min(100, base + sum(modifiers))`
- Classification: 0-25=safe, 26-50=medium, 51-75=high, 76-100=critical
- For high/critical: require `description` and `sideEffects` fields
- Read model relationships for cascade detection (cascade="all, delete-orphan" in SQLAlchemy)


- [ ] **Step 8: Write the manifest generation instructions — CRUD Flow Detection section**

Tells the agent how to auto-detect CRUD flows:
- Group endpoints by resource path pattern (strip `{id}` suffix)
- For each group with POST + GET/{id}: create a crudFlow entry
- Name: `{resource}-lifecycle` (e.g., "members-lifecycle")
- Steps: ordered list of `METHOD /path` strings
- Risk level: max risk level of any step in the flow
- Partial flows are valid (not all CRUD verbs needed)


- [ ] **Step 9: Write the manifest generation instructions — Merge Strategy and Output section**

Tells the agent how to handle existing manifests:
- If `sentinel-manifest.json` exists: read it first
- Preserve any entries with `"manual": true`
- Overwrite all auto-generated entries
- Add `generatedAt` timestamp (ISO 8601)
- Write final JSON to `sentinel-manifest.json` in the current working directory (the target project root — the sentinel command dispatches the agent from the user's project directory)
- Include `generatedAt` field with ISO 8601 timestamp (e.g. `"2026-03-15T10:30:00Z"`)
- Include `breakpoints` field from settings or defaults `[375, 768, 1280]`
- Include `riskPolicy` from settings.json (settings override manifest defaults)
- Preserve `schemaOverride` entries from existing manifest (alongside `"manual": true` entries)
- Pretty-print with 2-space indentation

- [ ] **Step 10: Commit manifest-generator agent**

```bash
git add agents/manifest-generator.md
git commit -m "feat: manifest-generator agent — codebase analysis and manifest production"
```

---

## Chunk 3: API Sweeper Agent

### Task 5: API Sweeper Agent

**Files:**
- Create: `agents/api-sweeper.md`

- [ ] **Step 1: Write agent frontmatter**

```yaml
---
name: api-sweeper
description: Use this agent to perform API-only QA sweeps. Tests endpoint health, RBAC enforcement, CRUD flow correctness, and response schema compliance. Reads sentinel-manifest.json for configuration. <example>Context: User runs /sentinel api\nassistant: "Dispatching api-sweeper for endpoint testing"\n<commentary>API sweep triggered directly.</commentary></example>
model: sonnet
tools: ["Read", "Bash", "Write", "Glob", "Grep"]
---
```

- [ ] **Step 2: Write the API sweep instructions — Authentication section**

Tells the agent how to authenticate:
- Read `sentinel-manifest.json` for auth config
- For each role in `auth.roles`: POST to `auth.loginEndpoint` with credentials
- Extract JWT token from response
- Store tokens for use in subsequent requests
- If login fails for a role: record Critical finding, skip that role's tests
- For unauthenticated tests: no token


- [ ] **Step 3: Write the API sweep instructions — Parameter Resolution section**

Tells the agent how to resolve parameters before requests:
- For `lookup:` params: make GET request to the list endpoint, extract the referenced field
- For `static:` params: use the value directly
- For `env:` params: read from environment
- Handle failures: skip route if lookup returns empty, use static fallback if available, log Info finding
- Cache resolved values (don't re-fetch for every endpoint)


- [ ] **Step 4: Write the API sweep instructions — Layer 1: Endpoint Health section**

Tells the agent how to test each endpoint. Use curl patterns from **Appendix A3**. Use risk policy matching from **Appendix A4**. Use sandbox prompts from **Appendix A5**.

- For each endpoint in manifest, for each role (including unauthenticated):
  - Apply risk policy matching (Appendix A4): skip, allow, or prompt
  - Make HTTP request using curl patterns from Appendix A3 with appropriate auth header
  - Check: authorized role should get 200/201; unauthorized role should get 401/403; unauthenticated should get 401/403
  - Check: response is valid JSON (not HTML) — `echo "$body" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null`
  - Check: response time < `responseTimeout` (from `-w "%{time_total}"` output, multiply by 1000 for ms comparison)
  - Check: error responses don't contain stack traces (`Traceback`, `at Object.`, `at Module.`) or SQL (`SELECT`, `INSERT`, `FROM`)
  - Record findings using schema from **Appendix A1**

- [ ] **Step 5: Write the API sweep instructions — Layer 2: CRUD Flows section**

Tells the agent how to execute CRUD flows. Use curl patterns from **Appendix A3**.

- For each `crudFlow` in manifest (filtered by risk policy per Appendix A4):
  - **Payload generation**: derive minimal valid payload from `manifest.schemas` — use required fields only. Use test values: strings like `"Sentinel Test {timestamp}"`, numbers like `1`, booleans like `true`. The payload will be cleaned up (via DELETE or left for manual cleanup).
  - POST: create resource with minimal valid payload, capture `id` from JSON response
  - GET by ID: verify 200, verify at least the fields sent in POST are present
  - PATCH: modify one string field (e.g. append " Updated"), verify 200
  - GET by ID: verify the patched field persisted
  - DELETE: if risk policy allows, verify 200/204
  - GET by ID after DELETE: verify 404 or soft-delete response (200 with `deleted_at` set)
  - **Invalid input test**: POST with empty body → expect 400/422 (not 500)
  - **Duplicate test**: if POST succeeded, try same POST again → expect 409 if resource has unique constraints (check if schema has unique-looking fields like `email`, `name`). If no unique constraint detected, skip this test.
- Record findings per step using schema from **Appendix A1**

- [ ] **Step 6: Write the API sweep instructions — Layer 3: Schema Contract Testing section**

Tells the agent how to validate response schemas:
- For each endpoint with `responseSchema` in manifest:
  - Look up the schema in `manifest.schemas`
  - Make a real request to the endpoint (as authorized role)
  - Compare response JSON fields against schema:
    - Missing required field → Error
    - Type mismatch → Warning
    - Extra field in response → Info
    - Nullable field with null value → note
    - Nested object mismatch → Error
  - Record findings with field name, expected type, actual type


- [ ] **Step 7: Write the API sweep instructions — Output Format section**

Write findings using the canonical schema from **Appendix A1**. Write to the path defined in **Appendix A2** (`sentinel-reports/.api-findings.json`).

- Create `sentinel-reports/` directory if it doesn't exist
- Write the complete findings JSON (metadata + findings array) to `sentinel-reports/.api-findings.json`
- Set `metadata.mode` to `"api"`
- Set `breakpoint` and `screenshot` to `null` for all API findings
- Print a brief summary to the user: "{N} findings ({critical} critical, {error} errors, {warning} warnings)"

- [ ] **Step 8: Commit api-sweeper agent**

```bash
git add agents/api-sweeper.md
git commit -m "feat: api-sweeper agent — endpoint health, RBAC, CRUD flows, schema testing"
```

---

## Chunk 4: Browser Sweeper Agent

### Task 6: Browser Sweeper Agent

**Files:**
- Create: `agents/browser-sweeper.md`

- [ ] **Step 1: Write agent frontmatter**

```yaml
---
name: browser-sweeper
description: Use this agent to perform browser-based QA sweeps using Playwright MCP. Navigates routes as each role, captures console errors, network failures, layout issues, and responsive problems. Reads sentinel-manifest.json for configuration. <example>Context: User runs /sentinel sweep\nassistant: "Dispatching browser-sweeper for visual QA"\n<commentary>Full sweep triggers browser testing.</commentary></example>
model: sonnet
tools: ["Read", "Write", "Bash", "Glob", "Grep", "mcp__plugin_playwright_playwright__browser_navigate", "mcp__plugin_playwright_playwright__browser_navigate_back", "mcp__plugin_playwright_playwright__browser_snapshot", "mcp__plugin_playwright_playwright__browser_take_screenshot", "mcp__plugin_playwright_playwright__browser_console_messages", "mcp__plugin_playwright_playwright__browser_network_requests", "mcp__plugin_playwright_playwright__browser_evaluate", "mcp__plugin_playwright_playwright__browser_resize", "mcp__plugin_playwright_playwright__browser_click", "mcp__plugin_playwright_playwright__browser_fill_form", "mcp__plugin_playwright_playwright__browser_wait_for", "mcp__plugin_playwright_playwright__browser_close"]
---
```

- [ ] **Step 2: Write the browser sweep instructions — Login Flow section**

Use the login form selector strategy from **Appendix A7**.

- Read `sentinel-manifest.json` for `auth.roles`, `auth.loginEndpoint`, and `auth.roleHierarchy`
- For each role (in hierarchy order from manifest):
  - Follow the login flow from Appendix A7: navigate → fill form → submit → verify
  - If login fails: record Critical finding using schema from Appendix A1 (category="health", message="Login failed for role {role}"), skip all routes for this role
- For unauthenticated: skip login, navigate to routes directly

- [ ] **Step 3: Write the browser sweep instructions — Route Navigation and Console Capture section**

- For each role, for each route accessible to this role:
  - Resolve parameters (same lookup syntax as API sweeper — `lookup:`, `static:`, `env:`)
  - Navigate using `browser_navigate` to `{baseUrl}{resolvedPath}`
  - Wait using `browser_wait_for` with `{ "state": "networkidle" }` (Playwright's network idle state — no requests for 500ms)
  - Capture console messages via `browser_console_messages`:
    - Any message with level `error` → finding with severity=error, category=console
    - Messages matching `/\[intlify\]/i` or `"Not found"` pattern → severity=warning, category=i18n, message="Missing i18n key: {extracted key}"
    - Unhandled promise rejection → severity=error, category=console
  - Capture network requests via `browser_network_requests`:
    - Any response with status 4xx/5xx → severity=warning (for 4xx) or error (for 5xx), category=network
    - Failed requests (no response) → severity=error, category=network
  - Record all findings using schema from **Appendix A1**, with `route` field set to the current route path

- [ ] **Step 4: Write the browser sweep instructions — Layout Checks section**

Include ALL 8 layout check JavaScript snippets from **Appendix A6** in the agent instructions. Each check is run via `browser_evaluate` at every breakpoint.

For each check result:
- If the check returns a non-empty/truthy result → create a finding using Appendix A1 schema
- Severity mappings: Horizontal overflow=warning, Overlapping elements=warning, Hidden content=warning, Broken images=error, Empty containers=info, Text truncation=warning, Nav collapse=warning, Invisible buttons=error
- Category for all layout checks: `"layout"`
- Set `breakpoint` field to the current viewport width

- [ ] **Step 5: Write the browser sweep instructions — RBAC Negative Testing section**

Use the RBAC detection strategy from **Appendix A8**.

- Using `auth.roleHierarchy` from manifest: for each role, compute which routes should be inaccessible based on `requiredRole` ordering
  - Example: if roleHierarchy is `["admin","manager","user"]` and a route requires "admin", then "manager", "user", and unauthenticated should NOT access it
- Navigate to each inaccessible route
- Apply the 4-step detection from Appendix A8 (URL redirect → HTTP status → content check → positive content check)
- Flag as Critical (category="rbac") if positive content is visible to an unauthorized role
- For unauthenticated: all routes with `requiredRole` set should redirect or return 401/403

- [ ] **Step 6: Write the browser sweep instructions — Responsive Testing section**

- Read breakpoints from `manifest.breakpoints` (defaults: `[375, 768, 1280]`)
- For each breakpoint:
  - Resize browser via `browser_resize` to `{ "width": {breakpoint}, "height": 900 }`
  - For each route (same set as Step 3): navigate and run all 8 layout checks from Appendix A6
  - If any check returns findings: take screenshot via `browser_take_screenshot`
  - Screenshot naming: `{role}-{route-slug}-{breakpoint}-{YYYYMMDD}.png` (slug = route path with `/` replaced by `-`)
  - Save to `{reportDir}/screenshots/` (read `reportDir` from settings, default `sentinel-reports`)
  - Create screenshots directory if it doesn't exist

- [ ] **Step 7: Write the browser sweep instructions — Output section**

Write findings using the canonical schema from **Appendix A1**. Write to the path defined in **Appendix A2** (`sentinel-reports/.browser-findings.json`).

- Create `sentinel-reports/` directory if it doesn't exist
- Write the complete findings JSON (metadata + findings array) to `sentinel-reports/.browser-findings.json`
- Set `metadata.mode` to `"browser"`
- Set `metadata.routesTested` to the count of routes navigated
- For each finding: set `breakpoint` to viewport width (or `null` for desktop-only findings) and `screenshot` to relative path (or `null` if no screenshot)
- Close the browser via `browser_close`
- Print a brief summary: "{N} findings across {routesTested} routes at {breakpoints} breakpoints"

- [ ] **Step 8: Commit browser-sweeper agent**

```bash
git add agents/browser-sweeper.md
git commit -m "feat: browser-sweeper agent — Playwright-based visual QA with layout checks"
```

---

## Chunk 5: README and Integration Test

### Task 7: README Documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README with installation, usage, and configuration sections**

Sections:
1. **Header** — name, one-line description, badges placeholder
2. **Installation** — `claude plugin add /path/to/sentinel-sweep` (local install)
3. **Quick Start** — `/sentinel setup` → `/sentinel api` → `/sentinel sweep`
4. **Commands** — table from spec (setup, sweep, api, report, manifest)
5. **Configuration** — settings.json fields with descriptions and defaults
6. **Manifest** — brief explanation of sentinel-manifest.json, how to inspect and override
7. **Risk Levels** — classification table from spec
8. **Sandbox Mode** — how to use `--sandbox`, safety checks
9. **Report Format** — what the output looks like (terminal + markdown)
10. **Framework Support** — v1 targets Vue 3 + FastAPI, architecture supports others
11. **Known Limitations** — from spec (JWT only, i18n coverage, schema parsing)
12. **License** — Apache-2.0


- [ ] **Step 2: Commit README**

```bash
git add README.md
git commit -m "docs: README — installation, usage, configuration, and reference"
```

---

### Task 8: Integration Validation Against Target Project

**Files:**
- No files created — this is a manual validation task

- [ ] **Step 1: Install the plugin locally**

```bash
# From the target project directory
claude plugin add /home/michel/projects/sentinel-sweep
```

Or symlink: check Claude Code docs for local plugin development workflow.

- [ ] **Step 2: Run `/sentinel setup`**

Verify:
- Detects Vue 3 frontend + FastAPI backend
- Finds correct ports (5193, 8020)
- Reports Playwright status
- Shows settings summary

- [ ] **Step 3: Run `/sentinel manifest`**

Verify the generated `sentinel-manifest.json`:
- Has all expected routes from the project router
- Has all 80+ endpoints from FastAPI
- Has correct role hierarchy: admin, manager, user
- Has seed credentials from CLAUDE.md
- Risk scores look reasonable (GET routes = safe, DELETE endpoints = high/critical)
- CRUD flows detected for major resources (groups, members, sessions, payments, events)
- Schemas extracted from Pydantic models

- [ ] **Step 4: Run `/sentinel api`**

Verify:
- Authenticates as each role successfully
- Tests all safe/medium endpoints
- Skips high/critical by default
- Reports RBAC violations (if any)
- Reports schema drift (if any)
- Generates terminal summary + markdown report

- [ ] **Step 5: Run `/sentinel sweep`**

Verify:
- Browser launches and navigates
- Console errors captured
- Layout checks run at 3 breakpoints
- Screenshots saved for issues
- RBAC negative testing works
- Combined report includes both API and browser findings

- [ ] **Step 6: Fix any issues found during validation**

Iterate on agent prompts based on real-world behavior. Common issues:
- Agent not finding files (fix glob patterns in agent instructions)
- Auth flow not working (fix login form field selectors)
- Risk scoring too aggressive or too lenient (tune thresholds)
- Report format doesn't match spec (fix command template)

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "fix: integration refinements from validation"
```

---

## Appendix A: Shared Definitions

These definitions are referenced by multiple tasks. Include them verbatim in the relevant agent files.

### A1: Canonical Findings JSON Schema

Both api-sweeper and browser-sweeper MUST produce findings in this exact format. The sentinel command merges and deduplicates by `endpoint + role + message`.

```json
{
  "metadata": {
    "mode": "api | browser",
    "rolesTests": ["admin", "manager", "user", "unauthenticated"],
    "endpointsTested": 84,
    "routesTested": 0,
    "startedAt": "2026-03-15T10:00:00Z",
    "finishedAt": "2026-03-15T10:01:30Z"
  },
  "findings": [
    {
      "severity": "critical | error | warning | info",
      "category": "health | rbac | crud | schema | security | console | layout | i18n | network",
      "endpoint": "GET /api/v1/users",
      "route": "/admin/users",
      "role": "manager",
      "message": "RBAC violation: /admin/settings accessible as manager",
      "expected": "401 or 403",
      "actual": "200",
      "fileRef": "api/v1/endpoints/global_settings.py:45",
      "fixSuggestion": "Add require_admin dependency to the settings endpoint",
      "breakpoint": null,
      "screenshot": null
    }
  ]
}
```

Browser-sweeper findings include `breakpoint` (viewport width, e.g. `375`) and `screenshot` (relative path, e.g. `sentinel-reports/screenshots/manager-payments-375-20260315.png`). API-sweeper sets both to `null`.

### A2: Findings File Paths

Agents write findings to deterministic paths in the project root. The sentinel command reads these after each agent completes.

| Agent | Output file |
|-------|------------|
| api-sweeper | `sentinel-reports/.api-findings.json` |
| browser-sweeper | `sentinel-reports/.browser-findings.json` |

The sentinel command:
1. Creates `sentinel-reports/` if it doesn't exist
2. Reads `.api-findings.json` and/or `.browser-findings.json`
3. Merges findings arrays, deduplicates by `endpoint + role + message`
4. Generates the final report

### A3: Curl Command Patterns

The api-sweeper uses these curl patterns (via Bash tool). All patterns include timeout handling.

**Login (get JWT token):**
```bash
curl -s -X POST {apiBaseUrl}{loginEndpoint} \
  -H "Content-Type: application/json" \
  -d '{"email": "{email}", "password": "{password}"}' \
  --max-time {responseTimeout/1000}
```
Extract token: parse JSON response for `access_token` field.

**GET request (authenticated):**
```bash
curl -s -w "\n%{http_code}\n%{time_total}" \
  -H "Authorization: Bearer {token}" \
  -H "Accept: application/json" \
  {apiBaseUrl}{path} \
  --max-time {responseTimeout/1000}
```
Parse: last line = response time (seconds), second-to-last = HTTP status code, rest = body.

**POST request (authenticated):**
```bash
curl -s -w "\n%{http_code}\n%{time_total}" \
  -X POST \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{payload}' \
  {apiBaseUrl}{path} \
  --max-time {responseTimeout/1000}
```

**Unauthenticated request (no token):**
```bash
curl -s -w "\n%{http_code}" \
  -H "Accept: application/json" \
  {apiBaseUrl}{path} \
  --max-time {responseTimeout/1000}
```

**Timeout handling:** If curl exits with code 28, record a finding: severity=error, category=health, message="Request timed out after {timeout}ms".

### A4: Risk Policy Matching Logic

Both sweeper agents apply risk policy before executing each action:

```
For each endpoint/route:
  entry_key = "{method} {path}" for endpoints, or "{path}" for routes

  1. If entry_key is in riskPolicy.alwaysSkip → SKIP (log as "Skipped")
  2. If entry_key is in riskPolicy.alwaysAllow → EXECUTE regardless of risk level
  3. If riskLevel > riskPolicy.maxRiskLevel:
     a. If --sandbox flag AND pre-flight checks pass → prompt for confirmation
     b. Else → SKIP (log in "Skipped Actions" report section)
  4. Else → EXECUTE

  Matching: exact string comparison of entry_key against list entries.
```

Risk policy is already resolved in the manifest (manifest-generator applies settings.json overrides). Sweepers read `manifest.riskPolicy` directly — no additional override logic needed.

### A5: Sandbox Mode Confirmation Prompts

When `--sandbox` is active and a high/critical action is reached, display this exact format:

**For HIGH risk (51-75):**
```
WARNING — HIGH RISK action detected:

  Route: {method} {path}
  Description: {description}
  Risk Score: {riskScore}/100
  Risk Factors: {comma-separated factors}
  Side Effects: {sideEffects joined with ", "}

  Execute this action? [y/n]
```

**For CRITICAL risk (76-100):**
```
CRITICAL action detected:

  Route: {method} {path}
  Description: {description}
  Risk Score: {riskScore}/100
  Risk Factors: {comma-separated factors}
  Side Effects:
    - {sideEffect1}
    - {sideEffect2}
    ...

  Execute this action? [y/n]
```

### A6: All Layout Check JavaScript Snippets

The browser-sweeper evaluates these via `browser_evaluate` at each breakpoint. All 8 checks from the spec:

**1. Horizontal overflow (Warning):**
```javascript
document.body.scrollWidth > window.innerWidth
```

**2. Overlapping interactive elements (Warning):**
```javascript
(() => {
  const els = [...document.querySelectorAll('button, a, [role=button], input, select, textarea')];
  const rects = els.map(el => ({ el, r: el.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.width > 0 && b.width > 0 &&
          !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)) {
        overlaps.push([rects[i].el.textContent.trim().slice(0,30), rects[j].el.textContent.trim().slice(0,30)]);
      }
    }
  }
  return overlaps;
})()
```

**3. Content hidden behind other elements (Warning):**
```javascript
(() => {
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const hidden = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      hidden.push({ text: el.textContent.trim().slice(0,30), coveredBy: top.tagName });
    }
  }
  return hidden;
})()
```

**4. Broken images (Error):**
```javascript
[...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src)
```

**5. Empty containers (Info):**
```javascript
// Selectors from settings.emptyContainerSelectors
((selectors) => {
  return selectors.flatMap(s =>
    [...document.querySelectorAll(s)]
      .filter(el => el.children.length === 0 && el.textContent.trim() === '')
      .map(el => ({ selector: s, id: el.id || el.className }))
  );
})(['{selectors_from_settings}'])
```

**6. Text truncation (Warning):**
```javascript
[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,a,.truncate')]
  .filter(el => el.scrollWidth > el.clientWidth)
  .map(el => ({ text: el.textContent.trim().slice(0,50), tag: el.tagName }))
```

**7. Missing responsive nav collapse (Warning):**
```javascript
(() => {
  const nav = document.querySelector('nav');
  if (!nav) return null;
  const navRect = nav.getBoundingClientRect();
  const items = [...nav.querySelectorAll('a, button')];
  const overflowing = items.filter(el => {
    const r = el.getBoundingClientRect();
    return r.right > navRect.right || r.left < navRect.left;
  });
  return overflowing.length > 0 ? overflowing.map(el => el.textContent.trim()) : null;
})()
```

**8. Invisible buttons (Error):**
```javascript
[...document.querySelectorAll('button, a, [role=button]')]
  .filter(el => {
    const r = el.getBoundingClientRect();
    return el.offsetWidth === 0 || el.offsetHeight === 0 ||
           r.right < 0 || r.bottom < 0 ||
           r.left > window.innerWidth || r.top > window.innerHeight;
  })
  .map(el => el.textContent.trim())
```

### A7: Login Form Selector Strategy

The browser-sweeper uses this fallback chain for login:

1. Navigate to the app's login route (typically `/login` or `/auth/login` — read from manifest routes where `path` contains "login")
2. Fill form using `browser_fill_form` tool with field mapping:
   - Email: try selectors in order: `input[name=email]`, `input[type=email]`, `input[id*=email]`
   - Password: try `input[name=password]`, `input[type=password]`, `input[id*=password]`
3. Submit: try `button[type=submit]`, then `form button`, then `button:has-text("Login")` or `button:has-text("Sign in")`
4. Wait for navigation (URL change or network idle)
5. Verify success: check if URL changed away from login page, OR check `browser_evaluate` for `localStorage.getItem('token')` or `localStorage.getItem('access_token')`
6. If still on login page after 5 seconds: record Critical finding "Login failed for role {role}"

### A8: RBAC Negative Testing Detection

After navigating to a restricted route as an unauthorized role, the agent determines unauthorized access by:

1. **URL redirect check**: If the URL changed to a login page or different route → access correctly denied (PASS)
2. **HTTP status in network requests**: If the page's API calls returned 401/403 → access correctly denied (PASS)
3. **Content check via `browser_snapshot`**: Take a snapshot. If the page shows login form, "Access Denied", "Forbidden", or is mostly empty → PASS
4. **Positive content check**: If the snapshot shows data tables, forms, or substantive content that matches what an authorized role would see → FAIL (Critical RBAC violation)

The key heuristic: if `browser_snapshot` shows interactive content (tables, forms, buttons with data) when it shouldn't, that's a Critical RBAC violation.

---

## Execution Notes

### Task Dependencies

```
Task 1 (scaffold) → Task 2 (command) → Task 3 (setup skill)
                  → Task 4 (manifest agent) → Task 5 (api sweeper)
                                             → Task 6 (browser sweeper)
                                             → Task 7 (README)
                                             → Task 8 (integration test)
```

Tasks 5 and 6 can be done in parallel after Task 4, since they both depend on the manifest format but not on each other.

### Key Constraint

This is a **prompt engineering** project. Every file is markdown that instructs an AI agent. Quality depends on:
- **Precision**: exact file paths, exact tool names, exact JSON formats
- **Completeness**: the agent won't infer missing steps — spell everything out
- **Concrete examples**: show exact curl commands, exact JavaScript snippets, exact JSON output
- **Error handling**: tell the agent what to do when things go wrong (login fails, file not found, endpoint returns unexpected status)

### Testing Strategy

There are no unit tests. Validation is:
1. Plugin structure validation (plugin.json is valid, files are in right places)
2. Manual testing against target project (Task 8)
3. Iterating on agent prompts based on real behavior

# Sentinel Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that performs automated QA sweeps (browser + API) on web applications, catching console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys.

**Architecture:** Sentinel is a Claude Code plugin where every component is a markdown/JSON file — no traditional code. A slash command (`/sentinel`) routes to subcommands. Three agents handle manifest generation, API sweeps, and browser sweeps. A setup skill handles environment detection. All agents communicate via a shared `sentinel-manifest.json` file.

**Tech Stack:** Claude Code plugin system (markdown + YAML frontmatter), Playwright MCP (browser automation), curl (API testing), JSON (configuration)

**Spec:** `docs/2026-03-15-sentinel-design.md`

---

## File Structure

All files live under `/home/michel/projects/sentinel-plugin/`.

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
cd /home/michel/projects/sentinel-plugin
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

~30-40 lines.

- [ ] **Step 3: Write the manifest generation instructions — App Configuration section**

Tells the agent how to extract:
- `app.name` from package.json, pyproject.toml, or directory name
- `app.baseUrl` from .env, .env.example, docker-compose.yml, or CLAUDE.md port table
- `app.apiBaseUrl` from same sources
- `auth.method` from code inspection (JWT imports, session middleware)
- `auth.loginEndpoint` from auth router/endpoint files
- `auth.roles` from CLAUDE.md seed credentials section
- `auth.roleHierarchy` from role enum or CLAUDE.md RBAC description

~40-50 lines.

- [ ] **Step 4: Write the manifest generation instructions — Route Extraction section (Vue 3 focus)**

Tells the agent how to parse Vue 3 router:
- Read `router/index.js`
- For each route object: extract `path`, `name`, `component` (view name from lazy import), `meta.role` (requiredRole), `meta.requiresAuth`
- Handle nested routes (children array)
- Handle dynamic segments (`:id` → `{id}`)
- For parameterized routes: generate `params` object with `lookup:` syntax based on the resource name (e.g., `/groups/:id` → `lookup:groups[0].id`)
- Set initial `riskLevel` to "safe" for all routes (risk scoring comes later)

~40-50 lines.

- [ ] **Step 5: Write the manifest generation instructions — Endpoint Extraction section (FastAPI focus)**

Tells the agent how to parse FastAPI endpoints:
- Glob for `endpoints/*.py` or `api/v1/endpoints/*.py`
- For each file: read and extract decorated functions (`@router.get`, `@router.post`, etc.)
- Extract: HTTP method, path (with prefix from router), dependencies (auth decorators like `Depends(require_admin)`)
- Map auth dependencies to `requiredRole`
- Extract `response_model` for `responseSchema` reference
- Detect `?confirm=true` patterns in endpoint code
- For parameterized endpoints: generate `params` with lookup syntax

~50-60 lines.

- [ ] **Step 6: Write the manifest generation instructions — Schema Extraction section**

Tells the agent how to parse Pydantic models:
- Glob for `schemas/*.py`
- For each schema class: extract class name, field names, field types, Optional/required, nullable
- Map Python types to JSON types (str→string, int→number, bool→boolean, list→array, dict→object)
- Handle `Optional[X]` as nullable
- Handle `extra="allow"` models (note in schema)
- Record source file:line for each schema
- Note in agent instructions: skip models with deep inheritance chains or `computed_field` — flag them for manual override

~40-50 lines.

- [ ] **Step 7: Write the manifest generation instructions — Risk Scoring section**

Tells the agent how to calculate risk scores:
- Base scores: GET=0, POST=25, PUT/PATCH=30, DELETE=60
- Modifiers: `require_admin` +10, "delete" keyword +15, "purge"/"reset" +20, "bulk" +15, `?confirm=true` +15, cascade relationships +10, hard-delete +15
- Final score: `min(100, base + sum(modifiers))`
- Classification: 0-25=safe, 26-50=medium, 51-75=high, 76-100=critical
- For high/critical: require `description` and `sideEffects` fields
- Read model relationships for cascade detection (cascade="all, delete-orphan" in SQLAlchemy)

~30-40 lines.

- [ ] **Step 8: Write the manifest generation instructions — CRUD Flow Detection section**

Tells the agent how to auto-detect CRUD flows:
- Group endpoints by resource path pattern (strip `{id}` suffix)
- For each group with POST + GET/{id}: create a crudFlow entry
- Name: `{resource}-lifecycle` (e.g., "members-lifecycle")
- Steps: ordered list of `METHOD /path` strings
- Risk level: max risk level of any step in the flow
- Partial flows are valid (not all CRUD verbs needed)

~20-25 lines.

- [ ] **Step 9: Write the manifest generation instructions — Merge Strategy and Output section**

Tells the agent how to handle existing manifests:
- If `sentinel-manifest.json` exists: read it first
- Preserve any entries with `"manual": true`
- Overwrite all auto-generated entries
- Add `generatedAt` timestamp (ISO 8601)
- Write final JSON to `sentinel-manifest.json` in the target project root
- Apply `riskPolicy` from settings.json (settings override manifest defaults)
- Pretty-print with 2-space indentation

~20-25 lines.

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

~25-30 lines.

- [ ] **Step 3: Write the API sweep instructions — Parameter Resolution section**

Tells the agent how to resolve parameters before requests:
- For `lookup:` params: make GET request to the list endpoint, extract the referenced field
- For `static:` params: use the value directly
- For `env:` params: read from environment
- Handle failures: skip route if lookup returns empty, use static fallback if available, log Info finding
- Cache resolved values (don't re-fetch for every endpoint)

~25-30 lines.

- [ ] **Step 4: Write the API sweep instructions — Layer 1: Endpoint Health section**

Tells the agent how to test each endpoint:
- For each endpoint in manifest, for each role (including unauthenticated):
  - Check risk policy: skip if endpoint's riskLevel exceeds `riskPolicy.maxRiskLevel` (unless in `alwaysAllow`)
  - Skip if in `alwaysSkip`
  - For `--sandbox` mode with high/critical: show warning with description and side effects, ask for confirmation
  - Make the HTTP request with appropriate auth header
  - Check: authorized role should get 200/201; unauthorized role should get 401/403; unauthenticated should get 401/403
  - Check: response is valid JSON (not HTML)
  - Check: response time < `responseTimeout`
  - Check: error responses don't contain stack traces or SQL
  - Record findings with severity

~40-50 lines.

- [ ] **Step 5: Write the API sweep instructions — Layer 2: CRUD Flows section**

Tells the agent how to execute CRUD flows:
- For each `crudFlow` in manifest (filtered by risk policy):
  - POST: create resource with minimal valid payload, capture ID from response
  - GET by ID: verify 200, verify data matches what was sent
  - PATCH: modify one field, verify 200
  - GET by ID: verify update persisted
  - DELETE: if risk allows, verify 200/204
  - GET by ID: verify 404 or soft-delete response
  - Also test: invalid input → 400/422 (not 500), missing required fields → descriptive error
- Record findings per step

~35-40 lines.

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

~30-35 lines.

- [ ] **Step 7: Write the API sweep instructions — Output Format section**

Tells the agent how to return findings:
- Return a JSON array of findings, each with:
  - `severity`: "critical" | "error" | "warning" | "info"
  - `category`: "health" | "rbac" | "crud" | "schema" | "security"
  - `endpoint`: "METHOD /path"
  - `role`: which role was being tested
  - `message`: human-readable description
  - `expected`: what was expected
  - `actual`: what was received
  - `fileRef`: file:line if applicable
  - `fixSuggestion`: optional fix hint
- Also return metadata: endpoints tested count, roles tested, duration
- Write findings to a temp file for the command to collect

~25-30 lines.

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
tools: ["Read", "Write", "Bash", "Glob", "Grep", "mcp__plugin_playwright_playwright__browser_navigate", "mcp__plugin_playwright_playwright__browser_snapshot", "mcp__plugin_playwright_playwright__browser_take_screenshot", "mcp__plugin_playwright_playwright__browser_console_messages", "mcp__plugin_playwright_playwright__browser_network_requests", "mcp__plugin_playwright_playwright__browser_evaluate", "mcp__plugin_playwright_playwright__browser_resize", "mcp__plugin_playwright_playwright__browser_click", "mcp__plugin_playwright_playwright__browser_fill_form", "mcp__plugin_playwright_playwright__browser_close"]
---
```

- [ ] **Step 2: Write the browser sweep instructions — Login Flow section**

Tells the agent how to authenticate in the browser:
- Read `sentinel-manifest.json` for auth config and roles
- For each role (in hierarchy order):
  - Navigate to login page
  - Fill email/password fields
  - Submit login form
  - Wait for redirect/navigation
  - If login fails (still on login page or error visible): record Critical finding, skip this role
  - Verify auth by checking page content or localStorage for token
- For unauthenticated: skip login, navigate directly

~30-35 lines.

- [ ] **Step 3: Write the browser sweep instructions — Route Navigation and Console Capture section**

Tells the agent what to check on each route:
- For each role, for each route accessible to this role:
  - Resolve parameters (same lookup syntax as API sweeper)
  - Navigate to the route URL
  - Wait for network idle (no pending requests)
  - Capture console messages: look for `console.error`, unhandled promise rejections, and missing i18n key warnings (pattern: `[intlify]` or `Not found` in console)
  - Capture network requests: look for 4xx/5xx responses, failed requests
  - Record findings with route, role, message text, and severity

~35-40 lines.

- [ ] **Step 4: Write the browser sweep instructions — Layout Checks section**

Tells the agent how to perform DOM inspection at each breakpoint:

For each check from the spec, provide the exact JavaScript to evaluate via `browser_evaluate`:

1. **Horizontal overflow**: `document.body.scrollWidth > window.innerWidth`
2. **Broken images**: `[...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src)`
3. **Invisible buttons**: `[...document.querySelectorAll('button, a, [role=button]')].filter(el => el.offsetWidth === 0 || el.getBoundingClientRect().right < 0).map(el => el.textContent.trim())`
4. **Text truncation**: `[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,a')].filter(el => el.scrollWidth > el.clientWidth).map(el => ({text: el.textContent.trim(), tag: el.tagName}))`
5. **Empty containers**: use selectors from settings `emptyContainerSelectors`, check `el.children.length === 0 && el.textContent.trim() === ''`
6. **Overlapping interactive elements**: get bounding rects of all buttons/links, check for intersections

~50-60 lines.

- [ ] **Step 5: Write the browser sweep instructions — RBAC Negative Testing section**

Tells the agent how to verify unauthorized access is blocked:
- Using roleHierarchy from manifest: for each role, determine which routes should be inaccessible
- Navigate to each inaccessible route
- Check: should see redirect to login page, or 403 content, or empty authorized content
- Flag as Critical if the route content is visible to an unauthorized role
- For unauthenticated: all `requiresAuth` routes should redirect to login

~25-30 lines.

- [ ] **Step 6: Write the browser sweep instructions — Responsive Testing section**

Tells the agent how to test at multiple breakpoints:
- Read breakpoints from manifest (or settings fallback)
- For each breakpoint:
  - Resize browser to breakpoint width
  - Re-navigate to each route (or re-check current route)
  - Run all layout checks again
  - If issues found: take screenshot
  - Name screenshots: `{role}-{route-slug}-{breakpoint}-{timestamp}.png`
  - Save to `sentinel-reports/screenshots/`

~25-30 lines.

- [ ] **Step 7: Write the browser sweep instructions — Screenshot and Output section**

Tells the agent when and how to capture screenshots:
- Screenshot on any error or warning found
- Use `browser_take_screenshot` tool
- Save to `{reportDir}/screenshots/`
- Reference in findings with relative path

Output format: same JSON findings array as api-sweeper, with additional fields:
- `breakpoint`: viewport width when issue was found
- `screenshot`: relative path to screenshot file

~20-25 lines.

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
2. **Installation** — `claude plugin add /path/to/sentinel-plugin` (local install)
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

~150-200 lines.

- [ ] **Step 2: Commit README**

```bash
git add README.md
git commit -m "docs: README — installation, usage, configuration, and reference"
```

---

### Task 8: Integration Validation Against SmartSessions

**Files:**
- No files created — this is a manual validation task

- [ ] **Step 1: Install the plugin locally**

```bash
# From the SmartSessions project directory
claude plugin add /home/michel/projects/sentinel-plugin
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
- Has all 32+ routes from SmartSessions router
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
git commit -m "fix: integration refinements from SmartSessions validation"
```

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
2. Manual testing against SmartSessions (Task 8)
3. Iterating on agent prompts based on real behavior

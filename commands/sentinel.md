---
description: Automated QA sweep — catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys
argument-hint: <sweep|api|report|manifest|setup|trends|diff|fix|clean|export|config|serve|pr> [--sandbox] [--dry-run] [--reuse-manifest] [--risk-level <level>] [--safe-only] [--ci] [--changed-only] [--dashboard] [--format <fmt>] [--verify] [--visual-regression] [--port <N>] [--list] [--severity <level>]
allowed-tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"]
---

You are the Sentinel QA orchestrator. Your job is to parse the user's arguments, load settings, and route to the correct subcommand. Follow every instruction in this file precisely and in order.

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS` as follows:

- Split `$ARGUMENTS` by whitespace.
- The **first word** is the subcommand. Valid values: `sweep`, `api`, `report`, `manifest`, `setup`, `trends`, `diff`, `fix`, `clean`, `export`, `config`, `serve`, `pr`, `hello`.
- Any word starting with `--` is a flag. Supported flags: `--sandbox`, `--dry-run`, `--list`, `--severity`, `--reuse-manifest`, `--risk-level`, `--safe-only`, `--ci`, `--changed-only`, `--dashboard`, `--format`, `--verify`, `--port`, `--visual-regression`.
- Set `sandboxMode = true` if `--sandbox` appears anywhere in the arguments, otherwise `false`.
- Set `dryRunMode = true` if `--dry-run` appears, otherwise `false`.
- Set `listMode = true` if `--list` appears, otherwise `false`.
- Set `ciMode = true` if `--ci` appears, otherwise `false`. CI mode disables all interactive prompts, screenshots, and uses JSON stdout.
- Set `changedOnly = true` if `--changed-only` appears, otherwise `false`. Only sweep endpoints/routes whose source files changed since last run.
- Set `dashboardMode = true` if `--dashboard` appears, otherwise `false`.
- If `--severity` appears, take the next word as the severity filter value. Valid values: `critical`, `error`, `warning`, `info`. Store as `severityFilter`. If not present, set `severityFilter = null`.
- Set `reuseManifest = true` if `--reuse-manifest` appears, otherwise `false`.
- If `--risk-level` appears, take the next word as the risk level override. Valid values: `safe`, `medium`, `high`, `critical`. Store as `riskLevelOverride`. If not present, set `riskLevelOverride = null`.
- Set `safeOnly = true` if `--safe-only` appears, otherwise `false`. This is a shorthand for `--risk-level safe`.
- If `--format` appears, take the next word as the export format. Valid values: `postman`, `insomnia`, `bruno`. Store as `exportFormat`.
- Set `verifyFixes = true` if `--verify` appears (used with `fix` subcommand), otherwise `false`.

If `$ARGUMENTS` is empty, or the first word is not one of the valid subcommands, print this exact usage block and stop:

```
Sentinel v1.8.3 — Automated QA Sweep for Web Applications

Catches console errors, layout problems, RBAC violations, API schema drift,
and missing i18n keys. Supports Vue 3 + FastAPI + Pydantic + SQLAlchemy + JWT.

Usage: /sentinel:run <command> [flags]

Getting Started:
  setup       Check environment, install Playwright, detect frameworks, configure
              Run this first to verify your dev server is reachable and Playwright is installed.

Sweep Commands:
  sweep       Full browser + API sweep (runs both sweepers in parallel)
              Generates manifest, tests all endpoints via curl, navigates all routes via
              Playwright, captures console errors, layout issues, and RBAC violations.
  api         API-only sweep — endpoint health, RBAC, CRUD flows, schema contracts
              Faster than sweep — no browser needed. Good for CI or backend-only changes.

Analysis & Reporting:
  report      View the most recent sweep report (markdown format)
  report --dashboard  Show project health score (0-100) with category breakdowns
  trends      Show pass-rate and finding trends across recent runs
  diff        Compare two runs side-by-side — visual tree diff with +NEW/-REMOVED/~CHANGED
  manifest    Generate and inspect the manifest without sweeping
  export      Export manifest as Postman/Insomnia/Bruno collection (--format postman|insomnia|bruno)

Actions:
  fix         Auto-fix common findings with confirmation — RBAC, i18n, alt text, schemas
  fix --verify  Apply fixes then auto-re-sweep to verify they worked
  config      Interactive settings editor — frameworks, breakpoints, auth, risk policy
  clean       Remove old sweep runs, keeping the N most recent (default: 5)

Safety & Risk Control:
  By default, Sentinel only executes SAFE and MEDIUM risk actions (read-only
  and simple writes). Destructive operations like DELETE, bulk purge, and
  cascade deletes are SKIPPED and listed in the report as "Skipped Actions".
  You control this with:

  --safe-only        Only execute safe (read-only) actions — no writes at all
  --risk-level LVL   Override risk policy at runtime without editing settings.json
                     Levels: safe, medium (default), high, critical
  --sandbox          Unlock high/critical actions WITH per-action approval prompts
                     Every dangerous action asks you before executing (dev only)

  The active risk level is always shown in the sweep report header.

CI/CD:
  --ci               Non-interactive mode for CI pipelines — no prompts, JSON stdout,
                     exit code 0 (clean), 1 (criticals), 2 (errors found)
  --changed-only     Only sweep endpoints/routes whose source files changed since last run
                     Uses git diff against the commit SHA from the previous sweep

Other Flags:
  --dry-run          Generate manifest and show test plan without executing sweeps
  --reuse-manifest   Skip manifest generation, reuse the manifest from the latest run
                     Useful when re-running after fixing issues — saves time.
                     Also prompted interactively when a recent manifest is detected.
  --dashboard        Show project health score with category breakdowns (use with report)
  --list             List all previous sweep runs (use with report subcommand)
  --severity         Filter report output by minimum severity (critical, error, warning, info)
  --format FMT       Export format: postman, insomnia, bruno (use with export subcommand)
  --verify           After applying fixes, auto-re-sweep to verify (use with fix subcommand)

Examples:
  /sentinel:run setup                         # First-time check
  /sentinel:run sweep                         # Full QA sweep (safe + medium actions)
  /sentinel:run sweep --safe-only             # Read-only sweep — nothing gets modified
  /sentinel:run sweep --risk-level high       # Also test DELETE endpoints
  /sentinel:run sweep --sandbox               # Test everything, with per-action approval
  /sentinel:run sweep --changed-only          # Only sweep files changed since last run
  /sentinel:run api --dry-run                 # Preview what would be tested
  /sentinel:run api --ci                      # CI mode — JSON output, exit codes
  /sentinel:run report --dashboard            # Project health score (0-100)
  /sentinel:run report --severity error       # Show only errors and critical issues
  /sentinel:run diff                          # Visual diff: latest vs previous run
  /sentinel:run trends                        # Pass-rate trend across runs
  /sentinel:run fix --verify                  # Apply fixes then re-sweep to verify
  /sentinel:run export --format postman       # Export as Postman collection
  /sentinel:run config                        # Interactive settings editor
  /sentinel:run clean 3                       # Keep only the 3 most recent runs

Tip: Start with '/sentinel:run api --safe-only' for a zero-risk health check,
     then '/sentinel:run api' for standard coverage (safe + medium), then
     '/sentinel:run sweep' for full browser + API. Use '--ci' in pipelines
     and '--changed-only' for fast incremental checks.
```

---

## Step 2: Load Settings

Use the Read tool to read `$CLAUDE_PLUGIN_ROOT/settings.json`.

Merge the file contents with these defaults for any missing keys. The file value always takes precedence over the default:

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
  }
}
```

Store the merged result as `settings` for use in subsequent steps. The `reportDir` value from settings is the base output directory for all reports.

### Multi-Service Detection

After loading settings, determine the service list:

1. If `settings.services` is a non-empty array, use it directly. Each service object has this shape:
   ```json
   {
     "name": "internal-api",
     "apiBaseUrl": "http://localhost:18000",
     "baseUrl": "http://localhost:13001",
     "sourcePath": ".",
     "auth": { "credentialsSource": "manifest" }
   }
   ```
   Only `name` and `apiBaseUrl` are required. `baseUrl` is optional (for browser sweeps). `sourcePath` defaults to `"."` (project root). `auth` inherits from the top-level `settings.auth` if not specified.

2. If `settings.services` is empty or not set, the manifest generator will auto-detect services from `docker-compose.yml` files. The orchestrator treats this as a single implicit service (backward compatible — same behavior as before).

Set `isMultiService = true` if `settings.services` has 2+ entries OR if the manifest (once generated) contains 2+ services. Otherwise `isMultiService = false`.

---

## Step 2a: Apply Risk Level Override

If `safeOnly` is `true`, set `settings.riskPolicy.maxRiskLevel = "safe"`.

Otherwise, if `riskLevelOverride` is not null, set `settings.riskPolicy.maxRiskLevel = riskLevelOverride`. **If the override is `"high"` or `"critical"`, show the Destructive Operations Warning** (defined below) and wait for explicit `"yes"` confirmation before proceeding.

Otherwise (no flag provided), prompt the user to choose a risk level:

```
What risk level should this sweep use?

  [1] safe     — Read-only checks (GET requests only, nothing is modified)
  [2] medium   — Safe + simple writes (POST, PUT — no deletes) [default]
  [3] high     — Include delete operations (without approval prompts)
  [4] critical — Include bulk/cascade deletes (without approval prompts)

Choose [1-4] (press Enter for medium):
```

Wait for the user's response:
- If the user presses Enter (empty input) or chooses `2`: keep `settings.riskPolicy.maxRiskLevel = "medium"`.
- If the user chooses `1`: set `settings.riskPolicy.maxRiskLevel = "safe"`.
- If the user chooses `3`: set `settings.riskPolicy.maxRiskLevel = "high"`. **Show the destructive operations warning** (see below).
- If the user chooses `4`: set `settings.riskPolicy.maxRiskLevel = "critical"`. **Show the destructive operations warning** (see below).

### Destructive Operations Warning

**MANDATORY**: Whenever the effective risk level is set to `"high"` or `"critical"` — whether by interactive prompt (choices 3/4), by `--risk-level high`/`--risk-level critical` flag, or by `--sandbox` mode — you MUST display this warning and wait for explicit confirmation before proceeding:

```
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   ⚠  WARNING — DESTRUCTIVE OPERATIONS AHEAD  ⚠                      ║
║                                                                      ║
║   Risk level: {effectiveRiskLevel}                                   ║
║                                                                      ║
║   THIS SWEEP WILL EXECUTE DELETE, BULK, AND CASCADE OPERATIONS       ║
║   AGAINST YOUR DATABASE. DATA LOSS IS POSSIBLE AND MAY BE            ║
║   IRREVERSIBLE.                                                      ║
║                                                                      ║
║   BEFORE CONTINUING, VERIFY:                                         ║
║                                                                      ║
║     1. You are NOT connected to a production database                ║
║     2. You have a recent backup or can re-seed your data             ║
║     3. No other users are relying on this environment right now      ║
║                                                                      ║
║   Sentinel will test DELETE endpoints, cascade deletions, bulk       ║
║   operations, and purge actions at this risk level. Test records     ║
║   will be created and destroyed. Existing data may be affected       ║
║   by cascade relationships.                                          ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

Type "yes" to confirm, or anything else to abort:
```

Wait for the user's response. If the user types exactly `yes` (case-insensitive), proceed. For ANY other response (including `y`, `ok`, Enter, etc.), abort the sweep:

```
Sweep aborted. No actions were taken.

To run a safe sweep instead: /sentinel:run sweep --safe-only
To run with medium risk (no deletes): /sentinel:run sweep
```

**This warning cannot be skipped, suppressed, or auto-confirmed.** It applies to both `api` and `sweep` subcommands. In `--ci` mode, high/critical risk levels are **blocked entirely** — print `"CI mode does not allow high/critical risk levels. Use --safe-only or --risk-level medium."` and exit with code 2.

Store the final effective risk level as `effectiveRiskLevel = settings.riskPolicy.maxRiskLevel` for display in the report.

---

## Step 2a.1: CI Mode Behavior

If `ciMode` is `true`, apply these global overrides for the entire session:

1. **No interactive prompts** — all prompts that wait for user input are auto-resolved with defaults:
   - Risk level prompt → use `"medium"` (or the `--risk-level` flag if provided, but high/critical are blocked).
   - Manifest reuse prompt → generate a new manifest (never prompt).
   - All confirmation prompts → auto-skip (no destructive actions in CI).
2. **No screenshots** — set `settings.screenshotOnError = false`.
3. **JSON stdout** — after the sweep completes, output a single JSON object to stdout (in addition to the normal report):
   ```json
   {
     "version": "1.8.3",
     "runId": "{RUN_ID}",
     "mode": "{mode}",
     "healthScore": {healthScore},
     "findings": { "critical": N, "error": N, "warning": N, "info": N },
     "passRate": N.N,
     "duration": "Nm Ns",
     "exitCode": 0
   }
   ```
4. **Exit codes** — after the JSON output, the sweep is considered complete:
   - Exit code `0`: No critical or error findings.
   - Exit code `1`: At least one critical finding.
   - Exit code `2`: No critical findings but at least one error finding.
   - Print the exit code recommendation: `"CI exit code: {code}"` (the actual exit is handled by the Claude Code runtime, not the skill).

---

## Step 2a.2: Incremental Sweep (--changed-only)

If `changedOnly` is `true`, determine which endpoints and routes to test based on changed files:

1. **Get the previous commit SHA**: Read `{settings.reportDir}/sweep-history.json`. Extract the `commitSha` from the most recent entry. If no history exists, fall back to a full sweep and print: `"No previous sweep found — running full sweep."`.

2. **Find changed files**: Use the Bash tool:
   ```bash
   git diff --name-only {previousCommitSha}..HEAD
   ```
   Store the list of changed file paths.

3. **Map files to endpoints/routes**: After manifest generation, cross-reference each changed file path against:
   - Endpoint `fileRef` fields in the manifest — if the changed file matches, include that endpoint.
   - Route `view` or component file paths — if the changed file matches, include that route.
   - Schema files — if a schema file changed, include ALL endpoints that reference that schema.
   - Auth/middleware files — if changed, include ALL endpoints (auth changes affect everything).

4. **Filter the manifest**: Create a filtered manifest with only the affected endpoints and routes. Pass this filtered manifest to the sweeper agents instead of the full manifest.

5. **Record commit SHA**: After the sweep, store the current commit SHA in `sweep-history.json`:
   ```bash
   git rev-parse HEAD
   ```

If `changedOnly` is `false`, skip this section entirely and use the full manifest.

---

## Step 2b: Generate Run ID

Use the Bash tool to generate a filesystem-safe ISO timestamp as the run identifier:

```bash
date -u +"%Y-%m-%dT%H-%M-%SZ"
```

Store this value as `RUN_ID`. Set `runDir = {settings.reportDir}/{RUN_ID}`.

Use the Bash tool to create the run directory:

```bash
mkdir -p {runDir}
```

All output for this sweep/api run will go into `runDir`.

---

## Step 3: Route to Subcommand

Based on the subcommand parsed in Step 1, follow the matching section below. Execute only the section for the matched subcommand.

---

### Subcommand: `setup`

Invoke the `sentinel:sentinel-setup` skill using the Skill tool. Pass no additional arguments. The skill handles all environment detection, Playwright installation checking, and configuration guidance.

---

### Subcommand: `manifest`

Use the Agent tool to dispatch the manifest-generator agent. Use this exact prompt:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to {runDir}/sentinel-manifest.json.

After the agent completes, print:

```
Manifest generated: {runDir}/sentinel-manifest.json
```

---

### Subcommand: `api`

Execute the following steps in order:

**Step api-1: Generate or reuse manifest.**

Before generating a new manifest, check whether an existing one can be reused.

**If `reuseManifest` is `true` (flag passed):**
Look for the most recent manifest by checking `{settings.reportDir}/latest/sentinel-manifest.json`. If it exists, copy it to `{runDir}/sentinel-manifest.json` using the Bash tool:
```bash
cp {settings.reportDir}/latest/sentinel-manifest.json {runDir}/sentinel-manifest.json
```
print `"Reusing manifest from latest run."` and skip to the dry-run check.

If the latest manifest does not exist, print a warning: `"No existing manifest found — generating a new one."` and proceed with manifest generation below.

**If `reuseManifest` is `false` (no flag):**
Check whether `{settings.reportDir}/latest/sentinel-manifest.json` exists. If it does, prompt the user:

```
A manifest from a previous run was found ({settings.reportDir}/latest/sentinel-manifest.json).

  [1] Reuse existing manifest (faster — skip codebase analysis)
  [2] Generate a new manifest (re-analyze the codebase)

Choose [1/2]:
```

Wait for the user's response:
- If the user chooses `1`: copy the existing manifest to `{runDir}/sentinel-manifest.json` and skip to the dry-run check.
- If the user chooses `2`: proceed with manifest generation below.

If no existing manifest is found, proceed directly with generation (no prompt).

**Manifest generation (when needed):**

For large projects, dispatch **parallel sub-agents** for faster manifest generation. Use the Agent tool to dispatch up to 4 agents in a single response message:

- **Agent A (routes)**: `"Extract all frontend routes from the codebase. Write results as JSON to {runDir}/manifest-routes.json. Include path, view, requiredRole, params for each route."`
- **Agent B (endpoints)**: `"Extract all backend API endpoints from the codebase. Write results as JSON to {runDir}/manifest-endpoints.json. Include method, path, requiredRole, responseSchema, params for each endpoint."`
- **Agent C (schemas)**: `"Extract all schema definitions (Pydantic, Zod, TS interfaces, serde structs, GraphQL types, etc.) from the codebase. Write results as JSON to {runDir}/manifest-schemas.json."`
- **Agent D (config+analysis)**: `"Detect app configuration (name, URLs, auth, services), i18n coverage, a11y issues, and dead endpoints. Write results as JSON to {runDir}/manifest-config.json."`

After all 4 agents complete, dispatch a **merge agent**: `"Read {runDir}/manifest-routes.json, manifest-endpoints.json, manifest-schemas.json, and manifest-config.json. Merge into a single sentinel-manifest.json with risk scoring. Write to {runDir}/sentinel-manifest.json."`

**Fallback**: If parallel dispatch is not supported or any sub-agent fails, fall back to a single manifest-generator dispatch:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to {runDir}/sentinel-manifest.json.

**Dry-run check:** If `dryRunMode` is `true`, skip all sweeper dispatches. Instead:
1. Read the manifest that was just generated
2. Print a summary of what WOULD be tested:
   - Number of routes by risk level
   - Number of endpoints by risk level
   - CRUD flows that would be exercised
   - Which roles would be tested
   - Which actions would be skipped due to risk policy
3. Stop — do not proceed to sweeping or report generation.

**Step api-2: Detect services from manifest.**

Use the Read tool to read `{runDir}/sentinel-manifest.json`. Check whether the manifest contains a `services` array with 2+ entries. If yes, set `isMultiService = true` and store the service list. Otherwise, set `isMultiService = false`.

**Step api-3: Run API sweep(s).**

**Single-service mode** (`isMultiService = false`):

Use the Agent tool to dispatch the api-sweeper agent. Construct the prompt as follows — fill in the bracketed values from `settings` and from `sandboxMode`:

> Run an API-only sentinel sweep.
>
> Manifest path: {runDir}/sentinel-manifest.json
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {runDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/api-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

**Multi-service mode** (`isMultiService = true`):

Dispatch one api-sweeper agent per service, ALL in the SAME response message (parallel). For each service in the manifest's `services` array, construct the prompt:

> Run an API-only sentinel sweep for the **{service.name}** service.
>
> Manifest path: {runDir}/sentinel-manifest.json
> Service name: {service.name}
> API base URL: {service.apiBaseUrl}
>
> IMPORTANT: Only test endpoints belonging to service "{service.name}". In the manifest, each endpoint has a `"service"` field — only test endpoints where `service` equals "{service.name}". Use `{service.apiBaseUrl}` as the API base URL instead of the top-level `app.apiBaseUrl`.
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {runDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/{service.name}-api-findings.json using the findings JSON schema. Tag every finding with `"service": "{service.name}"`. When finished, do not print a summary — the orchestrator will handle reporting.

**Step api-4: Collect findings.**

**Single-service mode**: Use the Read tool to read `{runDir}/api-findings.json`. Store the parsed content as `apiFindingsData`. If the file does not exist or cannot be read, set `apiFindingsData` to `null` and print a warning:

```
Warning: api-sweeper did not produce findings. Report will be empty.
```

**Multi-service mode**: For each service, read `{runDir}/{service.name}-api-findings.json`. Merge all findings arrays into a single `apiFindingsData` object. Combine the `metadata` fields: sum `endpointsTested`, union `rolesTested`, take earliest `startedAt` and latest `finishedAt`. If any service file is missing, print a warning for that service and continue with the others.

**Step api-5: Generate report.**

Set `browserFindingsData = null`. Merge findings and generate the report following the instructions in **Section 4: Report Generation** below.

---

### Subcommand: `sweep`

Execute the following steps in order:

**Step sweep-1: Generate or reuse manifest.**

Before generating a new manifest, check whether an existing one can be reused.

**If `reuseManifest` is `true` (flag passed):**
Look for the most recent manifest by checking `{settings.reportDir}/latest/sentinel-manifest.json`. If it exists, copy it to `{runDir}/sentinel-manifest.json` using the Bash tool:
```bash
cp {settings.reportDir}/latest/sentinel-manifest.json {runDir}/sentinel-manifest.json
```
print `"Reusing manifest from latest run."` and skip to the dry-run check.

If the latest manifest does not exist, print a warning: `"No existing manifest found — generating a new one."` and proceed with manifest generation below.

**If `reuseManifest` is `false` (no flag):**
Check whether `{settings.reportDir}/latest/sentinel-manifest.json` exists. If it does, prompt the user:

```
A manifest from a previous run was found ({settings.reportDir}/latest/sentinel-manifest.json).

  [1] Reuse existing manifest (faster — skip codebase analysis)
  [2] Generate a new manifest (re-analyze the codebase)

Choose [1/2]:
```

Wait for the user's response:
- If the user chooses `1`: copy the existing manifest to `{runDir}/sentinel-manifest.json` and skip to the dry-run check.
- If the user chooses `2`: proceed with manifest generation below.

If no existing manifest is found, proceed directly with generation (no prompt).

**Manifest generation (when needed):**
Use the Agent tool to dispatch the manifest-generator agent with this prompt:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to {runDir}/sentinel-manifest.json.

**Dry-run check:** If `dryRunMode` is `true`, skip all sweeper dispatches. Instead:
1. Read the manifest that was just generated
2. Print a summary of what WOULD be tested:
   - Number of routes by risk level
   - Number of endpoints by risk level
   - CRUD flows that would be exercised
   - Which roles would be tested
   - Which actions would be skipped due to risk policy
3. Stop — do not proceed to sweeping or report generation.

**Step sweep-2: Check Playwright availability.**

Attempt to detect whether Playwright MCP browser tools are available. Do this by checking whether you have access to a tool named `browser_navigate` or `mcp__plugin_playwright_playwright__browser_navigate` (or any tool whose name contains `browser_navigate`). Set `playwrightAvailable = true` if such a tool exists, otherwise `false`.

**Step sweep-2b: Detect services from manifest.**

Use the Read tool to read `{runDir}/sentinel-manifest.json`. Check whether the manifest contains a `services` array with 2+ entries. If yes, set `isMultiService = true` and store the service list. Otherwise, set `isMultiService = false`.

**Step sweep-3: Run sweeps in parallel.**

CRITICAL PARALLELISM REQUIREMENT: You MUST make ALL Agent tool calls in the SAME response message. Do NOT call one agent, wait for its result, then call the next. ALL calls go out together — this is the whole point of the sweep command. If you serialize them, the sweep takes N× longer than necessary.

#### Single-service mode (`isMultiService = false`):

If `playwrightAvailable` is `true`:
Call the Agent tool TWICE in your NEXT response — both calls in the same message, no text between them, no waiting:

1. The browser-sweeper agent with this prompt:

> Run a browser sentinel sweep using Playwright.
>
> Manifest path: {runDir}/sentinel-manifest.json
>
> Settings:
> - Breakpoints: {settings.breakpoints}
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Screenshot on error: {settings.screenshotOnError}
> - Report directory: {runDir}
> - Browser: {settings.browser as JSON}
> - Empty container selectors: {settings.emptyContainerSelectors as JSON, or default ["[data-sentinel-content]", "main", ".card-body"] if not set}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/browser-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

2. The api-sweeper agent with this prompt:

> Run an API-only sentinel sweep.
>
> Manifest path: {runDir}/sentinel-manifest.json
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {runDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/api-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

If `playwrightAvailable` is `false`:
Print this warning and skip the browser sweep:

```
Warning: Playwright MCP not available — falling back to API-only mode.
Run /sentinel:run setup to install.
```

Then dispatch ONLY the api-sweeper agent with the same prompt as above.

#### Multi-service mode (`isMultiService = true`):

Dispatch ALL agents in a SINGLE response message. For each service in the manifest's `services` array, dispatch:

1. **One api-sweeper agent** with this prompt:

> Run an API-only sentinel sweep for the **{service.name}** service.
>
> Manifest path: {runDir}/sentinel-manifest.json
> Service name: {service.name}
> API base URL: {service.apiBaseUrl}
>
> IMPORTANT: Only test endpoints belonging to service "{service.name}". In the manifest, each endpoint has a `"service"` field — only test endpoints where `service` equals "{service.name}". Use `{service.apiBaseUrl}` as the API base URL instead of the top-level `app.apiBaseUrl`.
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {runDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/{service.name}-api-findings.json using the findings JSON schema. Tag every finding with `"service": "{service.name}"`. When finished, do not print a summary — the orchestrator will handle reporting.

2. **One browser-sweeper agent** (if `playwrightAvailable` AND the service has a `baseUrl`) with this prompt:

> Run a browser sentinel sweep using Playwright for the **{service.name}** service.
>
> Manifest path: {runDir}/sentinel-manifest.json
> Service name: {service.name}
> Frontend base URL: {service.baseUrl}
>
> IMPORTANT: Only test routes belonging to service "{service.name}". In the manifest, each route has a `"service"` field — only test routes where `service` equals "{service.name}". Use `{service.baseUrl}` as the frontend base URL instead of the top-level `app.baseUrl`.
>
> Settings:
> - Breakpoints: {settings.breakpoints}
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Screenshot on error: {settings.screenshotOnError}
> - Report directory: {runDir}
> - Browser: {settings.browser as JSON}
> - Empty container selectors: {settings.emptyContainerSelectors as JSON, or default ["[data-sentinel-content]", "main", ".card-body"] if not set}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {runDir}/{service.name}-browser-findings.json using the findings JSON schema. Tag every finding with `"service": "{service.name}"`. When finished, do not print a summary — the orchestrator will handle reporting.

If `playwrightAvailable` is `false`, skip all browser-sweeper dispatches and print the Playwright warning as above.

**Step sweep-4: Collect and merge findings.**

**Single-service mode**: Use the Read tool to read `{runDir}/api-findings.json`. Store as `apiFindingsData`, or `null` if missing. If `playwrightAvailable` was `true`, use the Read tool to read `{runDir}/browser-findings.json`. Store as `browserFindingsData`, or `null` if missing. Otherwise set `browserFindingsData = null`.

**Multi-service mode**: For each service, read `{runDir}/{service.name}-api-findings.json` and (if applicable) `{runDir}/{service.name}-browser-findings.json`. Merge all findings arrays into a single combined list. Each finding already has a `"service"` tag from the sweepers. Combine the `metadata` fields: sum `endpointsTested` and `routesTested`, union `rolesTested`, take earliest `startedAt` and latest `finishedAt`. Store the merged API data as `apiFindingsData` and merged browser data as `browserFindingsData`. If any service file is missing, print a warning for that service and continue.

**Deduplication:** Combine the `findings` arrays from both files into a single list. Two findings are considered duplicates if they share the same `endpoint`, `role`, and `message` values. When a duplicate exists, keep the one with the higher severity (critical > error > warning > info).

**Step sweep-5: Generate report.**

Generate the report following the instructions in **Section 4: Report Generation** below.

---

### Subcommand: `report`

Check whether the user passed a `--list` flag in the arguments.

**If `--list` is present:**

Use the Bash tool to list all run directories:

```bash
ls -1d {settings.reportDir}/????-??-??T??-??-??Z 2>/dev/null | sort -r
```

If no directories are found, print:

```
No runs found. Run /sentinel:run sweep or /sentinel:run api first.
```

Otherwise, print the list of run directories (most recent first).

**If `--list` is NOT present:**

First, try the new run-scoped format by reading from the `latest` symlink:

```bash
cat {settings.reportDir}/latest/sweep.md 2>/dev/null
```

If `{settings.reportDir}/latest/sweep.md` exists, use the Read tool to read that file.

**Severity filter:** If `severityFilter` is not null, filter the report output to only show findings at or above the specified severity. The severity ordering from highest to lowest is: `critical` > `error` > `warning` > `info`. For example, `--severity error` shows only critical and error findings. Apply this filter to all finding sections (Critical Issues, Errors, Warnings, Info) and the Task List — omit sections that have no findings after filtering. Always show the Summary section regardless of filter.

Print the (optionally filtered) report contents to the terminal.

If the `latest` symlink does not exist or does not contain `sweep.md`, fall back to the old flat format:

```bash
ls {settings.reportDir}/*.md 2>/dev/null | sort -r
```

Take the first (topmost) result. If found, use the Read tool to read the identified file and print its full contents.

If no reports are found in either format, print:

```
No reports found. Run /sentinel:run sweep or /sentinel:run api first.
```

---

### Subcommand: `trends`

Read `{settings.reportDir}/sweep-history.json` using the Read tool. If the file does not exist or contains no runs, print:

```
No sweep history found. Run /sentinel:run sweep or /sentinel:run api first.
```

Otherwise, parse the `runs` array and display the following sections. Use the last 5 entries (or fewer if less than 5 exist), ordered most-recent first.

**Pass Rate Trend:**

Print a table with columns: Run, Mode, Pass Rate. After the table, if there are at least 2 runs, print a trend line showing pass rates from oldest to newest with an arrow between each value, followed by `[improving]` if the latest is higher than the earliest in the window, `[declining]` if lower, or `[stable]` if equal.

**Finding Counts by Severity:**

Print a table with columns: Run, Critical, Error, Warning, Info. Right-align the numeric columns.

**Issue Delta (consecutive runs):**

For each adjacent pair of runs (older to newer), compute the per-severity delta. Print a table with columns: Transition, Critical, Error, Warning, Info. Prefix positive values with `+`, negative with `-`, and show zero as `0`. Skip this section if only 1 run exists.

---

### Subcommand: `diff`

Compare two sweep runs to show what's new, what's fixed, and what regressed.

**Step diff-1: Identify the two runs to compare.**

Parse `$ARGUMENTS` for run IDs after the `diff` keyword. There are three cases:

1. **No run IDs provided** (`/sentinel:run diff`): Compare the two most recent runs. Use the Bash tool:
   ```bash
   ls -1d {settings.reportDir}/????-??-??T??-??-??Z 2>/dev/null | sort -r | head -2
   ```
   The first result is the "current" run, the second is the "previous" run. If fewer than 2 runs exist, print: `"Need at least 2 runs to diff. Run /sentinel:run sweep or /sentinel:run api first."` and stop.

2. **One run ID provided** (`/sentinel:run diff 2026-03-15T14-30-00Z`): Compare the specified run against its predecessor. Find the run that precedes it chronologically.

3. **Two run IDs provided** (`/sentinel:run diff <older> <newer>`): Compare the two specified runs directly.

Store as `olderRun` and `newerRun`.

**Step diff-2: Load findings from both runs.**

Read `{settings.reportDir}/{olderRun}/api-findings.json` and `{settings.reportDir}/{olderRun}/browser-findings.json`. Merge into a single `olderFindings` array. Do the same for `newerRun` → `newerFindings`.

If either run has no findings files, print a warning and use an empty array.

**Step diff-3: Compute the diff.**

Compare findings using the composite key `(endpoint, route, role, category, message)`.

Classify each finding into one of three buckets:

- **Fixed**: Present in `olderFindings` but absent in `newerFindings`. These issues were resolved.
- **New**: Absent in `olderFindings` but present in `newerFindings`. These are regressions or new issues.
- **Persisted**: Present in both runs (same key). Note if severity changed.

**Step diff-3.5: Compare manifests for structural changes.**

Also load `sentinel-manifest.json` from both runs. Compare the endpoint and route lists structurally:

- **Added endpoints**: Present in newer manifest but absent in older.
- **Removed endpoints**: Present in older manifest but absent in newer.
- **RBAC changes**: Same endpoint exists in both but `requiredRole` changed.
- **Risk changes**: Same endpoint exists but `riskLevel` or `riskScore` changed.

**Step diff-4: Print the visual diff report.**

```
--- Sentinel Diff: {olderRun} → {newerRun} ---

┌─ Endpoint Changes ─────────────────────────────────────────┐
│                                                             │
│  /api/v1/users         GET   [safe]     ✓ unchanged        │
│  /api/v1/users         POST  [medium]   ✓ unchanged        │
│+ /api/v1/users/export  GET   [high]     NEW endpoint       │
│- /api/v1/legacy/data   GET   [safe]     REMOVED            │
│~ /admin/settings       —     [safe]     RBAC: user → admin │
│                                                             │
└─────────────────────────────────────────────────────────────┘

  Fixed ({fixedCount}):
  {for each fixed finding:}
    ✅ [{severity}] {category}: {message}
       {endpoint or route} ({role})

  New ({newCount}):
  {for each new finding:}
    🔴 [{severity}] {category}: {message}
       {endpoint or route} ({role})

  Persisted ({persistedCount}):
    {count} findings unchanged across both runs.
    {if any severity changed:}
    Severity changes:
    ⚠ {endpoint}: {oldSeverity} → {newSeverity}

  Summary:
    Older run: {olderPassRate}% pass rate ({olderTotal} findings)
    Newer run: {newerPassRate}% pass rate ({newerTotal} findings)
    Health score: {olderScore}/100 → {newerScore}/100 ({delta with +/- prefix})
    Net change: {findingDelta with +/- prefix} findings
```

If there are no fixed, no new findings, and no structural changes, print: `"No changes between runs."`.

---

### Subcommand: `fix`

Analyze the most recent sweep findings and suggest (or apply) code fixes for common issue patterns.

**Step fix-1: Load latest findings.**

Read findings from the `latest` symlink:
- `{settings.reportDir}/latest/api-findings.json`
- `{settings.reportDir}/latest/browser-findings.json`

Merge into a single findings array. If no findings exist, print: `"No findings to fix. Run /sentinel:run sweep or /sentinel:run api first."` and stop.

**Step fix-2: Categorize fixable findings.**

Filter findings to those with actionable fix patterns. The following categories have auto-fix support:

| Category | Pattern | Fix Strategy |
|----------|---------|-------------|
| `i18n` | Missing i18n key | Add the key to the locale file with a placeholder value |
| `rbac` | Unauthorized role got 2xx | Add the appropriate auth dependency to the endpoint |
| `schema` | Required field missing | Update the Pydantic response model |
| `health` | Stack trace leaked | Wrap the endpoint in a try/except with proper error response |
| `crud` | Empty body accepted | Add request body validation |

For each fixable finding, print:

```
[{n}] [{severity}] {category}: {message}
    Suggested fix: {fixSuggestion}
    File: {fileRef or "unknown — manual investigation needed"}
```

**Step fix-3: Offer to apply fixes.**

After listing all fixable findings, print:

```
Found {fixableCount} auto-fixable findings out of {totalCount} total.

Options:
  - Type a number (e.g., "1") to apply a specific fix
  - Type "all" to apply all fixes
  - Type "skip" to exit without changes

Which fixes would you like to apply?
```

Wait for the user's response.

**Step fix-4: Apply selected fixes.**

For each selected fix, use the appropriate tool:

- **i18n fixes**: Use Glob to find locale JSON files (e.g., `**/locales/*.json`, `**/i18n/*.json`). Read the file, add the missing key with value `"TODO: translate"`, write it back.
- **RBAC fixes**: Use the `fileRef` to read the endpoint file. Add the appropriate `Depends()` call to the function signature.
- **Schema fixes**: Read the schema file, add the missing field declaration.
- **Other fixes**: Print the suggested fix as a code snippet for the user to apply manually.

After applying each fix, use the appropriate tool (Edit for code changes, Write for new files like locale keys). Show a diff preview before applying:

```
Fix #{n}: {description}
  File: {filePath}:{lineNumber}
  Change:
    - {old code line}
    + {new code line}
  Apply? [yes/no]:
```

Wait for confirmation before each fix. If the user types `"all"` at any fix prompt, apply all remaining fixes without further prompts.

After applying fixes, print a summary:

```
Applied {appliedCount} fixes:
  - {description of each fix applied}

{if verifyFixes: "Running verification sweep..."}
{else: "Run /sentinel:run fix --verify to auto-verify, or /sentinel:run api to re-check manually."}
```

**Step fix-5: Regression Guard (--verify).**

If `verifyFixes` is `true`, automatically re-sweep after applying fixes:

1. Run `/sentinel:run api --safe-only --reuse-manifest --ci` targeting only the endpoints/routes that had fixed findings.
2. Load the new findings and compare against the original findings.
3. For each fix:
   - If the finding is gone → `"VERIFIED: {description}"`.
   - If the finding persists → `"UNRESOLVED: {description} — fix did not resolve the issue"`.
   - If a new finding appeared on the same endpoint → `"REGRESSION: {description} — fix introduced a new issue"`.
4. Print verification summary:

```
Verification Results:
  Verified:   {verifiedCount} fixes confirmed working
  Unresolved: {unresolvedCount} fixes did not resolve the issue
  Regressions: {regressionCount} fixes introduced new issues

{if unresolvedCount > 0: "Unresolved fixes may need manual investigation."}
{if regressionCount > 0: "WARNING: Some fixes introduced regressions. Review the affected endpoints."}
```

If any regressions are detected, offer to revert the affected fixes:

```
Revert {regressionCount} regressed fixes? [yes/no]:
```

If confirmed, use the Edit tool to restore the original code (the pre-fix content was stored in Step fix-4).

---

### Subcommand: `clean`

Remove old sweep run directories, keeping only the N most recent.

**Step clean-1: Determine retention count.**

Parse `$ARGUMENTS` for a number after `clean`. If a number is provided, use it as the retention count. If no number is provided, default to `5`.

**Step clean-2: List all runs.**

Use the Bash tool:

```bash
ls -1d {settings.reportDir}/????-??-??T??-??-??Z 2>/dev/null | sort -r
```

If no runs exist, print: `"No runs found. Nothing to clean."` and stop.

**Step clean-3: Identify runs to remove.**

Keep the first N entries (most recent). The remaining entries are candidates for removal.

If there are no candidates (total runs <= retention count), print: `"Only {count} runs found. Nothing to clean (keeping {retentionCount})."` and stop.

**Step clean-4: Confirm and remove.**

Print the list of runs that will be removed:

```
Keeping {retentionCount} most recent runs:
  {list of kept run IDs}

Removing {removeCount} older runs:
  {list of run IDs to remove}

Proceed? [y/n]
```

Wait for user confirmation. If the user confirms, use the Bash tool to remove each directory:

```bash
rm -rf {settings.reportDir}/{runId}
```

After removal, update `sweep-history.json` to remove entries for deleted runs. Read the file, filter the `runs` array to keep only entries whose `runId` matches a kept run, write back.

print `"Cleaned {removeCount} runs. {remainingCount} runs remaining."`.

---

### Subcommand: `export`

Export the manifest as an API collection file for external tools.

**Step export-1: Load manifest.**

Read the latest manifest from `{settings.reportDir}/latest/sentinel-manifest.json`. If not found, try `sentinel-manifest.json` in the project root. If neither exists, print: `"No manifest found. Run /sentinel:run manifest first."` and stop.

**Step export-2: Determine format.**

Use `exportFormat` from the parsed flags. If not provided, prompt:

```
Export format:
  [1] Postman Collection v2.1 (JSON)
  [2] Insomnia v4 (YAML)
  [3] Bruno (directory structure)

Choose [1-3]:
```

**Step export-3: Generate collection.**

For each endpoint in the manifest, create a request entry:

- **Name**: `{method} {path}` (e.g., `GET /api/v1/users`)
- **URL**: `{apiBaseUrl}{path}` with parameter placeholders
- **Method**: From the endpoint
- **Headers**: Based on `manifest.auth.method` — add `Authorization: Bearer {{token}}` for JWT, `x-api-key: {{api_key}}` for apikey
- **Body**: For POST/PUT/PATCH, generate a sample body from `manifest.schemas[endpoint.responseSchema]` if available
- **Group by**: Resource path (e.g., all `/users` endpoints in a "Users" folder)

**Postman format**: Write `{runDir}/sentinel-collection.postman.json` following Postman Collection v2.1 schema. Include environment variables for `baseUrl`, `token`, per-role credentials.

**Insomnia format**: Write `{runDir}/sentinel-collection.insomnia.yaml` with workspace, request groups, and requests.

**Bruno format**: Create `{runDir}/bruno-collection/` directory with `bruno.json` config and one `.bru` file per endpoint organized in folders.

print `"Exported {endpointCount} endpoints to {outputPath}"`.

---

### Subcommand: `config`

Interactive settings editor for Sentinel configuration.

**Step config-1: Load current settings.**

Read `settings.json` from the plugin directory. Display current values:

```
Current Sentinel Configuration:

  Risk Policy:
    Max risk level: {maxRiskLevel}
    Always skip: {alwaysSkip or "none"}
    Always allow: {alwaysAllow or "none"}

  Browser:
    Headless: {headless}
    Browser type: {browserType}
    Breakpoints: {breakpoints}
    Screenshot on error: {screenshotOnError}

  Network:
    Response timeout: {responseTimeout}ms
    Report directory: {reportDir}

  Auth:
    Credentials source: {credentialsSource}

  Services: {services.length or "single-service (auto-detect)"}

What would you like to change?
  [1] Risk policy
  [2] Breakpoints
  [3] Browser settings
  [4] Network/timeout settings
  [5] Auth credentials
  [6] Services configuration
  [7] Reset to defaults
  [0] Exit

Choose [0-7]:
```

**Step config-2: Handle selection.**

For each option, present the relevant sub-settings and allow the user to modify them. After each change, write the updated `settings.json` back to the plugin directory.

Validate all inputs:
- Risk levels must be one of: `safe`, `medium`, `high`, `critical`
- Breakpoints must be positive integers
- Timeout must be a positive number
- Browser type must be: `chromium`, `firefox`, `webkit`

print `"Settings updated: {settingsPath}"` after each change.

---

### Subcommand: `serve`

Generate and serve a self-contained HTML dashboard from the latest sweep results.

**Step serve-1: Load sweep data.**

Read findings from `{settings.reportDir}/latest/`:
- `api-findings.json`, `browser-findings.json`, `sentinel-manifest.json`, `sweep.md`

Also read `{settings.reportDir}/sweep-history.json` for trend data.

If no data exists, print: `"No sweep data found. Run /sentinel:run sweep first."` and stop.

**Step serve-2: Determine port.**

If `--port` was passed, use that value. Otherwise default to `4173`.

**Step serve-3: Generate HTML dashboard.**

Use the Write tool to create `{settings.reportDir}/dashboard.html` — a single self-contained HTML file with embedded CSS and JavaScript (no external dependencies, no build step). The dashboard includes:

1. **Header**: Project name, version, sweep timestamp, health score with A-F grade badge
2. **Score cards**: 6 category scores (API Health, RBAC, Schema, Layout, i18n, a11y) as colored cards
3. **Findings table**: Sortable/filterable table with severity, category, endpoint, role, message columns
4. **RBAC matrix**: Interactive table with roles as columns, endpoints as rows, pass/fail indicators
5. **Trends chart**: SVG line chart showing health score across last 10 runs from sweep-history.json
6. **i18n coverage**: Per-locale bar chart from `localeMatrix`
7. **Response times**: p50/p95/p99 bar chart for top 10 slowest endpoints
8. **Vulnerability summary**: Grouped by severity with package names and advisory links

**Design**: Dark theme, monospace metrics, minimal layout using CSS Grid. Color scheme: green (pass), red (critical), orange (error), yellow (warning), blue (info).

**Step serve-4: Serve the file.**

Use the Bash tool to start a simple HTTP server:

```bash
python3 -m http.server {port} --directory {settings.reportDir} --bind 127.0.0.1 &
```

Then print:

```
Dashboard running at http://localhost:{port}/dashboard.html

Press Ctrl+C to stop the server.
```

If Python is not available, try `npx serve {settings.reportDir} -l {port}` as fallback.

---

### Subcommand: `pr`

Post sweep results as a comment on the current GitHub PR.

**Step pr-1: Detect current PR.**

Use the Bash tool to find the current PR:

```bash
gh pr view --json number,title,url --jq '"\(.number) \(.title) \(.url)"' 2>/dev/null
```

If no PR is found (not on a PR branch, or `gh` not installed), print: `"No active PR detected. Push your branch and create a PR first, or run from a PR branch."` and stop.

Store `prNumber`, `prTitle`, `prUrl`.

**Step pr-2: Load latest sweep data.**

Read findings from `{settings.reportDir}/latest/`. Compute the health score and category breakdowns (same as Step R-3.5). If no sweep data, print: `"No sweep data found. Run /sentinel:run sweep first."` and stop.

**Step pr-3: Build PR comment body.**

Construct a markdown comment:

```markdown
## Sentinel QA Report

| Metric | Value |
|--------|-------|
| Health Score | **{score}/100** ({grade}) |
| Critical | {critical} |
| Errors | {errors} |
| Warnings | {warnings} |
| Endpoints tested | {endpointsTested} |
| Routes tested | {routesTested} |
| Duration | {duration} |

{if previousRun exists:}
### Changes since last sweep
- Fixed: {fixedCount}
- New issues: {newCount}
- Health score: {oldScore} → {newScore} ({delta})
{end if}

{if critical > 0:}
### Critical Issues
{for each critical finding:}
- **{category}**: {message} — `{endpoint}` ({role})
{end for}
{end if}

<details>
<summary>Full findings ({totalCount} items)</summary>

{for each finding, grouped by severity:}
- [{severity}] {category}: {message}
{end for}

</details>

---
*Generated by [Sentinel](https://github.com/michelabboud/sentinel-sweep) v1.8.3*
```

**Step pr-4: Post or update comment.**

Check if Sentinel has already commented on this PR:

```bash
gh api repos/{owner}/{repo}/issues/{prNumber}/comments --jq '[.[] | select(.body | contains("Sentinel QA Report"))] | length'
```

If an existing Sentinel comment exists, **update it** (don't create a duplicate):

```bash
COMMENT_ID=$(gh api repos/{owner}/{repo}/issues/{prNumber}/comments --jq '[.[] | select(.body | contains("Sentinel QA Report"))][0].id')
gh api repos/{owner}/{repo}/issues/comments/$COMMENT_ID -X PATCH -f body='{commentBody}'
```

If no existing comment, create a new one:

```bash
gh pr comment {prNumber} --body '{commentBody}'
```

Then print `"Posted sweep results to PR #{prNumber}: {prUrl}"`.

---

### Subcommand: `hello`

If the second word is `ID` (i.e., `$ARGUMENTS` is `hello ID`), respond with the full profile:

```
**Name**: Sentinel v1.8.3
**Description**: Automated QA sweep for web applications — catches console errors, layout problems, RBAC violations, API schema drift, i18n gaps, a11y issues, dead endpoints
**How to invoke**: `/sentinel:run <command> [flags]`
**Available commands**:
  - `setup` — Check environment, install Playwright, detect framework, configure settings
  - `sweep` — Full browser + API sweep (parallel sweepers, run-scoped output)
  - `api` — API-only sweep (endpoint health, RBAC, CRUD flows, schema contracts)
  - `report` — View the most recent sweep report (`--list` to see all runs, `--severity` to filter)
  - `trends` — Show pass-rate and finding trends across recent runs
  - `diff` — Compare two runs side-by-side (new, fixed, regressed findings)
  - `fix` — Auto-suggest and apply code patches for common findings
  - `clean` — Remove old sweep runs, keeping the N most recent
  - `manifest` — Generate and inspect the manifest without sweeping
  - `hello` — Quick greeting + availability check
  - `hello ID` — This full profile
**Flags**: `--sandbox`, `--dry-run`, `--reuse-manifest`, `--risk-level`, `--safe-only`, `--list`, `--severity`
**Architecture**: Orchestrator + 3 agents (manifest-generator, api-sweeper, browser-sweeper) + setup skill
**Languages**: Python, TypeScript/JavaScript, Rust, Go, PHP
**Frontend**: Vue 3, Nuxt 3, Next.js, React, SvelteKit, Angular, Remix
**Backend**: FastAPI, Express, Django REST, NestJS, Next.js API, Flask, Hono, Koa, Remix, Actix-web, Axum, Rocket, Gin, Echo, Chi, Laravel
**API protocols**: REST, GraphQL, gRPC, tRPC + OpenAPI import/auto-gen
**Schemas**: Pydantic v2, Zod, TS interfaces, Django serializers, Rust serde, Go structs, GraphQL types, Laravel FormRequest
**Auth**: JWT, NextAuth, session/cookie, API key, OAuth PKCE
**ORM cascade**: SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM, GORM, Eloquent
**Cross-cutting**: i18n, a11y, dead endpoints, WebSocket, versioning, migration drift, rate limiting, security headers
**Features**: Health score (--dashboard), CI mode (--ci), incremental (--changed-only), visual diff, auto-fix (--verify), export, config, parallel manifest
**Author**: Michel Abboud — https://github.com/michelabboud/sentinel-sweep | Apache-2.0
```

Otherwise (just `hello` with no `ID`), respond with the short greeting:

```
👋 Hello! I'm **Sentinel** v1.8.3. Automated QA sweep for Python, TypeScript, Rust, Go, and PHP web apps — catches console errors, layout bugs, RBAC violations, API schema drift, i18n gaps, a11y issues, and dead endpoints. Use `/sentinel:run hello ID` for the full guide.
```

---

## Section 4: Report Generation

This section is invoked after `api` and `sweep` subcommands complete their sweeps. You will have `apiFindingsData` and `browserFindingsData` (either a parsed findings object or `null`), a merged `findings` array (deduplicated), and `settings`.

### Step R-1: Compute summary statistics

From the merged findings array and the metadata blocks in the findings files, compute:

- `mode`: If `browserFindingsData` is not null, `"browser + api"`. Otherwise `"api-only"`.
- `rolesTested`: Union of `metadata.rolesTested` arrays from both findings files. Deduplicate. Format as comma-separated string.
- `routesTested`: Sum of `metadata.routesTested` from both files (treat null as 0).
- `endpointsTested`: Take from `apiFindingsData.metadata.endpointsTested` (treat null as 0).
- `breakpoints`: From `settings.breakpoints`, formatted as comma-separated values followed by `px` each (e.g., `375px, 768px, 1280px`).
- `startedAt`: Earliest `metadata.startedAt` across both files.
- `finishedAt`: Latest `metadata.finishedAt` across both files.
- `duration`: Human-readable elapsed time from `startedAt` to `finishedAt` (e.g., `2m 34s`). If timestamps are unavailable, write `unknown`.
- `countBySeverity`: Count findings in the merged array grouped by `severity`. Keys: `critical`, `error`, `warning`, `info`.
- `passed`: Sum of `metadata.endpointsTested` + `metadata.routesTested` across both files, minus total finding count where severity is `critical`, `error`, or `warning`. Floor at 0.
- `topIssues`: First 5 findings from the merged array sorted by severity descending (critical first), then by `riskScore` descending if present.
- `skippedActions`: Findings where `severity` is `info` and `category` is not set, OR any entry in the manifest's `riskPolicy.alwaysSkip` list not exercised, OR findings explicitly tagged as skipped by the sweeper agents.
- `sandboxActions`: Findings or log entries where `category` is `"sandbox"` (written by sweeper agents during sandbox execution).

### Step R-2: Ensure run directory exists

The run directory `{runDir}` was already created in Step 2b. If for any reason it does not exist, create it:

```bash
mkdir -p {runDir}
```

### Step R-3: Print terminal summary

Print the following block, substituting computed values:

```
--- Sentinel Sweep Report ---

  Mode: {mode} | Roles: {rolesTested}
  Risk level: {effectiveRiskLevel} {if sandboxMode: "(sandbox — approval required for high/critical)"}
  Routes tested: {routesTested} | Endpoints tested: {endpointsTested}
  Breakpoints: {breakpoints}
  Duration: {duration}

  Critical: {countBySeverity.critical}
  Error:    {countBySeverity.error}
  Warning:  {countBySeverity.warning}
  Info:     {countBySeverity.info}
  Passed:   {passed}

  Top issues:
  1. [{SEVERITY}] {category}: {message}
  ... (up to 5 issues, each on its own numbered line, sorted by severity descending)

  Full report: {runDir}/sweep.md
```

If `topIssues` is empty (no findings at all), replace the top issues block with:

```
  No issues found.
```

### Step R-3.5: Compute Health Score

Calculate a composite project health score (0-100) with weighted category breakdowns. This score is always computed and included in the report; `--dashboard` controls whether the detailed breakdown is shown in the terminal.

**Category scores** (each is 0-100):

| Category | Weight | Calculation |
|----------|--------|-------------|
| API Health | 25% | `100 - (healthFindings / endpointsTested * 100)` where healthFindings = findings with category `"health"` and severity `"critical"` or `"error"`. Floor at 0. If no endpoints tested, score = 100. |
| RBAC Compliance | 25% | `100` if zero RBAC findings with severity `"critical"`. Subtract 25 per critical RBAC finding, 10 per error. Floor at 0. |
| Schema Conformance | 15% | `100 - (schemaFindings / schemasChecked * 100)` where schemaFindings = findings with category `"schema"`. If no schemas checked, score = 100. |
| Layout Quality | 15% | `100 - (layoutFindings / routesTested * 50)` where layoutFindings = findings with category `"layout"` severity `"error"` or `"warning"`. Floor at 0. If no routes tested, score = 100. |
| i18n Coverage | 10% | Use the `i18n.coverage` value from the manifest (0.0-1.0) × 100. If no i18n data, score = 100. |
| a11y Compliance | 10% | Use the `a11y.score` value from the manifest (0.0-1.0) × 100. If no a11y data, score = 100. |

**Composite score**: `round(apiHealth * 0.25 + rbac * 0.25 + schema * 0.15 + layout * 0.15 + i18n * 0.10 + a11y * 0.10)`

**Grade**: A (90-100), B (80-89), C (70-79), D (60-69), F (0-59)

Store as `healthScore`, `healthGrade`, and `categoryScores` (object with all 6 scores).

**If `dashboardMode` is `true` OR in `--ci` mode**, print the dashboard after the terminal summary:

```
╔══════════════════════════════════════════════════╗
║           PROJECT HEALTH SCORE: {score}/100  {grade}           ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  API Health        [{bar}] {apiHealth}/100       ║
║  RBAC Compliance   [{bar}] {rbac}/100            ║
║  Schema Conformance[{bar}] {schema}/100          ║
║  Layout Quality    [{bar}] {layout}/100          ║
║  i18n Coverage     [{bar}] {i18n}/100            ║
║  a11y Compliance   [{bar}] {a11y}/100            ║
║                                                  ║
╚══════════════════════════════════════════════════╝
```

Where `{bar}` is a visual bar using `█` characters (10 chars wide, proportional to score/100).

The health score is always written to the report markdown and sweep-history.json regardless of `--dashboard`.

---

### Step R-4: Write markdown report

The report filename is `{runDir}/sweep.md` (the date is already encoded in the run directory name).

Use the Write tool to write the markdown report to that path. The report must contain the following sections in this order:

---

#### `## Summary`

A markdown table with these rows:

| Field | Value |
|-------|-------|
| Mode | {mode} |
| Risk level | {effectiveRiskLevel} |
| Roles tested | {rolesTested} |
| Routes tested | {routesTested} |
| Endpoints tested | {endpointsTested} |
| Breakpoints | {breakpoints} |
| Duration | {duration} |
| Critical | {count} |
| Error | {count} |
| Warning | {count} |
| Info | {count} |
| Passed | {passed} |
| Pass rate | {passed / (passed + critical + error + warning) * 100, rounded to 1 decimal}% |

---

#### `## Critical Issues`

**Multi-service grouping**: If `isMultiService` is `true`, group all finding sections (Critical, Errors, Warnings, Info) by service. For each severity section, write a `### {service.name}` subheading, then list the findings for that service. Findings with no `service` tag go under a `### General` subheading.

For each finding with `severity = "critical"`, write a checkbox entry:

```
- [ ] **[CRITICAL]** {category}: {message}
  - Service: {service or "—"}
  - File: {fileRef or "unknown"}
  - Expected: {expected or "n/a"}
  - Actual: {actual or "n/a"}
  - Screenshot: {screenshot or "none"}
```

If there are no critical findings, write: `_No critical issues._`

---

#### `## Errors`

Same checkbox format as Critical Issues, for findings with `severity = "error"`:

```
- [ ] **[ERROR]** {category}: {message}
  - Service: {service or "—"}
  - File: {fileRef or "unknown"}
  - Expected: {expected or "n/a"}
  - Actual: {actual or "n/a"}
  - Screenshot: {screenshot or "none"}
```

If there are no errors, write: `_No errors._`

---

#### `## Warnings`

Same checkbox format for findings with `severity = "warning"`:

```
- [ ] **[WARNING]** {category}: {message}
  - Service: {service or "—"}
  - File: {fileRef or "unknown"}
  - Expected: {expected or "n/a"}
  - Actual: {actual or "n/a"}
  - Screenshot: {screenshot or "none"}
```

If there are no warnings, write: `_No warnings._`

---

#### `## Info`

Bullet list (no checkboxes) for findings with `severity = "info"`:

```
- [{category}] {message} — {endpoint or route or "n/a"} ({role or "n/a"}) {if service: "[{service}]"}
```

If there are no info findings, write: `_No info entries._`

---

#### `## Skipped Actions`

For each high or critical risk action that was not executed (either due to `riskPolicy.maxRiskLevel` threshold, `riskPolicy.alwaysSkip` list, or unavailable sandbox mode), write:

```
- **{method} {path}** — Risk score: {riskScore}/100 ({riskLevel})
  {description}
```

If no actions were skipped, write: `_No actions skipped._`

---

#### `## Sandbox Actions`

Only include this section if `sandboxMode` is `true`.

For each action that was executed in sandbox mode (approved by user during sweep), write:

```
- **{method} {path}** — executed at {timestamp}
  {description}
  Restore: {restoreInstructions}
```

Then add a general note:

```
> To restore demo data after sandbox execution, run your project's seed scripts
> (e.g. `docker-compose exec api python -m seed` or your equivalent seed command).
```

If no sandbox actions were executed, write: `_No sandbox actions were executed._`

---

#### `## RBAC Matrix`

A markdown table where:
- **Rows** are each unique route or endpoint tested (format: `METHOD /path` for endpoints, `/path` for routes).
- **Columns** are each role tested plus `unauthenticated`.
- **Cells** contain:
  - `✅` — request succeeded as expected (authorized role got 2xx, or unauthorized role correctly got 401/403)
  - `❌` — RBAC violation (unauthorized role got 2xx, or authorized role got unexpected 4xx/5xx)
  - `⏭` — skipped (not tested for this role due to risk policy or missing test data)

Build this table from the findings data. An endpoint+role combination with no finding entry is assumed `✅` if that role was tested. Mark `⏭` for combinations explicitly skipped.

If no RBAC data is available, write: `_RBAC matrix not available — no sweep data._`

---

#### `## Task List`

A prioritized checklist of all actionable findings (critical, error, warning — not info), grouped by severity. Each entry:

```
- [ ] **[{SEVERITY}]** {category}: {message}
  - Location: {fileRef or "unknown"}
  - Fix: {fixSuggestion or "Investigate and resolve."}
```

Group order: Critical first, then Error, then Warning. Within each group, no specific ordering is required.

If there are no actionable findings, write: `_No action items. All checks passed._`

### Step R-5: Create latest symlink

After writing the report, create a `latest` symlink pointing to the current run directory:

```bash
ln -sfn {RUN_ID} {settings.reportDir}/latest
```

This uses the relative `RUN_ID` (not the full path) so the symlink is portable.

### Step R-6: Append to sweep history

After creating the latest symlink, append a summary entry to the sweep history file:

1. Use the Read tool to read `{settings.reportDir}/sweep-history.json`. If the file does not exist or cannot be parsed, start with `{ "runs": [] }`.

2. Build a new entry from the values computed in Step R-1:
   ```json
   {
     "runId": "{RUN_ID}",
     "mode": "{mode}",
     "duration": "{duration}",
     "rolesTested": ["{...rolesTested array}"],
     "routesTested": {routesTested},
     "endpointsTested": {endpointsTested},
     "findings": {
       "critical": {countBySeverity.critical},
       "error": {countBySeverity.error},
       "warning": {countBySeverity.warning},
       "info": {countBySeverity.info}
     },
     "passed": {passed},
     "passRate": {passed / (passed + countBySeverity.critical + countBySeverity.error + countBySeverity.warning) * 100, rounded to 1 decimal},
     "sandboxMode": {sandboxMode},
     "timestamp": "{ISO 8601 UTC timestamp of now}"
   }
   ```

3. Append the new entry to the `runs` array.

4. Use the Write tool to write the updated JSON back to `{settings.reportDir}/sweep-history.json` with 2-space indentation.

---

## Section 5: Findings JSON Schema Reference

Both sweeper agents write their findings to JSON files. When reading these files, expect this schema:

```json
{
  "metadata": {
    "mode": "api | browser",
    "rolesTested": ["admin", "manager", "user", "unauthenticated"],
    "endpointsTested": 84,
    "routesTested": 0,
    "startedAt": "ISO 8601 timestamp",
    "finishedAt": "ISO 8601 timestamp"
  },
  "findings": [
    {
      "severity": "critical | error | warning | info",
      "category": "health | rbac | crud | schema | security | console | layout | i18n | network",
      "endpoint": "GET /api/v1/users",
      "route": "/admin/users",
      "role": "manager",
      "message": "human-readable description",
      "expected": "what was expected",
      "actual": "what was received",
      "fileRef": "file:line or null",
      "fixSuggestion": "optional fix hint or null",
      "breakpoint": "viewport width in px or null",
      "screenshot": "relative path or null",
      "service": "service name or null (multi-service mode only)"
    }
  ]
}
```

- `endpoint` and `route` may both be null for findings that apply globally.
- `screenshot` paths are relative to the project root.
- `service` is set by sweeper agents in multi-service mode. In single-service mode, it is `null` or absent.
- Sweeper agents may add extra fields; ignore unknown fields when reading.
- **Single-service mode**: API sweeper writes to `{runDir}/api-findings.json`, browser sweeper writes to `{runDir}/browser-findings.json`.
- **Multi-service mode**: Each sweeper writes to `{runDir}/{service.name}-api-findings.json` or `{runDir}/{service.name}-browser-findings.json`.

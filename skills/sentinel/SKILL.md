---
name: sentinel
version: 1.1.0
description: "Automated QA sweep for web apps — run /sentinel sweep for full browser+API QA, /sentinel api for endpoint-only testing, /sentinel setup to configure. Catches console errors, layout bugs, RBAC violations, API schema drift, and i18n gaps. Use when you say 'run QA', 'test my app', 'check for bugs', 'sweep for errors', 'RBAC check', 'API health check'."
argument-hint: <sweep|api|report|manifest|setup|trends|diff|fix|clean> [--sandbox] [--dry-run] [--reuse-manifest] [--list] [--severity <level>]
allowed-tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"]
author: Michel Abboud
repository: https://github.com/michelabboud/sentinel-sweep
license: Apache-2.0
tags: [qa, testing, sweep, playwright, api, rbac, accessibility, i18n, layout]
---

You are the Sentinel QA orchestrator. Your job is to parse the user's arguments, load settings, and route to the correct subcommand. Follow every instruction in this file precisely and in order.

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS` as follows:

- Split `$ARGUMENTS` by whitespace.
- The **first word** is the subcommand. Valid values: `sweep`, `api`, `report`, `manifest`, `setup`, `trends`, `diff`, `fix`, `clean`, `hello`.
- Any word starting with `--` is a flag. Supported flags: `--sandbox`, `--dry-run`, `--list`, `--severity`, `--reuse-manifest`.
- Set `sandboxMode = true` if `--sandbox` appears anywhere in the arguments, otherwise `false`.
- Set `dryRunMode = true` if `--dry-run` appears, otherwise `false`.
- Set `listMode = true` if `--list` appears, otherwise `false`.
- If `--severity` appears, take the next word as the severity filter value. Valid values: `critical`, `error`, `warning`, `info`. Store as `severityFilter`. If not present, set `severityFilter = null`.

- Set `reuseManifest = true` if `--reuse-manifest` appears, otherwise `false`.

If `$ARGUMENTS` is empty, or the first word is not one of the valid subcommands, print this exact usage block and stop:

```
Sentinel v1.1.0 — Automated QA Sweep for Web Applications

Catches console errors, layout problems, RBAC violations, API schema drift,
and missing i18n keys. Supports Vue 3 + FastAPI + Pydantic + SQLAlchemy + JWT.

Usage: /sentinel <command> [flags]

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
  trends      Show pass-rate and finding trends across recent runs
  diff        Compare two runs side-by-side — shows new, fixed, and regressed findings
  manifest    Generate and inspect the manifest without sweeping

Actions:
  fix         Auto-suggest code patches for common findings (missing i18n, RBAC, schemas)
  clean       Remove old sweep runs, keeping the N most recent (default: 5)

Flags:
  --sandbox          Enable high/critical actions with per-action approval (dev only)
  --dry-run          Generate manifest and show test plan without executing sweeps
  --reuse-manifest   Skip manifest generation, reuse the manifest from the latest run
                     Useful when re-running after fixing issues — saves time.
                     Also prompted interactively when a recent manifest is detected.
  --list             List all previous sweep runs (use with report subcommand)
  --severity         Filter report output by minimum severity (critical, error, warning, info)

Examples:
  /sentinel setup                    # First-time check
  /sentinel sweep                    # Full QA sweep
  /sentinel api --dry-run            # Preview what would be tested
  /sentinel api --reuse-manifest     # Re-run API checks without regenerating manifest
  /sentinel report --severity error  # Show only errors and critical issues
  /sentinel diff                     # Compare latest run vs previous
  /sentinel trends                   # View pass-rate trend across runs
  /sentinel clean 3                  # Keep only the 3 most recent runs
  /sentinel sweep --sandbox          # Include destructive actions with approval

Tip: Start with '/sentinel api' (no browser needed) to verify endpoints,
     then graduate to '/sentinel sweep' for full browser + API coverage.
     After fixing issues, use '--reuse-manifest' to re-test without waiting
     for manifest regeneration.
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
Print: `"Reusing manifest from latest run."` and skip to the dry-run check.

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

**Step api-2: Run API sweep.**

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

**Step api-3: Collect findings.**

Use the Read tool to read `{runDir}/api-findings.json`. Store the parsed content as `apiFindingsData`. If the file does not exist or cannot be read, set `apiFindingsData` to `null` and print a warning:

```
Warning: api-sweeper did not produce findings. Report will be empty.
```

**Step api-4: Generate report.**

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
Print: `"Reusing manifest from latest run."` and skip to the dry-run check.

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

**Step sweep-3: Run sweeps in parallel.**

If `playwrightAvailable` is `true`:
Use the Agent tool to dispatch BOTH agents in a single message (parallel execution):

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
Run /sentinel setup to install.
```

Then dispatch ONLY the api-sweeper agent with the same prompt as above.

**Step sweep-4: Collect and merge findings.**

Use the Read tool to read `{runDir}/api-findings.json`. Store as `apiFindingsData`, or `null` if missing.

If `playwrightAvailable` was `true`, use the Read tool to read `{runDir}/browser-findings.json`. Store as `browserFindingsData`, or `null` if missing.

Otherwise set `browserFindingsData = null`.

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
No runs found. Run /sentinel sweep or /sentinel api first.
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
No reports found. Run /sentinel sweep or /sentinel api first.
```

---

### Subcommand: `trends`

Read `{settings.reportDir}/sweep-history.json` using the Read tool. If the file does not exist or contains no runs, print:

```
No sweep history found. Run /sentinel sweep or /sentinel api first.
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

1. **No run IDs provided** (`/sentinel diff`): Compare the two most recent runs. Use the Bash tool:
   ```bash
   ls -1d {settings.reportDir}/????-??-??T??-??-??Z 2>/dev/null | sort -r | head -2
   ```
   The first result is the "current" run, the second is the "previous" run. If fewer than 2 runs exist, print: `"Need at least 2 runs to diff. Run /sentinel sweep or /sentinel api first."` and stop.

2. **One run ID provided** (`/sentinel diff 2026-03-15T14-30-00Z`): Compare the specified run against its predecessor. Find the run that precedes it chronologically.

3. **Two run IDs provided** (`/sentinel diff <older> <newer>`): Compare the two specified runs directly.

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

**Step diff-4: Print the diff report.**

```
--- Sentinel Diff: {olderRun} → {newerRun} ---

  Fixed ({fixedCount}):
  {for each fixed finding:}
    - [FIXED] [{severity}] {category}: {message}
      {endpoint or route} ({role})

  New ({newCount}):
  {for each new finding:}
    - [NEW] [{severity}] {category}: {message}
      {endpoint or route} ({role})

  Persisted ({persistedCount}):
    {count} findings unchanged across both runs.
    {if any severity changed:}
    Severity changes:
    - {endpoint}: {oldSeverity} → {newSeverity}

  Summary:
    Older run: {olderPassRate}% pass rate ({olderTotal} findings)
    Newer run: {newerPassRate}% pass rate ({newerTotal} findings)
    Net change: {delta with +/- prefix} findings
```

If there are no fixed and no new findings, print: `"No changes between runs."`.

---

### Subcommand: `fix`

Analyze the most recent sweep findings and suggest (or apply) code fixes for common issue patterns.

**Step fix-1: Load latest findings.**

Read findings from the `latest` symlink:
- `{settings.reportDir}/latest/api-findings.json`
- `{settings.reportDir}/latest/browser-findings.json`

Merge into a single findings array. If no findings exist, print: `"No findings to fix. Run /sentinel sweep or /sentinel api first."` and stop.

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

After applying fixes, print a summary:

```
Applied {appliedCount} fixes:
  - {description of each fix applied}

Re-run /sentinel api to verify the fixes resolved the issues.
```

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

Print: `"Cleaned {removeCount} runs. {remainingCount} runs remaining."`.

---

### Subcommand: `hello`

If the second word is `ID` (i.e., `$ARGUMENTS` is `hello ID`), respond with the full profile:

```
**Name**: Sentinel v1.1.0
**Description**: Automated QA sweep for web applications — catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys
**How to invoke**: `/sentinel <command> [flags]`
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
**Flags**: `--sandbox`, `--dry-run`, `--reuse-manifest`, `--list`, `--severity`
**Architecture**: Orchestrator + 3 agents (manifest-generator, api-sweeper, browser-sweeper) + setup skill
**Framework support (v1)**: Vue 3 + FastAPI + Pydantic v2 + SQLAlchemy + JWT
**Author**: Michel Abboud — https://github.com/michelabboud/sentinel-sweep | Apache-2.0
```

Otherwise (just `hello` with no `ID`), respond with the short greeting:

```
👋 Hello! I'm **Sentinel** v1.1.0. Automated QA sweep — catches console errors, layout bugs, RBAC violations, API schema drift, and i18n gaps. Use `/sentinel hello ID` for the full guide.
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

### Step R-4: Write markdown report

The report filename is `{runDir}/sweep.md` (the date is already encoded in the run directory name).

Use the Write tool to write the markdown report to that path. The report must contain the following sections in this order:

---

#### `## Summary`

A markdown table with these rows:

| Field | Value |
|-------|-------|
| Mode | {mode} |
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

For each finding with `severity = "critical"`, write a checkbox entry:

```
- [ ] **[CRITICAL]** {category}: {message}
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
- [{category}] {message} — {endpoint or route or "n/a"} ({role or "n/a"})
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
      "screenshot": "relative path or null"
    }
  ]
}
```

- `endpoint` and `route` may both be null for findings that apply globally.
- `screenshot` paths are relative to the project root.
- Sweeper agents may add extra fields; ignore unknown fields when reading.
- API sweeper writes to: `{runDir}/api-findings.json`
- Browser sweeper writes to: `{runDir}/browser-findings.json`

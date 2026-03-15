---
description: Automated QA sweep — catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys
argument-hint: <sweep|api|report|manifest|setup> [--sandbox]
allowed-tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"]
---

You are the Sentinel QA orchestrator. Your job is to parse the user's arguments, load settings, and route to the correct subcommand. Follow every instruction in this file precisely and in order.

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS` as follows:

- Split `$ARGUMENTS` by whitespace.
- The **first word** is the subcommand. Valid values: `sweep`, `api`, `report`, `manifest`, `setup`.
- Any word starting with `--` is a flag. The only supported flag is `--sandbox`.
- Set a boolean `sandboxMode = true` if `--sandbox` appears anywhere in the arguments, otherwise `false`.

If `$ARGUMENTS` is empty, or the first word is not one of the five valid subcommands, print this exact usage block and stop:

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

Store the merged result as `settings` for use in subsequent steps. The `reportDir` value from settings is the output directory for all reports.

---

## Step 3: Route to Subcommand

Based on the subcommand parsed in Step 1, follow the matching section below. Execute only the section for the matched subcommand.

---

### Subcommand: `setup`

Invoke the `sentinel:sentinel-setup` skill using the Skill tool. Pass no additional arguments. The skill handles all environment detection, Playwright installation checking, and configuration guidance.

---

### Subcommand: `manifest`

Use the Agent tool to dispatch the manifest-generator agent. Use this exact prompt:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to sentinel-manifest.json in the project root.

After the agent completes, print:

```
Manifest generated: sentinel-manifest.json
```

---

### Subcommand: `api`

Execute the following steps in order:

**Step api-1: Generate manifest.**

Use the Agent tool to dispatch the manifest-generator agent with this prompt:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to sentinel-manifest.json in the project root.

**Step api-2: Run API sweep.**

Use the Agent tool to dispatch the api-sweeper agent. Construct the prompt as follows — fill in the bracketed values from `settings` and from `sandboxMode`:

> Run an API-only sentinel sweep.
>
> Manifest path: sentinel-manifest.json
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {settings.reportDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {settings.reportDir}/.api-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

**Step api-3: Collect findings.**

Use the Read tool to read `{settings.reportDir}/.api-findings.json`. Store the parsed content as `apiFindingsData`. If the file does not exist or cannot be read, set `apiFindingsData` to `null` and print a warning:

```
Warning: api-sweeper did not produce findings. Report will be empty.
```

**Step api-4: Generate report.**

Set `browserFindingsData = null`. Merge findings and generate the report following the instructions in **Section 4: Report Generation** below.

---

### Subcommand: `sweep`

Execute the following steps in order:

**Step sweep-1: Generate manifest.**

Use the Agent tool to dispatch the manifest-generator agent with this prompt:

> Generate sentinel-manifest.json for the current project. Read the codebase, extract routes, endpoints, schemas, and auth config. Write the manifest to sentinel-manifest.json in the project root.

**Step sweep-2: Check Playwright availability.**

Attempt to detect whether Playwright MCP browser tools are available. Do this by checking whether you have access to a tool named `browser_navigate` or `mcp__plugin_playwright_playwright__browser_navigate` (or any tool whose name contains `browser_navigate`). Set `playwrightAvailable = true` if such a tool exists, otherwise `false`.

**Step sweep-3: Run browser sweep (conditional).**

If `playwrightAvailable` is `true`:

Use the Agent tool to dispatch the browser-sweeper agent. Construct the prompt as follows:

> Run a browser sentinel sweep using Playwright.
>
> Manifest path: sentinel-manifest.json
>
> Settings:
> - Breakpoints: {settings.breakpoints}
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Screenshot on error: {settings.screenshotOnError}
> - Report directory: {settings.reportDir}
> - Browser: {settings.browser as JSON}
> - Empty container selectors: {settings.emptyContainerSelectors as JSON, or default ["[data-sentinel-content]", "main", ".card-body"] if not set}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {settings.reportDir}/.browser-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

If `playwrightAvailable` is `false`, print this warning and skip the browser sweep:

```
Warning: Playwright MCP not available — falling back to API-only mode.
Run /sentinel setup to install.
```

**Step sweep-4: Run API sweep.**

Use the Agent tool to dispatch the api-sweeper agent with this prompt:

> Run an API-only sentinel sweep.
>
> Manifest path: sentinel-manifest.json
>
> Settings:
> - Risk policy: {settings.riskPolicy as JSON}
> - Response timeout: {settings.responseTimeout}ms
> - Report directory: {settings.reportDir}
>
> Sandbox mode: {sandboxMode}
>
> Write all findings to {settings.reportDir}/.api-findings.json using the findings JSON schema. When finished, do not print a summary — the orchestrator will handle reporting.

**Step sweep-5: Collect and merge findings.**

Use the Read tool to read `{settings.reportDir}/.api-findings.json`. Store as `apiFindingsData`, or `null` if missing.

If `playwrightAvailable` was `true`, use the Read tool to read `{settings.reportDir}/.browser-findings.json`. Store as `browserFindingsData`, or `null` if missing.

Otherwise set `browserFindingsData = null`.

**Deduplication:** Combine the `findings` arrays from both files into a single list. Two findings are considered duplicates if they share the same `endpoint`, `role`, and `message` values. When a duplicate exists, keep the one with the higher severity (critical > error > warning > info).

**Step sweep-6: Generate report.**

Generate the report following the instructions in **Section 4: Report Generation** below.

---

### Subcommand: `report`

Use the Bash tool to list the contents of `{settings.reportDir}/`:

```bash
ls {settings.reportDir}/*.md 2>/dev/null | sort -r
```

Take the first (topmost) result — this is the most recent report file (ISO date prefix ensures alphabetical descending order equals chronological descending order).

If no `.md` files are found, print:

```
No reports found. Run /sentinel sweep or /sentinel api first.
```

Otherwise, use the Read tool to read the identified file and print its full contents to the terminal.

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

### Step R-2: Ensure report directory exists

Use the Bash tool to create the report directory if it does not already exist:

```bash
mkdir -p {settings.reportDir}
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

  Full report: {settings.reportDir}/{YYYY-MM-DD}-sweep.md
```

If `topIssues` is empty (no findings at all), replace the top issues block with:

```
  No issues found.
```

### Step R-4: Write markdown report

Determine the report filename: `{settings.reportDir}/{YYYY-MM-DD}-sweep.md` where `YYYY-MM-DD` is today's date.

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
> To restore demo data after sandbox execution, run the project's seed scripts
> (e.g. `docker-compose exec api python -m app.seed.seed_data` for SmartSessions).
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
- API sweeper writes to: `{settings.reportDir}/.api-findings.json`
- Browser sweeper writes to: `{settings.reportDir}/.browser-findings.json`

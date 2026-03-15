# Sweep History Tracking Spec

## Overview

Sentinel accumulates summary data from each sweep run into a single JSON file, enabling cross-run trend analysis. After every sweep or API run completes report generation, the orchestrator appends a summary entry to `sentinel-reports/sweep-history.json`.

---

## 1. File Format: `sweep-history.json`

Location: `{settings.reportDir}/sweep-history.json` (default: `sentinel-reports/sweep-history.json`)

```json
{
  "runs": [
    {
      "runId": "2026-03-15T14-30-00Z",
      "mode": "browser + api",
      "duration": "2m 34s",
      "rolesTested": ["admin", "manager", "user"],
      "routesTested": 24,
      "endpointsTested": 84,
      "findings": { "critical": 0, "error": 3, "warning": 7, "info": 12 },
      "passed": 86,
      "passRate": 96.6,
      "sandboxMode": false,
      "timestamp": "2026-03-15T14:30:00Z"
    }
  ]
}
```

### Field definitions

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Filesystem-safe ISO timestamp (matches the run directory name) |
| `mode` | string | `"browser + api"` or `"api-only"` |
| `duration` | string | Human-readable elapsed time (e.g., `"2m 34s"`, `"unknown"`) |
| `rolesTested` | string[] | Deduplicated list of roles exercised in the run |
| `routesTested` | number | Total browser routes tested |
| `endpointsTested` | number | Total API endpoints tested |
| `findings` | object | Counts keyed by severity: `critical`, `error`, `warning`, `info` |
| `passed` | number | Checks that produced no critical/error/warning finding |
| `passRate` | number | `passed / (passed + critical + error + warning) * 100`, rounded to 1 decimal |
| `sandboxMode` | boolean | Whether `--sandbox` was active for this run |
| `timestamp` | string | ISO 8601 UTC timestamp of when the run completed |

---

## 2. Orchestrator Append Logic (Step R-6)

After report generation (Step R-5), the orchestrator appends the current run's summary to `sweep-history.json`. The procedure is:

1. **Read** the existing file at `{settings.reportDir}/sweep-history.json`. If the file does not exist or cannot be parsed, start with `{ "runs": [] }`.

2. **Build** a new entry from the values already computed in Step R-1:
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
     "passRate": {passRate},
     "sandboxMode": {sandboxMode},
     "timestamp": "{ISO 8601 UTC timestamp}"
   }
   ```

3. **Append** the new entry to the `runs` array.

4. **Write** the updated JSON back to `{settings.reportDir}/sweep-history.json` using the Write tool, with 2-space indentation.

No entries are ever removed by the orchestrator. Users may manually prune old entries or delete the file to reset history.

---

## 3. Subcommand: `/sentinel trends`

The `trends` subcommand reads `sweep-history.json` and displays cross-run trends.

### Invocation

```
/sentinel trends
```

No flags are supported for this subcommand.

### Behavior

1. Read `{settings.reportDir}/sweep-history.json`. If the file does not exist or contains no runs, print:
   ```
   No sweep history found. Run /sentinel sweep or /sentinel api first.
   ```

2. Display the following sections:

#### Pass Rate Trend (last 5 runs)

A table showing the pass rate for the most recent 5 runs (or fewer if less than 5 exist):

```
Pass Rate Trend (last 5 runs)
-----------------------------
Run                     Mode            Pass Rate
2026-03-15T14-30-00Z    browser + api    96.6%
2026-03-14T09-15-00Z    api-only         94.2%
2026-03-13T16-45-00Z    browser + api    91.0%
2026-03-12T11-00-00Z    api-only         88.5%
2026-03-11T08-20-00Z    browser + api    85.3%
```

If there are at least 2 runs, append a sparkline-style trend indicator:

```
Trend: 85.3% -> 88.5% -> 91.0% -> 94.2% -> 96.6%  [improving]
```

The label is `[improving]` if the latest pass rate is higher than the earliest in the window, `[declining]` if lower, and `[stable]` if equal.

#### Finding Count Trend by Severity

A table showing finding counts per severity for the last 5 runs:

```
Finding Counts (last 5 runs)
----------------------------
Run                     Critical  Error  Warning  Info
2026-03-15T14-30-00Z           0      3        7    12
2026-03-14T09-15-00Z           1      5        9    10
2026-03-13T16-45-00Z           0      4       12    15
2026-03-12T11-00-00Z           2      8       10     8
2026-03-11T08-20-00Z           1      6       14    11
```

#### New vs Resolved Issues

Compare consecutive runs to show net change. For each adjacent pair of runs (N-1 to N), compute:
- **Delta** per severity = `run[N].findings[severity] - run[N-1].findings[severity]`
- Positive delta = new issues appeared; negative delta = issues resolved.

Display for the last 4 transitions (last 5 runs):

```
Issue Delta (consecutive runs)
------------------------------
Transition                                   Critical  Error  Warning  Info
T14-30-00Z vs T09-15-00Z                          -1     -2       -2    +2
T09-15-00Z vs T16-45-00Z                          +1     +1       -3    -5
T16-45-00Z vs T11-00-00Z                          -2     -4       +2    +7
T11-00-00Z vs T08-20-00Z                          +1     +2       +4    -3
```

Positive values are prefixed with `+`, negative with `-`, zero shown as `0`.

### Edge Cases

- If only 1 run exists, show the pass rate table with that single entry and skip the delta section.
- If `sweep-history.json` is corrupt or has an unexpected structure, print a warning and suggest deleting the file to reset.

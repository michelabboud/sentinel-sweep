# Example Sweep Report

> [!WARNING]
> **LEGACY 1.x EXAMPLE — not a current Sentinel 2.0 report.** This directory is
> preserved only as historical output evidence. Its separate API/browser findings,
> risk-score workflow, paths, and report sections are not the v2 artifact contract.
> Use the current [architecture](../../ARCHITECTURE.md) and
> [review report](../reports/2026-07-18-sentinel-plugin-review-and-architecture.md)
> for Sentinel 2.0 behavior and evidence.

This directory contains a sample Sentinel sweep report showing what output looks like after running `/sentinel sweep` on a typical Vue 3 + FastAPI application.

## Files

- `sweep.md` — The full markdown report (what `/sentinel report` displays)

## What to Expect

A real sweep run generates a timestamped directory like:

```
sentinel-reports/
  latest -> 2026-03-15T14-30-00Z/
  2026-03-15T14-30-00Z/
    sentinel-manifest.json    # Manifest used for this run
    api-findings.json         # API sweeper results
    browser-findings.json     # Browser sweeper results
    sweep.md                  # Full markdown report (shown here)
    screenshots/              # Layout issue screenshots
```

## Report Sections

1. **Summary** — Pass rate, duration, severity counts
2. **Critical Issues** — Must-fix items (RBAC violations, auth bypasses)
3. **Errors** — Server errors, broken images, console errors
4. **Warnings** — Layout issues, i18n gaps, slow responses
5. **Info** — Informational notes (skipped tests, empty data)
6. **Skipped Actions** — High/critical endpoints not tested due to risk policy
7. **RBAC Matrix** — Pass/fail grid for every endpoint + role combination
8. **Task List** — Prioritized checklist of all actionable findings with fix suggestions

## Terminal Summary

After each sweep, you also get a compact terminal summary:

```
--- Sentinel Sweep Report ---

  Mode: browser + api | Roles: admin, manager, user, unauthenticated
  Routes tested: 24 | Endpoints tested: 84
  Breakpoints: 375px, 768px, 1280px
  Duration: 2m 34s

  Critical: 1
  Error:    3
  Warning:  7
  Info:     12
  Passed:   86

  Top issues:
  1. [CRITICAL] rbac: RBAC violation — DELETE /api/v1/groups/{group_id} accessible as user
  2. [ERROR] schema: Required field 'email' missing from UserRead response
  3. [ERROR] health: Server error (500) on POST /api/v1/sessions
  4. [ERROR] console: Unhandled error: TypeError: Cannot read properties of undefined
  5. [WARNING] i18n: Missing i18n key: payments.status.overdue

  Full report: sentinel-reports/2026-03-15T14-30-00Z/sweep.md
```

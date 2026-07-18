# Sentinel sweep report

- Run: `2026-07-18T12-00-00-000Z`
- Coverage: `partial`
- Started: `2026-07-18T12:00:00.000Z`
- Finished: `2026-07-18T12:00:03.000Z`

## Summary

| Result | Count |
| --- | ---: |
| Critical | 1 |
| Error | 1 |
| Warning | 1 |
| Info | 0 |
| Skipped | 1 |

## Coverage diagnostics

| Code | Source | Pointer | Message |
| --- | --- | --- | --- |
| VUE_DYNAMIC_ROUTE | src/router.js | /routes/3 | One dynamic route was not executed |

## Findings

| Severity | Category | Subject | Role | Service | Message | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| critical | rbac | operation:op:get:/admin | user | api | User could access admin data | expected=401 or 403; actual=200; statusCode=200; durationMs=12 |
| error | console | route:route:/dashboard | unauthenticated | web | The dashboard raised an uncaught exception | expected=no console errors; actual=uncaught exception; durationMs=44; viewport=375; screenshotPath=dashboard-375.png |
| warning | coverage | run:coverage | unauthenticated | default | One dynamic route was not executed | none |
| info | policy | operation:op:post:/items | unauthenticated | api | Policy skipped POST /items | expected=policy approval; actual=MUTATION_BLOCKED_DISABLED |

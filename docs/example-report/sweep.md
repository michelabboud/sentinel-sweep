# Sentinel Sweep Report

> [!WARNING]
> **LEGACY 1.x EXAMPLE — not a current Sentinel 2.0 report.** This frozen sample is
> preserved only as historical output evidence and does not satisfy the v2 findings,
> artifact, identity, or safety contracts. Do not use it as a current template.

## Summary

| Field | Value |
|-------|-------|
| Mode | browser + api |
| Roles tested | admin, manager, user, unauthenticated |
| Routes tested | 24 |
| Endpoints tested | 84 |
| Breakpoints | 375px, 768px, 1280px |
| Duration | 2m 34s |
| Critical | 1 |
| Error | 3 |
| Warning | 7 |
| Info | 12 |
| Passed | 86 |
| Pass rate | 88.7% |

## Critical Issues

- [ ] **[CRITICAL]** rbac: RBAC violation — DELETE /api/v1/groups/{group_id} accessible as user
  - File: endpoints/groups.py:45
  - Expected: 403 Forbidden for role 'user'
  - Actual: 200 OK — resource deleted
  - Screenshot: none

## Errors

- [ ] **[ERROR]** schema: Required field 'email' missing from UserRead response
  - File: schemas/user.py:15
  - Expected: Field 'email' present (required: true)
  - Actual: Field absent in GET /api/v1/users/1 response
  - Screenshot: none

- [ ] **[ERROR]** health: Server error (500) on POST /api/v1/sessions
  - File: endpoints/sessions.py:22
  - Expected: 201 Created
  - Actual: 500 Internal Server Error
  - Screenshot: none

- [ ] **[ERROR]** console: Unhandled error: TypeError: Cannot read properties of undefined (reading 'map')
  - File: unknown
  - Expected: No console errors
  - Actual: Error on /admin/reports page
  - Screenshot: sentinel-reports/2026-03-15T14-30-00Z/screenshots/admin-admin-reports-desktop-20260315.png

## Warnings

- [ ] **[WARNING]** i18n: Missing i18n key: payments.status.overdue
  - File: unknown
  - Expected: Translated string
  - Actual: Raw key displayed: 'payments.status.overdue'
  - Screenshot: none

- [ ] **[WARNING]** layout: Horizontal overflow detected (420px > 375px)
  - File: unknown
  - Expected: No horizontal scroll
  - Actual: scrollWidth 420px > viewport 375px on /payments
  - Screenshot: sentinel-reports/2026-03-15T14-30-00Z/screenshots/admin-payments-375-20260315.png

- [ ] **[WARNING]** layout: Text truncated in H2: 'Member Activity Summary for Q...'
  - File: unknown
  - Expected: Full text visible
  - Actual: Text overflow on /groups/{id}/activity at 768px
  - Screenshot: sentinel-reports/2026-03-15T14-30-00Z/screenshots/manager-groups-id-activity-768-20260315.png

- [ ] **[WARNING]** i18n: Missing i18n key: groups.actions.archive
  - File: unknown
  - Expected: Translated string
  - Actual: Raw key displayed: 'groups.actions.archive'
  - Screenshot: none

- [ ] **[WARNING]** health: Slow response (5200ms, threshold 5000ms)
  - File: endpoints/reports.py:88
  - Expected: Response within 5000ms
  - Actual: 5200ms on GET /api/v1/reports/summary
  - Screenshot: none

- [ ] **[WARNING]** layout: Overlapping elements: 'Save' and 'Cancel'
  - File: unknown
  - Expected: No element overlap
  - Actual: Button overlap on /settings at 375px
  - Screenshot: sentinel-reports/2026-03-15T14-30-00Z/screenshots/admin-settings-375-20260315.png

- [ ] **[WARNING]** crud: Duplicate resource created without conflict detection
  - File: endpoints/members.py:30
  - Expected: 409 Conflict on duplicate email
  - Actual: 201 Created with same email
  - Screenshot: none

## Info

- [health] Resource not found — test data may be missing — GET /api/v1/events/{event_id} (admin)
- [health] Skipped — risk level 'high' exceeds policy maximum 'medium' — DELETE /api/v1/users/{user_id} (admin)
- [health] Skipped — risk level 'critical' exceeds policy maximum 'medium' — POST /api/v1/admin/purge-sessions (admin)
- [layout] Empty container: main () — /dashboard (user)
- [schema] Unexpected field 'legacy_id' in response (not in schema) — GET /api/v1/groups (admin)
- [schema] Unexpected field 'internal_notes' in response (not in schema) — GET /api/v1/members/{member_id} (admin)
- [crud] Test resource '550e8400-e29b-41d4-a716-446655440099' was created but not deleted — manual cleanup may be needed — POST /api/v1/groups (admin)
- [health] No data to validate schema for GET /api/v1/events — GET /api/v1/events (admin)
- [rbac] RBAC check inconclusive for route '/admin/audit-log' as 'user' — manual verification needed — /admin/audit-log (user)
- [health] Skipped by risk policy (alwaysSkip) — DELETE /api/v1/groups/{group_id}/members/{member_id} (admin)
- [i18n] Missing i18n key: common.loading — /dashboard (manager)
- [health] Route '/debug' skipped — env parameter not resolvable at runtime — /debug (admin)

## Skipped Actions

- **DELETE /api/v1/users/{user_id}** — Risk score: 70/100 (high)
  Permanently removes a user account and all associated data
- **POST /api/v1/admin/purge-sessions** — Risk score: 85/100 (critical)
  Purges all active sessions, forcing re-authentication for all users
- **DELETE /api/v1/groups/{group_id}/members/{member_id}** — Risk score: 60/100 (high)
  Removes member from group with cascade to attendance records

## RBAC Matrix

| Endpoint | admin | manager | user | unauthenticated |
|----------|-------|---------|------|-----------------|
| GET /api/v1/users | ✅ | ✅ | ✅ | ✅ |
| POST /api/v1/users | ✅ | ✅ | ⏭ | ✅ |
| GET /api/v1/groups | ✅ | ✅ | ✅ | ✅ |
| POST /api/v1/groups | ✅ | ✅ | ✅ | ✅ |
| DELETE /api/v1/groups/{group_id} | ✅ | ✅ | ❌ | ✅ |
| GET /api/v1/members | ✅ | ✅ | ✅ | ✅ |
| POST /api/v1/sessions | ❌ | ❌ | ❌ | ✅ |
| GET /api/v1/reports/summary | ✅ | ✅ | ⏭ | ✅ |

## Task List

- [ ] **[CRITICAL]** rbac: RBAC violation — DELETE /api/v1/groups/{group_id} accessible as user
  - Location: endpoints/groups.py:45
  - Fix: Add `Depends(require_manager_or_admin)` to the delete_group endpoint

- [ ] **[ERROR]** schema: Required field 'email' missing from UserRead response
  - Location: schemas/user.py:15
  - Fix: Add `email: str` field to UserRead schema or update response_model

- [ ] **[ERROR]** health: Server error (500) on POST /api/v1/sessions
  - Location: endpoints/sessions.py:22
  - Fix: Check server logs for unhandled exception in create_session

- [ ] **[ERROR]** console: Unhandled error: TypeError: Cannot read properties of undefined (reading 'map')
  - Location: unknown
  - Fix: Add null check before .map() call on the /admin/reports page

- [ ] **[WARNING]** i18n: Missing i18n key: payments.status.overdue
  - Location: unknown
  - Fix: Add 'payments.status.overdue' to locale files

- [ ] **[WARNING]** layout: Horizontal overflow detected (420px > 375px)
  - Location: unknown
  - Fix: Add `overflow-x: hidden` or make the payments table responsive

- [ ] **[WARNING]** layout: Text truncated in H2: 'Member Activity Summary for Q...'
  - Location: unknown
  - Fix: Use CSS `word-wrap: break-word` or truncate with ellipsis intentionally

- [ ] **[WARNING]** i18n: Missing i18n key: groups.actions.archive
  - Location: unknown
  - Fix: Add 'groups.actions.archive' to locale files

- [ ] **[WARNING]** health: Slow response (5200ms, threshold 5000ms)
  - Location: endpoints/reports.py:88
  - Fix: Optimize the reports summary query or increase responseTimeout

- [ ] **[WARNING]** layout: Overlapping elements: 'Save' and 'Cancel'
  - Location: unknown
  - Fix: Add spacing or stack buttons vertically at small breakpoints

- [ ] **[WARNING]** crud: Duplicate resource created without conflict detection
  - Location: endpoints/members.py:30
  - Fix: Add unique constraint check on email before creating member

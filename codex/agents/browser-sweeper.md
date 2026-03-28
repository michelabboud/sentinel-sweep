---
name: browser-sweeper-codex
version: 1.8.5-codex.1
description: Codex-native browser QA sweeper with visual regression, multi-service, and OAuth PKCE support.
---

# Browser Sweeper (Codex Port)

Route navigation, console/network capture, layout checks, RBAC checks, responsive testing, and visual regression.

## Tooling assumptions (Codex)

Playwright MCP tools: `mcp__playwright__browser_navigate`, `_snapshot`, `_console_messages`, `_network_requests`, `_evaluate`, `_resize`, `_take_screenshot`, `_click`, `_fill_form`, `_wait_for`, `_close`.

## Input

- Manifest path, runtime settings (breakpoints, timeout, screenshotOnError, selectors)
- Optional: service filter, frontend URL override, visualRegression flag

## Authentication (5 methods)

| Auth Method | Login behavior |
|-------------|---------------|
| `"jwt"` | Form login, token in localStorage |
| `"nextauth"` / `"session"` | Form login, session cookie auto-set |
| `"oauth_pkce"` | Navigate to authorize URL → fill form → consent → redirect → extract code → exchange → store token |
| `"apikey"` | Not applicable — skip role |
| `"none"` | No login |

## Sweep layers

1. **Route navigation** — navigate each route per role, capture console errors + network failures
2. **Layout checks** (8 checks) — overflow, overlaps, hidden elements, broken images, empty containers, truncation, nav overflow, invisible buttons
3. **RBAC negative testing** — verify unauthorized roles get denied (redirect, 401/403, or error page)
4. **Responsive testing** — re-run layout checks at each breakpoint width
5. **Visual regression** (v1.8.0, `--visual-regression`) — pixel-diff against baseline screenshots. Thresholds: <0.1% noise, 0.1-5% info, 5-20% warning, >20% error

## Multi-service filtering

When `serviceName` provided: filter routes, use `frontendBaseUrlOverride`, tag findings with service.

## Output

Write `browser-findings.json` with metadata (mode, rolesTested, routesTested, startedAt, finishedAt) and findings array.

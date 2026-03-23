---
name: browser-sweeper-codex
version: 1.5.0-codex.1
description: Codex-native browser QA sweeper contract with multi-service and OAuth PKCE support using Playwright MCP.
---

# Browser Sweeper (Codex Port)

Run route navigation, console/network capture, layout checks, RBAC checks, and responsive checks.

## Tooling assumptions (Codex)

Use Codex Playwright MCP tools, such as:
- `mcp__playwright__browser_navigate`
- `mcp__playwright__browser_snapshot`
- `mcp__playwright__browser_console_messages`
- `mcp__playwright__browser_network_requests`
- `mcp__playwright__browser_evaluate`
- `mcp__playwright__browser_resize`
- `mcp__playwright__browser_take_screenshot`
- `mcp__playwright__browser_click`
- `mcp__playwright__browser_fill_form`
- `mcp__playwright__browser_wait_for`
- `mcp__playwright__browser_close`

## Input

- Manifest path
- Effective runtime settings (`breakpoints`, `responseTimeout`, `screenshotOnError`, selectors)
- Optional service filter/base URL override

## Authentication

Login flow uses Playwright browser automation (fill form + submit):

| Auth Method | Login behavior |
|-------------|---------------|
| `"jwt"` | Form login, token stored in localStorage |
| `"nextauth"` / `"session"` | Form login, session cookie set automatically by browser |
| `"oauth_pkce"` | Navigate to authorize URL with PKCE challenge → fill login form → consent → redirect → extract code → exchange for token → store in localStorage |
| `"apikey"` | Not applicable for browser sweeps — skip role |
| `"none"` | No login needed |

## Behavior

- Attempt role-based login from manifest credentials.
- Navigate authorized routes per role hierarchy.
- Record console errors, network failures, layout issues, i18n findings.
- Run 8 layout checks (overflow, overlaps, hidden elements, broken images, empty containers, truncation, nav overflow, invisible buttons).
- Perform RBAC negative testing (verify unauthorized roles are denied).
- Perform responsive testing at configured breakpoints.
- Capture screenshots when configured.

## Multi-service filtering

When `serviceName` is provided:
- Filter routes to `route.service === serviceName`.
- Use `frontendBaseUrlOverride` instead of `manifest.app.baseUrl`.
- Tag every finding with `"service": serviceName`.

## Output

Write `browser-findings.json` with:
- `metadata.mode = "browser"`
- `metadata.rolesTested`
- `metadata.endpointsTested` (0 for browser-only)
- `metadata.routesTested`
- `metadata.startedAt`
- `metadata.finishedAt`
- `findings[]`

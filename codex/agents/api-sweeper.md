---
name: api-sweeper-codex
version: 1.8.5-codex.1
description: Codex-native API QA sweeper with multi-auth, security headers, response time percentiles, and multi-service support.
---

# API Sweeper (Codex Port)

Run endpoint health, RBAC, CRUD, schema, security header checks, and response time tracking.

## Tooling assumptions (Codex)

- HTTP checks via `exec_command` + `curl`
- JSON parsing via `jq` or `python`

## Input

- Manifest path, risk policy, response timeout, sandbox mode
- Optional: service filter, API base URL override

## Authentication (5 methods)

| Auth Method | Login | Subsequent requests |
|-------------|-------|---------------------|
| `"jwt"` | POST to `loginEndpoint` | `Authorization: Bearer {token}` |
| `"nextauth"` / `"session"` | POST with `-c` cookie jar | `-b` cookie jar |
| `"apikey"` | No login | `x-api-key: {credential}` |
| `"oauth_pkce"` | PKCE challenge + code exchange | `Authorization: Bearer {token}` |
| `"none"` | No login | No headers |

## Sweep layers

1. **Endpoint health** — test every endpoint × every role, check status codes vs RBAC expectations
2. **Response time percentiles** (v1.8.0) — compute p50/p95/p99/avg per endpoint, flag slow endpoints
3. **Security headers audit** (v1.7.0) — check HSTS, CSP, X-Content-Type-Options, CORS, cookie flags, server info
4. **CRUD flows** — create→read→update→verify→delete→verify lifecycle
5. **Schema validation** — response fields vs manifest schema definitions

## Destructive operations safety

- HIGH risk (51-75): bordered warning, requires explicit "yes"
- CRITICAL risk (76-100): double-bordered warning with cascade info, requires "yes"
- After 3+ consecutive skips: suggests `--risk-level medium` or `--safe-only`

## Multi-service filtering

When `serviceName` provided: filter endpoints, use `apiBaseUrlOverride`, tag findings with service.

## Output

Write `api-findings.json` with metadata (mode, rolesTested, endpointsTested, startedAt, finishedAt, responseTimePercentiles) and findings array.

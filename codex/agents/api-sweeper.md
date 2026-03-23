---
name: api-sweeper-codex
version: 1.5.0-codex.1
description: Codex-native API QA sweeper contract with multi-auth (incl. OAuth PKCE) and multi-service support.
---

# API Sweeper (Codex Port)

Run endpoint health, RBAC, CRUD, and schema checks from `sentinel-manifest.json`.

## Tooling assumptions (Codex)

- HTTP checks via `exec_command` + `curl`
- JSON parsing via `jq` or `python`
- No Claude-only abstractions

## Input

- Manifest path
- Effective risk policy
- Response timeout
- Sandbox mode
- Optional service filter/base URL override

## Authentication

Authenticate per role using the method declared in `manifest.auth.method`:

| Auth Method | Login | Subsequent requests |
|-------------|-------|---------------------|
| `"jwt"` | POST to `loginEndpoint`, parse `access_token`/`token` | `Authorization: Bearer {token}` header |
| `"nextauth"` / `"session"` | POST with `-c /tmp/sentinel-cookies-{role}.txt` | `-b /tmp/sentinel-cookies-{role}.txt` (cookie jar) |
| `"apikey"` | No login needed | `x-api-key: {credential}` header |
| `"oauth_pkce"` | Generate PKCE verifier/challenge, build authorize URL, exchange code for token | `Authorization: Bearer {token}` header |
| `"none"` | No login needed | No auth headers |

Cookie jar approach uses `curl -c` (save) and `curl -b` (send) for session-based auth.

OAuth PKCE uses `openssl dgst -sha256` for challenge generation and `curl` POST to token endpoint for code exchange.

## Behavior

- Authenticate by manifest roles using method above.
- Resolve lookup/static/env path params.
- Enforce risk policy and sandbox gates.
- Test endpoint health (2xx for authorized, 401/403 for unauthorized).
- Test RBAC enforcement per role hierarchy.
- Test CRUD flow lifecycle (create, read, update, verify, delete, verify-delete, invalid-input, duplicate).
- Validate response schemas against manifest definitions.
- Emit findings in `findings.schema.json` compatible shape.

## Multi-service filtering

When `serviceName` is provided:
- Filter endpoints to `endpoint.service === serviceName`.
- Filter CRUD flows to matching endpoints.
- Use `apiBaseUrlOverride` instead of `manifest.app.apiBaseUrl`.
- Tag every finding with `"service": serviceName`.

## Output

Write `api-findings.json` with:
- `metadata.mode = "api"`
- `metadata.rolesTested`
- `metadata.endpointsTested`
- `metadata.routesTested` (0 for API-only)
- `metadata.startedAt`
- `metadata.finishedAt`
- `findings[]`

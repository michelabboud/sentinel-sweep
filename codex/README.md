# Sentinel Codex Port

This directory is a **Codex-native port** of Sentinel.

It does not modify or depend on Claude plugin runtime features (`claude plugin ...`, `/sentinel:run`, `Agent`/`Skill` tool names, `$CLAUDE_PLUGIN_ROOT`).

## Supported Stacks (v1.5.0)

| Category | Supported |
|----------|-----------|
| Languages | Python, TypeScript/JavaScript, Rust |
| Frontend | Vue 3, Nuxt 3, Next.js App Router, React Router, SvelteKit, Angular |
| Backend | FastAPI, Express.js, Django REST, NestJS, Next.js API, Flask, Hono, Koa, Actix-web, Axum, Rocket |
| Schemas | Pydantic v2, Zod, TypeScript interfaces/types, Django serializers, Rust serde structs |
| Auth | JWT, NextAuth/Auth.js, session/cookie, API key, OAuth PKCE |
| ORM cascade | SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM |
| Cross-cutting | OpenAPI spec import, static i18n analysis |
| Browser | Playwright MCP (Chromium, Firefox, WebKit) |

## Scope

- Keep original Sentinel plugin unchanged.
- Provide Codex-oriented orchestration and agent specs.
- Reuse the same output artifacts and schemas:
  - `sentinel-manifest.json`
  - `api-findings.json`
  - `browser-findings.json`
  - `sweep.md`

## Directory

- `CODEX.md` — Codex-specific delegation policy (sub-agent first)
- `bin/sentinel-codex.sh` — runnable Codex orchestrator helper
- `commands/sentinel.md` — Codex orchestrator contract
- `agents/manifest-generator.md` — Codex manifest generation agent contract
- `agents/api-sweeper.md` — Codex API sweep agent contract
- `agents/browser-sweeper.md` — Codex browser sweep agent contract
- `schemas/` — pointers to canonical schemas in repo root

## Codex Mapping

- Claude `/sentinel:run <subcommand>` -> Codex prompt intent: `sentinel <subcommand>`
- Claude `Agent tool` -> Codex `spawn_agent`/`send_input`/`wait_agent`
- Claude `Bash` -> Codex `exec_command`
- Claude plugin Playwright MCP -> Codex Playwright MCP (`mcp__playwright__*`)
- `$CLAUDE_PLUGIN_ROOT` -> repository-local paths (typically project root)

## Recommended Invocation in Codex

Ask Codex directly, for example:

- `sentinel setup`
- `sentinel manifest`
- `sentinel api --dry-run`
- `sentinel sweep --risk-level medium`
- `sentinel report --severity error`

The orchestrator contract in `commands/sentinel.md` defines expected behavior.

## Running the helper

```bash
./codex/bin/sentinel-codex.sh setup
./codex/bin/sentinel-codex.sh manifest
./codex/bin/sentinel-codex.sh api --dry-run
./codex/bin/sentinel-codex.sh sweep --risk-level medium
./codex/bin/sentinel-codex.sh report --list
```

Every run creates sub-agent briefing files under:

`.sentinal/<RUN_ID>/subagent-briefs/`

Use those briefs as direct `spawn_agent` task payloads.

## Install a short command

Install a short shell command (default name: `sentinel`):

```bash
./codex/install.sh
```

Now you can run:

```bash
sentinel setup
sentinel setup /absolute/path/to/target-app
sentinel sweep --dry-run
sentinel report --list
```

Optional custom command name:

```bash
./codex/install.sh sentinel-codex
```

Uninstall:

```bash
./codex/uninstall.sh
```

## Severity, Security, and Scoring Config

Create `codex/config.json` (copy from `codex/config.example.json`) to control policy behavior.

- `severityPolicy.minReportSeverity`: `critical|error|warning|info`
- `securityPolicy`:
  - `enabled`
  - `requireAuthForApi`
  - `blockDestructiveByDefault`
  - `allowDestructive` (keep `false` unless explicitly approved)
  - `maxAllowedEndpointRisk`
  - `allowNonLocalApiBase`
  - `allowedApiHosts`
- `scoringPolicy`:
  - HTTP method weights
  - risk thresholds (`safeMax`, `mediumMax`, `highMax`)

Safety default:

- Destructive methods are blocked by default.
- Non-local API hosts are blocked unless explicitly allowed.

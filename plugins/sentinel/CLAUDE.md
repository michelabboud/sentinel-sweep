# CLAUDE.md

This file provides guidance to Claude Code when working with the Sentinel plugin.

## Repository Overview

**Sentinel** is a Claude Code plugin that automates QA sweeps for web applications. It catches console errors, layout problems, RBAC violations, API schema drift, and missing i18n keys.

- **Version**: 1.6.1
- **License**: Apache-2.0
- **Languages**: Python, TypeScript/JavaScript, Rust, Go, PHP
- **Frontend**: Vue 3, Nuxt 3, Next.js, React Router, SvelteKit, Angular, Remix
- **Backend**: FastAPI, Express.js, Django REST, NestJS, Next.js API, Flask, Hono, Koa, Actix-web, Axum, Rocket, Gin, Echo, Chi, Laravel
- **API protocols**: REST, GraphQL, gRPC, tRPC
- **Schemas**: Pydantic v2, Zod, TypeScript interfaces, Django serializers, Rust serde, Go structs, GraphQL types, Laravel FormRequest
- **Auth**: JWT, NextAuth/Auth.js, session/cookie, API key, OAuth PKCE
- **ORM cascade detection**: SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM, GORM, Eloquent
- **Cross-cutting**: OpenAPI import + auto-gen, static i18n analysis, a11y analysis, dead endpoint detection
- **Browser automation**: Playwright MCP

## Architecture

Sentinel is a 5-component plugin using an orchestrator pattern:

```
/sentinel (orchestrator skill)
    ├── manifest-generator (agent, opus)
    │   Reads codebase → produces sentinel-manifest.json
    │
    ├── api-sweeper (agent, sonnet)
    │   Tests endpoints via curl → api-findings.json
    │
    ├── browser-sweeper (agent, sonnet)
    │   Navigates via Playwright → browser-findings.json
    │
    └── sentinel-setup (skill, context: fork)
        Environment detection + configuration
```

### Key design decisions

- **Orchestrator is a pure router** — parses args, loads settings, generates run ID, dispatches agents, collects findings, generates report. No domain logic in the orchestrator.
- **Agents are stateless** — they receive everything via the dispatch prompt (manifest path, settings, flags). No shared state between sweepers.
- **Browser and API sweepers run in parallel** during `/sentinel sweep` — dispatched in a single Agent tool call.
- **Run-scoped output directories** — each sweep writes to `sentinel-reports/{ISO-timestamp}/` to prevent parallel run collisions. A `latest` symlink points to the most recent run.

## Repository Structure

```
sentinel-sweep/
├── CLAUDE.md                           # This file
├── README.md                           # User-facing documentation
├── CHANGELOG.md                        # Version history
├── LICENSE                             # Apache-2.0
├── settings.json                       # Default plugin settings
├── .gitignore                          # Ignores sentinel-reports/, node_modules/
├── VERSION                              # Single source of truth for version
│
├── commands/
│   └── sentinel.md                     # Legacy command (mirrors skills/run/)
│
├── skills/
│   ├── run/SKILL.md                    # Main orchestrator (Skills 2.0)
│   └── sentinel-setup/SKILL.md         # Environment setup (context: fork)
│
├── agents/
│   ├── manifest-generator.md           # Codebase analysis → manifest.json
│   ├── api-sweeper.md                  # Endpoint testing agent
│   └── browser-sweeper.md             # Playwright navigation agent
│
├── plugins/sentinel/                   # Installable plugin copy (mirrors root)
│   ├── .claude-plugin/plugin.json
│   ├── agents/
│   ├── commands/
│   ├── skills/
│   ├── settings.json
│   ├── README.md
│   └── LICENSE
│
├── .claude-plugin/
│   ├── plugin.json                     # Plugin metadata
│   └── marketplace.json                # Marketplace registration
│
└── docs/                               # Design documents and plans
```

## Component Details

### Orchestrator (`skills/run/SKILL.md`)

The main entry point. Handles:
1. Argument parsing (`sweep`, `api`, `report`, `manifest`, `setup`, `trends`, `diff`, `fix`, `clean`)
2. Settings loading from `settings.json` with defaults
3. Run ID generation (ISO timestamp)
4. Run directory creation under `sentinel-reports/`
5. Agent dispatch (parallel for sweep, single for api)
6. Finding collection and deduplication
7. Report generation (markdown + terminal summary)
8. Run comparison (`diff`), auto-fix suggestions (`fix`), and history cleanup (`clean`)

Flags: `--sandbox`, `--dry-run`, `--reuse-manifest`, `--risk-level`, `--safe-only`, `--list`, `--severity`

### Manifest Generator (`agents/manifest-generator.md`)

- Model: Opus (needs deep codebase understanding)
- Reads router files, API endpoints, Pydantic schemas, auth config, DB models
- Outputs `sentinel-manifest.json` with routes, endpoints, schemas, CRUD flows, auth config
- Supports `"manual": true` entries that survive re-generation

### API Sweeper (`agents/api-sweeper.md`)

- Model: Sonnet (high-throughput testing)
- Tests endpoint health (2xx), RBAC enforcement, CRUD flows, response schema validation
- Uses curl/Bash for HTTP requests
- Outputs `api-findings.json`

### Browser Sweeper (`agents/browser-sweeper.md`)

- Model: Sonnet
- Uses Playwright MCP for browser automation
- Tests console errors, network failures, layout issues, responsive breakpoints, i18n keys
- Outputs `browser-findings.json` with screenshots

### Setup Skill (`skills/sentinel-setup/SKILL.md`)

- Runs in forked context (`context: fork`)
- Checks Playwright installation
- Detects frontend/backend frameworks
- Verifies dev server connectivity
- Detects Tailwind breakpoints

### Multi-Service Architecture

Sentinel supports projects with multiple APIs and frontends (e.g., Internal Archive + Public Portal under one repo).

- **Configuration**: Add a `services` array to `settings.json` with `name`, `apiBaseUrl`, `baseUrl`, `sourcePath`
- **Auto-detection**: If no `services` config, the manifest generator auto-detects from multiple `docker-compose.yml` files
- **Manifest tagging**: Routes and endpoints are tagged with `"service": "service-name"` in multi-service mode
- **Parallel dispatch**: One api-sweeper and one browser-sweeper per service, all dispatched in a single Agent call
- **Report grouping**: Findings are grouped by service in the report output
- **Backward compatible**: Single-service projects work exactly as before (no `service` field)

## Important Conventions

### Hello Protocol

All agents implement the Hello Protocol:
- `hello` → short identification
- `hello <name> ID` → full capability profile

### Risk Scoring

Base score by HTTP method: GET=0, POST=25, PUT/PATCH=30, DELETE=60

Additive modifiers: admin-only (+10), "delete" in path (+15), "purge"/"reset" (+20), "bulk" (+15), confirm required (+15), cascade deletes (+10), hard-delete (+15)

Risk levels: safe (0-25), medium (26-50), high (51-75), critical (76-100)

### Manifest Parameter Resolution

Dynamic parameters use lookup expressions:
- `"lookup:groups[0].id"` — resolve from API response
- `"static:00000000-..."` — fallback for unresolvable params

### Plugin Parity

The `plugins/sentinel/` directory must mirror the root-level files exactly. When updating agents, skills, settings, or docs at root level, always copy changes to `plugins/sentinel/`.

## Development Guidelines

### Adding a New Sweeper

1. Create agent file in `agents/` with Hello Protocol
2. Add dispatch logic in the orchestrator skill
3. Define findings JSON schema (match existing format)
4. Update report generation to include new finding types
5. Mirror to `plugins/sentinel/agents/`

### Extending Framework Support

1. Update `sentinel-setup` to detect the new framework
2. Update `manifest-generator` with parsing rules for the framework's router/endpoint patterns
3. Document in README under Framework Support

### Version Bumping

The `VERSION` file is the single source of truth. Use the bump script:

```bash
./scripts/bump-version.sh 1.6.1
```

This updates VERSION, all JSON/MD files, and syncs the plugin mirror. Then add a CHANGELOG entry and run tests.

### Testing Changes

Run setup first to verify environment:
```
/sentinel setup
```

Test with dry-run to see what would execute:
```
/sentinel sweep --dry-run
```

Test API-only (no Playwright needed):
```
/sentinel api
```

### Settings

All settings have defaults in the orchestrator. The `settings.json` file only needs entries that differ from defaults:

| Setting | Default | Purpose |
|---------|---------|---------|
| `riskPolicy.maxRiskLevel` | `"medium"` | Auto-execute threshold |
| `breakpoints` | `[375, 768, 1280]` | Responsive viewport widths |
| `responseTimeout` | `5000` | API timeout (ms) |
| `screenshotOnError` | `true` | Capture layout issue screenshots |
| `reportDir` | `"sentinel-reports"` | Output directory |
| `browser.headless` | `true` | Headless browser mode |

## Common Issues

- **Empty manifest**: Framework not supported in v1. Add entries manually with `"manual": true`.
- **Browser sweep skipped**: Playwright MCP not installed. Run `/sentinel setup` to fix.
- **RBAC false positives**: Check `auth.roles` credentials in manifest match your seed data.
- **Stale findings**: Each run is isolated in its own timestamped directory. Check `latest` symlink.

# CODEX.md (Sentinel Codex Port)

This port is optimized for Codex orchestration with heavy sub-agent delegation.

## Supported stacks (v1.6.0)

- **Languages**: Python, TypeScript/JavaScript, Rust, Go, PHP
- **Frontend**: Vue 3, Nuxt 3, Next.js App Router, React Router, SvelteKit, Angular, Remix
- **Backend**: FastAPI, Express.js, Django REST, NestJS, Next.js API, Flask, Hono, Koa, Remix, Actix-web, Axum, Rocket, Gin, Echo, Chi, Laravel
- **API protocols**: REST, GraphQL, gRPC, tRPC
- **Schemas**: Pydantic v2, Zod, TypeScript interfaces/types, Django serializers, Rust serde, Go structs, GraphQL types, Laravel FormRequest
- **Auth**: JWT, NextAuth/Auth.js, session/cookie, API key, OAuth PKCE
- **ORM cascade detection**: SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM, GORM, Eloquent
- **Cross-cutting**: OpenAPI import + auto-gen, i18n, a11y, dead endpoints, WebSocket, versioning, migration drift, rate limiting, security headers

## Core rule

When running Sentinel commands in Codex, delegate as much as possible:

- Always spawn specialist workers for `manifest`, `api`, and `sweep`.
- For `sweep`, run API and browser workers in parallel.
- Use a separate synthesizer worker for report/dedup.
- Use separate analyst workers for `diff` and `trends`.

## Worker ownership model

- Manifest worker writes: `sentinel-manifest.json`
- API worker writes: `api-findings.json`
- Browser worker writes: `browser-findings.json`
- Report worker writes: `sweep.md`
- Analyzer workers write only under `subagent-briefs/` or analysis markdown files

Keep writes disjoint to avoid merge conflicts.

## Multi-service support

When `settings.services` is a non-empty array, dispatch one API worker + one browser worker **per service**, each receiving its `serviceName` and base URL override. Merge all findings at the report synthesis step. Group findings by service in the report.

## Runtime helper

Use `bin/sentinel-codex.sh` to create run folders and sub-agent briefs.

Each run emits:

- `subagent-briefs/manifest-generator-task.md`
- `subagent-briefs/api-sweeper-task.md` (for `api` and `sweep`)
- `subagent-briefs/browser-sweeper-task.md` (for `sweep`)
- `subagent-briefs/report-synthesizer-task.md`

For `diff` and `trends`, analyst briefs are emitted into the latest run.

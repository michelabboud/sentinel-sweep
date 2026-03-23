# CODEX.md (Sentinel Codex Port)

This port is optimized for Codex orchestration with heavy sub-agent delegation.

## Supported stacks (v1.5.0)

- **Languages**: Python, TypeScript/JavaScript, Rust
- **Frontend**: Vue 3, Nuxt 3, Next.js App Router, React Router, SvelteKit, Angular
- **Backend**: FastAPI, Express.js, Django REST, NestJS, Next.js API, Flask, Hono, Koa, Actix-web, Axum, Rocket
- **Schemas**: Pydantic v2, Zod, TypeScript interfaces/types, Django serializers, Rust serde structs
- **Auth**: JWT, NextAuth/Auth.js, session/cookie, API key, OAuth PKCE
- **ORM cascade detection**: SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM
- **Cross-cutting**: OpenAPI spec import, static i18n analysis

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

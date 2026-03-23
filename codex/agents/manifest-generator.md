---
name: manifest-generator-codex
version: 1.4.0-codex.1
description: Codex-native manifest generation contract for sentinel-manifest.json.
---

# Manifest Generator (Codex Port)

Generate `sentinel-manifest.json` by inspecting the project source.

## Tooling assumptions (Codex)

- File discovery and parsing: `exec_command` (`rg`, `find`, `sed`, `cat`, `jq`/`python`)
- No Claude-only tool names.

## Required output fields

Match the canonical schema in `schemas/sentinel-manifest.schema.json` (repo root).

Top-level required keys:
- `generatedAt`
- `app`
- `auth`
- `services` (empty array for single-service)
- `routes`
- `endpoints`
- `crudFlows`
- `schemas`

## Framework detection

### Frontend
Check in order, use first match:
1. `**/router/index.{js,ts}` → `"vue"`
2. `**/pages/**/*.vue` + `nuxt` in deps → `"nuxt"`
3. `**/src/routes/**/+page.svelte` → `"sveltekit"`
4. `**/app/**/page.{tsx,jsx}` + `next` in deps → `"nextjs"`
5. `**/src/App.{tsx,jsx}` + `react-router-dom` → `"react"`
6. `package.json` deps: `nuxt`/`next`/`vue`/`react`/`svelte`/`@angular/core`

### Backend
Check in order, use first match:
1. `**/endpoints/*.py` with `@router.get` → `"fastapi"`
2. `**/*.controller.ts` with `@Controller` → `"nestjs"`
3. `**/routes/*.{js,ts}` with `express.Router()` → `"express"`
4. `**/urls.py` with `urlpatterns` → `"django"`
5. `requirements.txt`/`pyproject.toml`: `fastapi`/`django`/`flask`
6. `package.json`: `@nestjs/core`/`express`/`hono`/`koa`

## Route extraction (per frontend framework)

| Framework | Source | Params | Auth detection |
|-----------|--------|--------|----------------|
| Vue 3 | `router/index.ts` route objects | `:param` → `{param}` | `meta.role` |
| Nuxt 3 | `pages/` file system | `[param]` → `{param}` | `definePageMeta({ middleware })` |
| Next.js | `app/` file system | `[param]` → `{param}` | layout auth, `middleware.ts` |
| React | `createBrowserRouter`, `<Route>` | `:param` → `{param}` | Wrapper components |
| SvelteKit | `src/routes/` file system | `[param]` → `{param}` | `+page.server.ts`, `hooks.server.ts` |

## Endpoint extraction (per backend framework)

| Framework | Source | Auth detection | Schema source |
|-----------|--------|----------------|---------------|
| FastAPI | `@router.get/post/...` | `Depends(require_X)` | `response_model=` |
| Express | `router.get/post/...` | middleware args | null (use Zod/TS if present) |
| Django REST | `urlpatterns` + ViewSets | `permission_classes` | `serializer_class` |
| NestJS | `@Get/@Post` decorators | `@UseGuards`, `@Roles` | `@ApiResponse({ type })` |
| Next.js API | `app/api/**/route.ts` exports | Handler auth checks | null |

## Schema extraction

Run ALL applicable parsers:
- **Pydantic v2**: `class X(BaseModel)` → Python type annotations
- **Zod**: `z.object({})` → chain methods (`.optional()`, `.nullable()`)
- **TypeScript**: `interface X {}` / `type X = {}` → TS field types
- **Django serializers**: `class X(ModelSerializer)` → Meta.fields

## Multi-service detection

1. If orchestrator passes `services` array → use directly.
2. Otherwise auto-detect from multiple `docker-compose.yml` files.
3. Tag every route/endpoint with `"service": "name"`.
4. Single-service (no services detected) → `services: []`, no service tags.

## Auth methods

| Method | Detection | Credential handling |
|--------|-----------|-------------------|
| JWT | `python-jose`, `jsonwebtoken`, `@auth/core` | Extract `access_token` from login response |
| NextAuth | `next-auth` deps, `[...nextauth]/route.ts` | Session cookie from login |
| Session | `express-session`, `SessionMiddleware` | Session cookie from login |
| API key | `x-api-key` patterns | Send header directly |

## ORM cascade detection

SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose — extract cascade relationships for risk scoring.

## Output path

Write JSON to the path given by orchestrator (or default `sentinel-manifest.json`).

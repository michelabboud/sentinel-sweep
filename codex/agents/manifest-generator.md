---
name: manifest-generator-codex
version: 1.8.5-codex.1
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
- `generatedAt`, `app`, `auth`, `services`, `routes`, `endpoints`, `crudFlows`, `schemas`

Optional cross-cutting fields (null if not detected):
- `i18n`, `a11y`, `deadCode`, `deadCss`, `n1Queries`, `vulnerabilities`, `apiVersioning`, `migrationDrift`, `rateLimiting`

## Framework detection

### Frontend (7 parsers)
1. `**/router/index.{js,ts}` → `"vue"`
2. `**/pages/**/*.vue` + `nuxt` in deps → `"nuxt"`
3. `**/app/routes/**/*.tsx` + `@remix-run/react` → `"remix"`
4. `**/src/routes/**/+page.svelte` → `"sveltekit"`
5. `**/app/**/page.{tsx,jsx}` + `next` in deps → `"nextjs"`
6. `**/src/App.{tsx,jsx}` + `react-router-dom` → `"react"`
7. `**/app-routing.module.ts` or `**/app.routes.ts` + `@angular/core` → `"angular"`

### Backend (14+ parsers)
1. `**/endpoints/*.py` with `@router.get` → `"fastapi"`
2. `**/*.controller.ts` with `@Controller` → `"nestjs"`
3. `**/routes/*.{js,ts}` with `express.Router()` → `"express"`
4. `**/urls.py` with `urlpatterns` → `"django"`
5. `**/src/main.rs`: `actix_web` → `"actix"` | `axum::Router` → `"axum"` | `rocket::build()` → `"rocket"`
6. `Cargo.toml`: `actix-web`/`axum`/`rocket`
7. `**/main.go`: `gin-gonic/gin` → `"gin"` | `labstack/echo` → `"echo"` | `go-chi/chi` → `"chi"`
8. `**/routes/api.php` or `composer.json` with `laravel/framework` → `"laravel"`
9. `requirements.txt`/`pyproject.toml`: `fastapi`/`django`/`flask`
10. `package.json`: `@nestjs/core`/`express`/`hono`/`koa`

### API Protocols
- `**/*.proto` with `service` definitions → gRPC
- `package.json` with `@trpc/server` → tRPC
- `**/*.graphql` or `@apollo/server`/`type-graphql` → GraphQL
- `openapi.json`/`.yaml`/`swagger.json` → OpenAPI import

## Route extraction (per frontend framework)

| Framework | Source | Params | Auth detection |
|-----------|--------|--------|----------------|
| Vue 3 | `router/index.ts` | `:param` → `{param}` | `meta.role` |
| Nuxt 3 | `pages/` file system | `[param]` → `{param}` | `definePageMeta({ middleware })` |
| Next.js | `app/` file system | `[param]` → `{param}` | layout auth, `middleware.ts` |
| React | `createBrowserRouter`, `<Route>` | `:param` → `{param}` | Wrapper components |
| SvelteKit | `src/routes/` file system | `[param]` → `{param}` | `+page.server.ts` |
| Angular | `Routes` arrays, lazy modules | `:param` → `{param}` | `canActivate` guards |
| Remix | `app/routes/` flat conventions | `$param` → `{param}` | `loader` auth checks |

## Endpoint extraction (per backend framework)

| Framework | Source | Auth detection | Schema source |
|-----------|--------|----------------|---------------|
| FastAPI | `@router.get/post/...` | `Depends(require_X)` | `response_model=` |
| Express | `router.get/post/...` | middleware args | Zod/TS |
| Django REST | `urlpatterns` + ViewSets | `permission_classes` | `serializer_class` |
| NestJS | `@Get/@Post` decorators | `@UseGuards`, `@Roles` | `@ApiResponse` |
| Next.js API | `app/api/**/route.ts` | Handler auth checks | null |
| Flask | `@app.route()`, Blueprints | `@login_required` | `flask-marshmallow` |
| Hono | `app.get/post/...` | `jwt()`, `bearerAuth()` | `zValidator()` |
| Koa | `router.get/post/...` | `koa-jwt` | null |
| Remix | `loader` (GET) + `action` (POST) | `requireUser()` | Zod |
| Actix-web | `#[get]`/`#[post]` macros | `actix-web-grants` | Return types |
| Axum | `Router::new().route()` | `Extension<Claims>` | `Json<Type>` |
| Rocket | `#[get]`/`#[post]` attrs | Request guards | `Json<Type>` |
| Gin | `r.GET/POST/...` | Group middleware | Handler structs |
| Echo | `e.GET/POST/...` | `middleware.JWT()` | null |
| Chi | `r.Get/Post/...` | `.With()` middleware | null |
| Laravel | `Route::get/apiResource` | Sanctum/Spatie | FormRequest |
| GraphQL | SDL `Query`/`Mutation` | `@auth` directives | Type definitions |
| gRPC | `.proto` service/rpc | Interceptors | Message types |
| tRPC | `createTRPCRouter` procedures | `protectedProcedure` | Zod I/O |
| OpenAPI | `openapi.json`/`.yaml` | `security` defs | `components.schemas` |

## OpenAPI auto-generation from code annotations

Detect annotation libraries: utoipa (Rust), swagger-jsdoc (JS), drf-spectacular (Django), FastAPI auto-docs, NestJS Swagger, swag (Go), @hono/zod-openapi, rocket_okapi, flask-restx. Fetch generated spec or parse annotations from source.

## Schema extraction (8 parsers)

Pydantic v2, Zod, TypeScript interfaces, Django serializers, Rust serde, Go structs (json tags), GraphQL types (SDL), Laravel FormRequest/Eloquent casts.

## Cross-cutting analysis (15 analyzers)

| Analyzer | Output field | Description |
|----------|-------------|-------------|
| i18n + completeness matrix | `i18n` | Missing/unused keys, per-locale coverage |
| Accessibility (a11y) | `a11y` | Alt text, form labels, keyboard, heading hierarchy |
| Dead endpoints/routes | `deadCode` | Frontend↔backend cross-reference |
| CSS/Tailwind dead classes | `deadCss` | v3 config + v4 @theme/@utility/@variant |
| N+1 query detection | `n1Queries` | ORM queries inside loops (6 ORMs) |
| Vulnerability scanning | `vulnerabilities` | npm/pip/cargo/composer/go audit |
| WebSocket detection | Endpoint `protocol: websocket` | Tagged, not swept |
| API versioning | `apiVersioning` | URL/header strategy, deprecation |
| Migration drift | `migrationDrift` | Alembic/Django/Prisma/Laravel/Diesel |
| Rate limiting | `rateLimiting` | Protected vs unprotected endpoints |
| Security headers | Findings `category: security` | HSTS, CSP, CORS, cookies |
| Response time percentiles | Metadata `responseTimePercentiles` | p50/p95/p99 per endpoint |
| Visual regression | Findings `category: visual` | Pixel-diff vs baseline screenshots |
| OpenAPI auto-gen | Endpoints + schemas | From code annotations |
| Parallel manifest gen | N/A | 4 sub-agents for faster generation |

## Auth methods (5)

JWT, NextAuth/session, API key, OAuth PKCE, none.

## ORM cascade detection (9)

SQLAlchemy, Django ORM, Prisma, TypeORM, Mongoose, Diesel, SeaORM, GORM, Eloquent.

## Output path

Write JSON to the path given by orchestrator (or default `sentinel-manifest.json`).

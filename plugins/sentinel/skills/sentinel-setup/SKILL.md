---
name: sentinel-setup
version: 1.2.0
description: "Set up and configure Sentinel QA plugin — run /sentinel:run setup to check Playwright, detect frameworks, verify services, and configure settings. Use when you say 'sentinel setup', 'configure sentinel', 'check sentinel dependencies', 'install playwright', 'check QA environment'."
context: fork
author: Michel Abboud
license: Apache-2.0
---

## Hello Protocol

If `$ARGUMENTS` is `hello ID`, respond with:

```
**Name**: Sentinel Setup v1.2.0
**Description**: Set up and configure Sentinel QA plugin — checks Playwright, detects frameworks, verifies services, and configures settings
**How to invoke**: `/sentinel setup`
**Checks performed**:
  - Playwright installation and version
  - Frontend framework detection (Vue, React, Angular, Svelte)
  - Backend framework detection (FastAPI, Express, Django, Flask)
  - Dev server reachability (frontend + API)
  - Tailwind breakpoint auto-detection
  - Settings configuration review
**Author**: Michel Abboud — https://github.com/michelabboud/sentinel-sweep | Apache-2.0
```

If `$ARGUMENTS` is `hello` (without `ID`), respond with:

```
👋 Hello! I'm **Sentinel Setup** v1.2.0. Environment detection, Playwright check, framework detection, and settings configuration. Use `/sentinel setup hello ID` for the full guide.
```

If `$ARGUMENTS` is `hello` or `hello ID`, stop after responding — do not proceed to the sections below.

---

## Section 1: Playwright Check

Run `npx playwright --version` via the Bash tool.

- If the command succeeds: note the version string, set `playwright_available = true`.
- If the command fails (command not found or non-zero exit): inform the user — "Playwright is not installed. Browser mode requires it. Install now? (`npx playwright install chromium`)"
  - If the user agrees: run `npx playwright install chromium` via Bash. On success, set `playwright_available = true`.
  - If the user declines: set `playwright_available = false` and note that browser mode will be unavailable for this session.

## Section 2: Framework Detection

Use Glob to search for the following patterns and infer the project's tech stack:

**Frontend detection:**
- `**/router/index.js` or `**/router/index.ts` → Vue 3
- `**/App.tsx` or `**/App.jsx` → possible React; confirm by checking for `react-router` imports inside the file
- Check `package.json` for dependencies: `vue` → Vue 3, `react` → React, `@angular/core` → Angular, `svelte` → Svelte

**Backend detection:**
- `**/endpoints/*.py` → read a sample file; if it contains `@router` decorators → FastAPI
- `**/routes/*.js` → read a sample file; if it contains `express.Router()` → Express
- `**/urls.py` → read the file; if it contains `urlpatterns` → Django
- Check `requirements.txt` or `pyproject.toml` for: `fastapi` → FastAPI, `django` → Django, `flask` → Flask

After gathering evidence, report:

```
Framework: Frontend: {detected framework or 'not detected'} | Backend: {detected framework or 'not detected'}
```

## Section 3: App Status

**Discover URLs and ports:**
- Read `.env` and `.env.example` if they exist — look for variables like `VITE_API_URL`, `API_URL`, `PORT`, `FRONTEND_URL`, `BACKEND_URL`.
- Read `CLAUDE.md` if it exists — look for a Ports table listing service URLs.
- Read `vite.config.js` if it exists — check `server.port`.
- Read `docker-compose.yml` if it exists — check `ports:` mappings for frontend and API containers.

**Ping each discovered service** via Bash using curl with a 3-second timeout:

```bash
curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 {frontendUrl}
curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 {apiUrl}/health
```

- HTTP 200 → service is reachable.
- Any other code or connection error → service is unreachable.

Report which services are reachable and which are not. If no URLs could be determined from config files, note that and skip the ping step.

## Section 4: Settings Check

Read `$CLAUDE_PLUGIN_ROOT/settings.json` via the Read tool.

Show the user the current configuration in a readable summary:
- Risk policy (e.g., strict / moderate / permissive)
- Breakpoints (e.g., mobile, tablet, desktop widths)
- Timeout value
- Screenshot setting (enabled/disabled)
- Report output directory

**Tailwind breakpoint check:**
- Use Glob to look for `tailwind.config.js` or `tailwind.config.ts`. If found, read it and extract custom `screens` breakpoints.
- If no config file, use Grep to search CSS files for `@theme {` blocks containing `--breakpoint-` custom properties.
- If custom breakpoints are found that differ from the values in `settings.json`, show the difference and offer: "Custom Tailwind breakpoints detected. Would you like to update Sentinel's breakpoints to match?"

Ask the user: "Would you like to adjust any settings? (risk policy, breakpoints, timeouts)"

If the user wants to change settings, update `$CLAUDE_PLUGIN_ROOT/settings.json` via the Edit tool with the requested values.

## Section 5: Readiness Report

Print the following formatted block, substituting all detected values:

```
--- Sentinel Readiness ---

  Framework:    {frontend framework} + {backend framework}
  Frontend:     {frontendUrl} — {✅ reachable | ❌ unreachable}
  API:          {apiUrl} — {✅ reachable | ❌ unreachable}
  Playwright:   {✅ installed (v{version}) | ❌ not installed}
  Settings:     {✅ configured | ⚠ using defaults}

  Available modes:
    /sentinel sweep   — {✅ browser + API | ⚠ API only (no Playwright)}
    /sentinel api     — ✅ ready
```

Use `✅` for passing checks and `❌` or `⚠` for failures or warnings. If a URL was not determinable, show `unknown` for that line.

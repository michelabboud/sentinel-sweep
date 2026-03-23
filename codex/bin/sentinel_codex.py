#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse
from pathlib import Path
from typing import Any


DEFAULTS = {
    "riskPolicy": {"maxRiskLevel": "medium", "alwaysSkip": [], "alwaysAllow": []},
    "breakpoints": [375, 768, 1280],
    "responseTimeout": 5000,
    "screenshotOnError": True,
    "reportDir": ".sentinal",
    "browser": {"headless": True, "browserType": "chromium"},
    "auth": {"credentialsSource": "manifest"},
    "emptyContainerSelectors": ["[data-sentinel-content]", "main", ".card-body"],
    "services": [],
    "target": {"sourcePath": "."},
    "severityPolicy": {"minReportSeverity": "info"},
    "securityPolicy": {
        "enabled": True,
        "requireAuthForApi": True,
        "blockDestructiveByDefault": True,
        "allowDestructive": False,
        "maxAllowedEndpointRisk": "high",
        "allowNonLocalApiBase": False,
        "allowedApiHosts": ["localhost", "127.0.0.1", "::1"],
    },
    "scoringPolicy": {
        "methodWeights": {"GET": 0, "POST": 25, "PUT": 30, "PATCH": 30, "DELETE": 60},
        "thresholds": {"safeMax": 25, "mediumMax": 50, "highMax": 75},
    },
}
SEVERITY_RANK = {"critical": 4, "error": 3, "warning": 2, "info": 1}
RISK_RANK = {"safe": 1, "medium": 2, "high": 3, "critical": 4}
ACTIVE_SCORING_POLICY = DEFAULTS["scoringPolicy"]


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_id_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")


def wait_for_file(path: Path, timeout_s: float = 30.0, poll_s: float = 0.2) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if path.exists():
            return True
        time.sleep(poll_s)
    return path.exists()


def check_tool(cmd: list[str]) -> tuple[bool, str]:
    try:
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if proc.returncode == 0:
            out = (proc.stdout or proc.stderr).strip()
            return True, out.splitlines()[0] if out else "ok"
        return False, (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
    except FileNotFoundError:
        return False, "not found"


def detect_app_name(repo_root: Path) -> str:
    pkg = repo_root / "package.json"
    if pkg.exists():
        try:
            name = load_json(pkg, {}).get("name")
            if isinstance(name, str) and name.strip():
                return name
        except Exception:
            pass
    pyproject = repo_root / "pyproject.toml"
    if pyproject.exists():
        for line in pyproject.read_text(encoding="utf-8", errors="ignore").splitlines():
            s = line.strip()
            if s.startswith("name") and "=" in s:
                return s.split("=", 1)[1].strip().strip('"').strip("'")
    return repo_root.name


def state_root() -> Path:
    base = Path(os.getenv("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
    root = base / "sentinel-codex"
    root.mkdir(parents=True, exist_ok=True)
    return root


def repo_key(repo_root: Path) -> str:
    digest = hashlib.sha1(str(repo_root.resolve()).encode("utf-8")).hexdigest()[:8]
    return f"{repo_root.name}-{digest}"


def local_settings_path(repo_root: Path) -> Path:
    p = state_root() / "profiles" / f"{repo_key(repo_root)}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def method_risk(method: str) -> tuple[int, str]:
    policy = ACTIVE_SCORING_POLICY or DEFAULTS["scoringPolicy"]
    weights = policy.get("methodWeights", DEFAULTS["scoringPolicy"]["methodWeights"])
    thresholds = policy.get("thresholds", DEFAULTS["scoringPolicy"]["thresholds"])
    base = int(weights.get(method.upper(), 0))
    safe_max = int(thresholds.get("safeMax", 25))
    medium_max = int(thresholds.get("mediumMax", 50))
    high_max = int(thresholds.get("highMax", 75))
    if base <= safe_max:
        return base, "safe"
    if base <= medium_max:
        return base, "medium"
    if base <= high_max:
        return base, "high"
    return base, "critical"


def _route_entry(path: str) -> dict[str, Any]:
    score, level = method_risk("GET")
    normalized = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", path)
    return {
        "path": normalized,
        "view": "unknown",
        "requiredRole": None,
        "riskLevel": level,
        "riskScore": score,
        "params": None,
        "description": None,
        "manual": False,
    }


def _endpoint_entry(method: str, path: str) -> dict[str, Any]:
    score, level = method_risk(method.upper())
    normalized = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", path)
    return {
        "method": method.upper(),
        "path": normalized,
        "requiredRole": None,
        "riskLevel": level,
        "riskScore": score,
        "responseSchema": None,
        "description": None,
        "sideEffects": [],
        "requiresConfirm": False,
        "params": None,
        "manual": False,
    }


def detect_frameworks(source_root: Path) -> tuple[str, str]:
    frontend = "none"
    backend = "none"

    pkg = source_root / "package.json"
    if pkg.exists():
        try:
            p = load_json(pkg, {})
            deps = {}
            deps.update(p.get("dependencies", {}))
            deps.update(p.get("devDependencies", {}))
            if "next" in deps:
                frontend = "nextjs"
            elif "nuxt" in deps:
                frontend = "nuxt"
            elif "vue" in deps:
                frontend = "vue"
            elif "react" in deps:
                frontend = "react"
            elif "@remix-run/react" in deps:
                frontend = "remix"
            elif "svelte" in deps:
                frontend = "svelte"
            elif "@sveltejs/kit" in deps:
                frontend = "sveltekit"
            elif "@angular/core" in deps:
                frontend = "angular"

            if "@nestjs/core" in deps:
                backend = "nestjs"
            elif "express" in deps:
                backend = "express"
            elif "fastify" in deps:
                backend = "fastify"
            elif "koa" in deps:
                backend = "koa"
            elif "@hapi/hapi" in deps:
                backend = "hapi"
        except Exception:
            pass

    if frontend == "none":
        if list(source_root.rglob("router/index.ts")) or list(source_root.rglob("router/index.js")):
            frontend = "vue"
        elif list(source_root.rglob("src/App.tsx")) or list(source_root.rglob("src/App.jsx")):
            frontend = "react"
        elif list(source_root.rglob("src/routes/+page.svelte")):
            frontend = "sveltekit"
        elif (source_root / "pages").exists() or (source_root / "src/pages").exists():
            frontend = "nextjs"

    req = source_root / "requirements.txt"
    pyproject = source_root / "pyproject.toml"
    req_text = req.read_text(encoding="utf-8", errors="ignore") if req.exists() else ""
    pyproject_text = pyproject.read_text(encoding="utf-8", errors="ignore") if pyproject.exists() else ""
    hay = (req_text + "\n" + pyproject_text).lower()
    if "fastapi" in hay:
        backend = "fastapi"
    elif "django" in hay:
        backend = "django"
    elif "flask" in hay:
        backend = "flask"

    if backend == "none":
        for p in source_root.rglob("*.py"):
            t = p.read_text(encoding="utf-8", errors="ignore")
            if "@router.get(" in t or "@router.post(" in t or "@router.put(" in t or "@router.patch(" in t or "@router.delete(" in t:
                backend = "fastapi"
                break

    if backend == "none":
        for p in list(source_root.rglob("routes/*.js")) + list(source_root.rglob("routes/*.ts")):
            t = p.read_text(encoding="utf-8", errors="ignore")
            if "express.Router(" in t or "router.get(" in t or "router.post(" in t:
                backend = "express"
                break

    # Go framework detection
    if backend == "none":
        gomod = source_root / "go.mod"
        if gomod.exists():
            gm = gomod.read_text(encoding="utf-8", errors="ignore")
            if "github.com/gin-gonic/gin" in gm:
                backend = "gin"
            elif "github.com/labstack/echo" in gm:
                backend = "echo"
            elif "github.com/gofiber/fiber" in gm:
                backend = "fiber"
            elif "github.com/go-chi/chi" in gm:
                backend = "chi"

    # Rust framework detection
    if backend == "none":
        for cargo in source_root.rglob("Cargo.toml"):
            ct = cargo.read_text(encoding="utf-8", errors="ignore")
            if re.search(r'^\s*axum\s*=', ct, flags=re.MULTILINE):
                backend = "axum"
                break
            if re.search(r'^\s*actix-web\s*=', ct, flags=re.MULTILINE):
                backend = "actix"
                break
            if re.search(r'^\s*warp\s*=', ct, flags=re.MULTILINE):
                backend = "warp"
                break

    # Java / Android / C# hints
    if backend == "none":
        for gradle in list(source_root.rglob("build.gradle")) + list(source_root.rglob("build.gradle.kts")):
            gt = gradle.read_text(encoding="utf-8", errors="ignore").lower()
            if "spring-boot-starter-web" in gt:
                backend = "spring"
                break
            if "com.android.application" in gt or "com.android.library" in gt:
                backend = "android"
                break
            if "retrofit" in gt:
                backend = "android-retrofit"
                break
    if backend == "none":
        for csproj in source_root.rglob("*.csproj"):
            cst = csproj.read_text(encoding="utf-8", errors="ignore").lower()
            if "microsoft.aspnetcore" in cst:
                backend = "aspnet"
                break

    return frontend, backend


def detect_base_urls(source_root: Path) -> tuple[str, str]:
    base_url = "http://localhost:3000"
    api_base_url = "http://localhost:8000"
    for name in [".env", ".env.local", ".env.example"]:
        p = source_root / name
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k in {"FRONTEND_URL", "VITE_BASE_URL", "BASE_URL"} and v:
                base_url = v
            if k in {"VITE_API_URL", "API_URL", "BACKEND_URL"} and v:
                api_base_url = v
            if k in {"NEXT_PUBLIC_API_URL", "PUBLIC_API_URL", "NUXT_PUBLIC_API_BASE"} and v:
                api_base_url = v
            if k == "PORT" and v.isdigit():
                base_url = f"http://localhost:{v}"
            if k in {"API_PORT", "BACKEND_PORT"} and v.isdigit():
                api_base_url = f"http://localhost:{v}"
    return base_url, api_base_url


def extract_routes(source_root: Path, frontend: str) -> list[dict[str, Any]]:
    routes: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(path: str) -> None:
        if not path:
            return
        p = path.strip()
        if p in seen:
            return
        seen.add(p)
        routes.append(_route_entry(p))

    # Vue router
    for rf in list(source_root.rglob("router/index.ts")) + list(source_root.rglob("router/index.js")):
        text = rf.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"path\s*:\s*['\"]([^'\"]+)['\"]", text):
            add(m.group(1))

    # React Router
    for tsx in list(source_root.rglob("*.tsx")) + list(source_root.rglob("*.jsx")):
        text = tsx.read_text(encoding="utf-8", errors="ignore")
        if "react-router" not in text and "<Route" not in text:
            continue
        for m in re.finditer(r"<Route[^>]*\spath\s*=\s*['\"]([^'\"]+)['\"]", text):
            add(m.group(1))
        for m in re.finditer(r"path:\s*['\"]([^'\"]+)['\"]", text):
            add(m.group(1))

    # Angular routes
    for ts in source_root.rglob("*.ts"):
        text = ts.read_text(encoding="utf-8", errors="ignore")
        if "Routes" not in text and "RouterModule.forRoot" not in text:
            continue
        for m in re.finditer(r"path\s*:\s*['\"]([^'\"]*)['\"]", text):
            route = "/" + m.group(1).lstrip("/")
            add(route if route != "/" else "/")

    # Next.js / Nuxt pages-based routes
    for base in [source_root / "pages", source_root / "src/pages", source_root / "app", source_root / "src/app"]:
        if not base.exists():
            continue
        for f in base.rglob("*"):
            if not f.is_file():
                continue
            if not any(str(f).endswith(ext) for ext in [".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte"]):
                continue
            rel = f.relative_to(base)
            s = str(rel).replace("\\", "/")
            s = re.sub(r"\.(tsx|jsx|ts|js|vue|svelte)$", "", s)
            s = s.replace("/index", "")
            s = s.replace("[...", "{").replace("]", "}")
            s = re.sub(r"\[([^\]]+)\]", r"{\1}", s)
            if s.endswith("/page"):
                s = s[: -len("/page")]
            route = "/" + s.strip("/")
            add(route if route != "" else "/")

    # SvelteKit routes
    sk = source_root / "src/routes"
    if sk.exists():
        for f in sk.rglob("+page.svelte"):
            rel = f.relative_to(sk).parent
            s = str(rel).replace("\\", "/")
            s = re.sub(r"\[\.\.\.([^\]]+)\]", r"{\1}", s)
            s = re.sub(r"\[([^\]]+)\]", r"{\1}", s)
            route = "/" + s.strip("/")
            add(route if route != "" else "/")

    return routes


def extract_endpoints(source_root: Path, backend: str) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(method: str, path: str) -> None:
        m = method.upper()
        p = path.strip()
        if not p:
            return
        key = (m, p)
        if key in seen:
            return
        seen.add(key)
        endpoints.append(_endpoint_entry(m, p))

    # Python: FastAPI
    dec_re = re.compile(r"@router\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]")
    prefix_re = re.compile(r"APIRouter\(\s*[^)]*prefix\s*=\s*['\"]([^'\"]+)['\"]")
    for py in source_root.rglob("*.py"):
        text = py.read_text(encoding="utf-8", errors="ignore")
        if "@router." in text:
            prefix = ""
            pm = prefix_re.search(text)
            if pm:
                prefix = pm.group(1)
            for m in dec_re.finditer(text):
                full = f"{prefix}{m.group(2)}" if prefix else m.group(2)
                add(m.group(1), full)

        # Flask
        for m in re.finditer(r"@(?:app|bp)\.route\(\s*['\"]([^'\"]+)['\"][^)]*methods\s*=\s*\[([^\]]+)\]", text):
            route = m.group(1)
            methods_blob = m.group(2)
            for mm in re.findall(r"['\"](GET|POST|PUT|PATCH|DELETE)['\"]", methods_blob, flags=re.IGNORECASE):
                add(mm, route)

        # Django urls.py (method unknown -> GET)
        if py.name == "urls.py":
            for m in re.finditer(r"path\(\s*['\"]([^'\"]+)['\"]", text):
                add("GET", "/" + m.group(1).lstrip("/"))
            for m in re.finditer(r"re_path\(\s*r?['\"]([^'\"]+)['\"]", text):
                add("GET", "/" + m.group(1).lstrip("/"))

    # JS/TS: Express, Koa, Fastify, Hapi
    for js in list(source_root.rglob("*.js")) + list(source_root.rglob("*.ts")):
        text = js.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"(?:router|app)\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]", text):
            add(m.group(1), m.group(2))
        for m in re.finditer(r"(?:router)\.(all)\(\s*['\"]([^'\"]+)['\"]", text):
            for mm in ["GET", "POST", "PUT", "PATCH", "DELETE"]:
                add(mm, m.group(2))
        for m in re.finditer(r"(?:fastify)\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]", text):
            add(m.group(1), m.group(2))
        for m in re.finditer(r"(?:server|app)\.route\(\s*['\"]([^'\"]+)['\"],\s*\{\s*method:\s*['\"](GET|POST|PUT|PATCH|DELETE)['\"]", text, flags=re.IGNORECASE):
            add(m.group(2), m.group(1))
        # NestJS decorators
        class_prefix = ""
        cm = re.search(r"@Controller\(\s*['\"]([^'\"]*)['\"]\s*\)", text)
        if cm:
            class_prefix = "/" + cm.group(1).strip("/")
        for meth in ["Get", "Post", "Put", "Patch", "Delete"]:
            for m in re.finditer(rf"@{meth}\(\s*['\"]([^'\"]*)['\"]?\s*\)", text):
                suffix = m.group(1)
                path = (class_prefix + "/" + suffix.strip("/")).replace("//", "/")
                add(meth.upper(), path if path else "/")

    # Rust: axum / actix / warp
    for rs in source_root.rglob("*.rs"):
        text = rs.read_text(encoding="utf-8", errors="ignore")
        # axum .route(\"/x\", get(...))
        for m in re.finditer(r"\.route\(\s*\"([^\"]+)\"\s*,\s*(get|post|put|patch|delete)\b", text):
            add(m.group(2), m.group(1))
        for m in re.finditer(r"\.route\(\s*\"([^\"]+)\"\s*,\s*routing::(get|post|put|patch|delete)\b", text):
            add(m.group(2), m.group(1))
        # actix macros
        for meth in ["get", "post", "put", "patch", "delete"]:
            for m in re.finditer(rf"#\[{meth}\(\s*\"([^\"]+)\"\s*\)\]", text):
                add(meth, m.group(1))
        # warp path! macros (method unknown -> GET)
        for m in re.finditer(r"warp::path!\(\s*\"([^\"]+)\"\s*\)", text):
            add("GET", "/" + m.group(1).lstrip("/"))

    # Go: gin/echo/fiber/chi/net-http/gorilla
    for go in source_root.rglob("*.go"):
        text = go.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"\.(GET|POST|PUT|PATCH|DELETE)\(\s*\"([^\"]+)\"", text):
            add(m.group(1), m.group(2))
        for m in re.finditer(r"http\.HandleFunc\(\s*\"([^\"]+)\"", text):
            add("GET", m.group(1))
        for m in re.finditer(r"Handle\(\s*\"([^\"]+)\"\s*,\s*[^\\n]*Methods\(\s*\"(GET|POST|PUT|PATCH|DELETE)\"", text):
            add(m.group(2), m.group(1))

    # Java Spring
    for java in source_root.rglob("*.java"):
        text = java.read_text(encoding="utf-8", errors="ignore")
        class_prefix = ""
        cm = re.search(r"@RequestMapping\(\s*\"([^\"]*)\"\s*\)", text)
        if cm:
            class_prefix = "/" + cm.group(1).strip("/")
        mapping_pairs = [("GetMapping", "GET"), ("PostMapping", "POST"), ("PutMapping", "PUT"), ("PatchMapping", "PATCH"), ("DeleteMapping", "DELETE")]
        for ann, method in mapping_pairs:
            for m in re.finditer(rf"@{ann}\(\s*\"([^\"]*)\"\s*\)", text):
                suffix = m.group(1)
                path = (class_prefix + "/" + suffix.strip("/")).replace("//", "/")
                add(method, path if path else "/")

        # Java/Android Retrofit interfaces
        for ann, method in mapping_pairs:
            for m in re.finditer(rf"@{ann[:-7] if ann.endswith('Mapping') else ann}\(\s*\"([^\"]+)\"\s*\)", text):
                add(method, m.group(1))
        for ann, method in [("GET", "GET"), ("POST", "POST"), ("PUT", "PUT"), ("PATCH", "PATCH"), ("DELETE", "DELETE")]:
            for m in re.finditer(rf"@{ann}\(\s*\"([^\"]+)\"\s*\)", text):
                add(method, m.group(1))

    # Kotlin Android / Ktor / Retrofit
    for kt in source_root.rglob("*.kt"):
        text = kt.read_text(encoding="utf-8", errors="ignore")
        for ann, method in [("GET", "GET"), ("POST", "POST"), ("PUT", "PUT"), ("PATCH", "PATCH"), ("DELETE", "DELETE")]:
            for m in re.finditer(rf"@{ann}\(\s*\"([^\"]+)\"\s*\)", text):
                add(method, m.group(1))
        for m in re.finditer(r'route\(\s*"([^"]+)"\s*\)', text):
            add("GET", m.group(1))
        for ann, method in [("get", "GET"), ("post", "POST"), ("put", "PUT"), ("patch", "PATCH"), ("delete", "DELETE")]:
            for m in re.finditer(rf"\b{ann}\(\s*\"([^\"]+)\"\s*\)", text):
                add(method, m.group(1))

    # C# ASP.NET (controllers and minimal APIs)
    for cs in source_root.rglob("*.cs"):
        text = cs.read_text(encoding="utf-8", errors="ignore")
        class_prefix = ""
        cm = re.search(r'\[Route\(\s*"([^"]*)"\s*\)\]', text)
        if cm:
            class_prefix = "/" + cm.group(1).strip("/")

        for attr, method in [("HttpGet", "GET"), ("HttpPost", "POST"), ("HttpPut", "PUT"), ("HttpPatch", "PATCH"), ("HttpDelete", "DELETE")]:
            for m in re.finditer(rf'\[{attr}(?:\(\s*"([^"]*)"\s*\))?\]', text):
                suffix = m.group(1) or ""
                path = (class_prefix + "/" + suffix.strip("/")).replace("//", "/")
                if path == "/" and suffix == "":
                    path = class_prefix if class_prefix else "/"
                add(method, path if path else "/")

        for m in re.finditer(r'\b(?:app|group|endpoints)\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"', text):
            add(m.group(1).upper(), m.group(2))

    # C / C++ common HTTP frameworks
    for cpp in list(source_root.rglob("*.c")) + list(source_root.rglob("*.cc")) + list(source_root.rglob("*.cpp")) + list(source_root.rglob("*.h")) + list(source_root.rglob("*.hpp")):
        text = cpp.read_text(encoding="utf-8", errors="ignore")
        # Crow
        for m in re.finditer(r'CROW_ROUTE\([^,]+,\s*"([^"]+)"\)', text):
            add("GET", m.group(1))
        # cpp-httplib
        for m in re.finditer(r'\.(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"', text):
            add(m.group(1).upper(), m.group(2))
        # Pistache
        for m in re.finditer(r'Routes::(Get|Post|Put|Patch|Delete)\([^,]+,\s*"([^"]+)"', text):
            add(m.group(1).upper(), m.group(2))
        # Oat++
        for m in re.finditer(r'ENDPOINT\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"', text):
            add(m.group(1), m.group(2))

    return endpoints


def endpoint_method_stats(endpoints: list[dict[str, Any]]) -> dict[str, int]:
    stats: dict[str, int] = {"GET": 0, "POST": 0, "PUT": 0, "PATCH": 0, "DELETE": 0}
    for ep in endpoints:
        m = str(ep.get("method", "")).upper()
        if m in stats:
            stats[m] += 1
        elif m:
            stats[m] = stats.get(m, 0) + 1
    return stats


def route_shape_stats(routes: list[dict[str, Any]]) -> tuple[int, int]:
    static_count = 0
    dynamic_count = 0
    for r in routes:
        p = str(r.get("path", ""))
        if "{" in p and "}" in p:
            dynamic_count += 1
        else:
            static_count += 1
    return static_count, dynamic_count


def target_root_from_settings(repo_root: Path, settings: dict[str, Any]) -> Path:
    source = str(settings.get("target", {}).get("sourcePath", "."))
    if os.path.isabs(source):
        return Path(source).resolve()
    return (repo_root / source).resolve()


def ensure_report_base(repo_root: Path, settings: dict[str, Any]) -> Path:
    report_dir = str(settings.get("reportDir", ".sentinal"))
    # Backward compatibility: upgrade old default to requested local folder.
    if report_dir == "sentinel-reports":
        report_dir = ".sentinal"
    if os.path.isabs(report_dir):
        report_base = Path(report_dir).resolve()
    else:
        report_base = target_root_from_settings(repo_root, settings) / report_dir
    report_base.mkdir(parents=True, exist_ok=True)
    return report_base


def effective_risk(settings: dict[str, Any], safe_only: bool, risk_override: str | None) -> str:
    if safe_only:
        return "safe"
    if risk_override:
        return risk_override
    return settings.get("riskPolicy", {}).get("maxRiskLevel", "medium")


def effective_min_severity(settings: dict[str, Any], severity_override: str | None = None) -> str:
    if severity_override in SEVERITY_RANK:
        return severity_override
    val = settings.get("severityPolicy", {}).get("minReportSeverity", "info")
    return val if val in SEVERITY_RANK else "info"


def filter_findings_by_severity(findings: list[dict[str, Any]], min_severity: str) -> list[dict[str, Any]]:
    threshold = SEVERITY_RANK.get(min_severity, 1)
    return [f for f in findings if SEVERITY_RANK.get(str(f.get("severity", "info")), 1) >= threshold]


def security_preflight(manifest: dict[str, Any], settings: dict[str, Any]) -> tuple[bool, str]:
    policy = settings.get("securityPolicy", {})
    if not policy.get("enabled", True):
        return True, "security policy disabled"

    api_base = str(manifest.get("app", {}).get("apiBaseUrl", "") or "")
    if not api_base:
        return True, "no apiBaseUrl"

    if not policy.get("allowNonLocalApiBase", False):
        host = (urlparse(api_base).hostname or "").lower()
        allowed_hosts = {str(h).lower() for h in policy.get("allowedApiHosts", ["localhost", "127.0.0.1", "::1"])}
        if host and host not in allowed_hosts and not host.endswith(".local"):
            return False, f"apiBaseUrl host '{host}' is not allowed by securityPolicy.allowedApiHosts"
    return True, "ok"


def ensure_manifest(repo_root: Path, report_base: Path, run_dir: Path, settings: dict[str, Any], reuse_manifest: bool) -> Path:
    manifest_path = run_dir / "sentinel-manifest.json"
    latest_manifest = report_base / "latest" / "sentinel-manifest.json"
    if reuse_manifest and latest_manifest.exists():
        shutil.copy2(latest_manifest, manifest_path)
        return manifest_path

    target_source = settings.get("target", {}).get("sourcePath", ".")
    source_root = (repo_root / target_source).resolve()
    global ACTIVE_SCORING_POLICY
    ACTIVE_SCORING_POLICY = settings.get("scoringPolicy", DEFAULTS["scoringPolicy"])
    app_name = detect_app_name(source_root if source_root.exists() else repo_root)
    services = settings.get("services", []) or []
    base_url, api_base_url = detect_base_urls(source_root if source_root.exists() else repo_root)
    frontend, backend = detect_frameworks(source_root if source_root.exists() else repo_root)
    if services and isinstance(services, list):
        first = services[0]
        base_url = first.get("baseUrl", base_url)
        api_base_url = first.get("apiBaseUrl", api_base_url)

    manifest = {
        "generatedAt": utc_now(),
        "app": {
            "name": app_name,
            "framework": {"frontend": frontend, "backend": backend},
            "baseUrl": base_url,
            "apiBaseUrl": api_base_url,
        },
        "auth": {
            "method": "none",
            "loginEndpoint": None,
            "roleHierarchy": ["admin", "user"],
            "roles": {},
        },
        "routes": extract_routes(source_root if source_root.exists() else repo_root, frontend),
        "endpoints": extract_endpoints(source_root if source_root.exists() else repo_root, backend),
        "crudFlows": [],
        "schemas": {},
        "breakpoints": settings.get("breakpoints", DEFAULTS["breakpoints"]),
        "riskPolicy": settings.get("riskPolicy", DEFAULTS["riskPolicy"]),
    }
    save_json(manifest_path, manifest)
    return manifest_path


def write_api_findings(run_dir: Path, manifest: dict[str, Any], risk_level: str, dry_run: bool, settings: dict[str, Any]) -> Path:
    findings_path = run_dir / "api-findings.json"
    endpoints = list(manifest.get("endpoints", []))
    findings: list[dict[str, Any]] = []
    tested_endpoints = endpoints

    policy = settings.get("securityPolicy", {})
    max_allowed = str(policy.get("maxAllowedEndpointRisk", "high"))
    max_rank = RISK_RANK.get(max_allowed, RISK_RANK["high"])
    block_destructive = bool(policy.get("blockDestructiveByDefault", True))
    allow_destructive = bool(policy.get("allowDestructive", False))
    require_auth = bool(policy.get("requireAuthForApi", True))

    # Security gate filtering (no DB/data damage posture)
    gated: list[dict[str, Any]] = []
    for ep in endpoints:
        method = str(ep.get("method", "GET")).upper()
        ep_risk = str(ep.get("riskLevel", "safe"))
        ep_rank = RISK_RANK.get(ep_risk, RISK_RANK["safe"])
        path = str(ep.get("path", ""))

        blocked = False
        reason = ""
        if block_destructive and not allow_destructive and method in {"DELETE", "PUT", "PATCH"}:
            blocked = True
            reason = "blocked destructive method by securityPolicy.blockDestructiveByDefault"
        if ep_rank > max_rank:
            blocked = True
            reason = f"endpoint risk '{ep_risk}' exceeds securityPolicy.maxAllowedEndpointRisk '{max_allowed}'"

        if blocked:
            findings.append(
                {
                    "severity": "info",
                    "category": "security",
                    "endpoint": f"{method} {path}",
                    "route": None,
                    "role": None,
                    "message": f"Skipped endpoint for safety: {reason}",
                    "expected": f"Risk <= {max_allowed} and non-destructive",
                    "actual": f"{method} {path} (risk={ep_risk})",
                    "fileRef": None,
                    "fixSuggestion": "Adjust securityPolicy only in isolated dev/test environments",
                    "breakpoint": None,
                    "screenshot": None,
                }
            )
        else:
            gated.append(ep)

    tested_endpoints = gated

    if require_auth and str(manifest.get("auth", {}).get("method", "none")) == "none":
        findings.append(
            {
                "severity": "warning",
                "category": "security",
                "endpoint": None,
                "route": None,
                "role": None,
                "message": "Auth is not configured in manifest while securityPolicy.requireAuthForApi=true",
                "expected": "Manifest auth method configured",
                "actual": "auth.method=none",
                "fileRef": None,
                "fixSuggestion": "Run setup with auth-aware project context or provide manifest auth overrides",
                "breakpoint": None,
                "screenshot": None,
            }
        )

    if dry_run:
        findings.append(
            {
                "severity": "info",
                "category": "health",
                "endpoint": None,
                "route": None,
                "role": None,
                "message": "Dry-run enabled: API tests were planned but not executed",
                "expected": None,
                "actual": None,
                "fileRef": None,
                "fixSuggestion": None,
                "breakpoint": None,
                "screenshot": None,
            }
        )
    elif not tested_endpoints:
        findings.append(
            {
                "severity": "warning",
                "category": "health",
                "endpoint": None,
                "route": None,
                "role": None,
                "message": "No endpoints available after security/risk gating",
                "expected": "At least one safe endpoint",
                "actual": "0 eligible endpoints",
                "fileRef": None,
                "fixSuggestion": "Review securityPolicy and riskPolicy for this environment",
                "breakpoint": None,
                "screenshot": None,
            }
        )

    out = {
        "metadata": {
            "mode": "api",
            "rolesTested": manifest.get("auth", {}).get("roleHierarchy", []),
            "endpointsTested": 0 if dry_run else len(tested_endpoints),
            "routesTested": 0,
            "riskLevel": risk_level,
            "securityPolicy": policy,
            "startedAt": utc_now(),
            "finishedAt": utc_now(),
        },
        "findings": findings,
    }
    save_json(findings_path, out)
    return findings_path


def write_browser_findings(run_dir: Path, manifest: dict[str, Any], risk_level: str, dry_run: bool) -> Path:
    findings_path = run_dir / "browser-findings.json"
    routes = manifest.get("routes", [])
    findings: list[dict[str, Any]] = []

    if dry_run:
        findings.append(
            {
                "severity": "info",
                "category": "health",
                "endpoint": None,
                "route": None,
                "role": None,
                "message": "Dry-run enabled: browser tests were planned but not executed",
                "expected": None,
                "actual": None,
                "fileRef": None,
                "fixSuggestion": None,
                "breakpoint": None,
                "screenshot": None,
            }
        )
    elif not routes:
        findings.append(
            {
                "severity": "warning",
                "category": "layout",
                "endpoint": None,
                "route": None,
                "role": None,
                "message": "No routes were discovered in manifest",
                "expected": "At least one route",
                "actual": "0 routes",
                "fileRef": None,
                "fixSuggestion": "Run manifest generation after frontend routes exist",
                "breakpoint": None,
                "screenshot": None,
            }
        )

    out = {
        "metadata": {
            "mode": "browser",
            "rolesTested": manifest.get("auth", {}).get("roleHierarchy", []),
            "endpointsTested": 0,
            "routesTested": 0 if dry_run else len(routes),
            "riskLevel": risk_level,
            "startedAt": utc_now(),
            "finishedAt": utc_now(),
        },
        "findings": findings,
    }
    save_json(findings_path, out)
    return findings_path


def collect_findings(paths: list[Path]) -> list[dict[str, Any]]:
    all_findings: list[dict[str, Any]] = []
    for p in paths:
        if p.exists():
            doc = load_json(p, {})
            all_findings.extend(doc.get("findings", []))
    dedup: dict[tuple[str, str, str], dict[str, Any]] = {}
    for f in all_findings:
        key = (str(f.get("endpoint") or ""), str(f.get("role") or ""), str(f.get("message") or ""))
        if key not in dedup:
            dedup[key] = f
            continue
        if SEVERITY_RANK.get(str(f.get("severity")), 0) > SEVERITY_RANK.get(str(dedup[key].get("severity")), 0):
            dedup[key] = f
    return list(dedup.values())


def write_report(run_dir: Path, mode: str, risk_level: str, findings_paths: list[Path], settings: dict[str, Any], severity_override: str | None = None) -> Path:
    findings = collect_findings(findings_paths)
    min_sev = effective_min_severity(settings, severity_override)
    filtered_findings = filter_findings_by_severity(findings, min_sev)
    counts = {k: 0 for k in ["critical", "error", "warning", "info"]}
    for f in filtered_findings:
        sev = str(f.get("severity", "info"))
        counts[sev] = counts.get(sev, 0) + 1

    lines = [
        "# Sentinel Sweep Report",
        "",
        f"- Run ID: `{run_dir.name}`",
        f"- Mode: `{mode}`",
        f"- Risk level: `{risk_level}`",
        f"- Min severity: `{min_sev}`",
        f"- Generated at: `{utc_now()}`",
        "",
        "## Summary",
        "",
        f"- Critical: **{counts.get('critical', 0)}**",
        f"- Error: **{counts.get('error', 0)}**",
        f"- Warning: **{counts.get('warning', 0)}**",
        f"- Info: **{counts.get('info', 0)}**",
        "",
        "## Findings",
        "",
    ]

    if not filtered_findings:
        lines.append("No findings.")
    else:
        for i, f in enumerate(filtered_findings, start=1):
            lines.append(f"{i}. [{f.get('severity', 'info')}] {f.get('category', 'health')} - {f.get('message', '')}")

    report_path = run_dir / "sweep.md"
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report_path


def update_latest(report_base: Path, run_id: str) -> None:
    latest = report_base / "latest"
    if latest.is_symlink() or latest.exists():
        latest.unlink()
    latest.symlink_to(run_id)


def summarize_run_metrics(findings_paths: list[Path]) -> dict[str, Any]:
    findings = collect_findings(findings_paths)
    counts = {"critical": 0, "error": 0, "warning": 0, "info": 0}
    roles: set[str] = set()
    routes_tested = 0
    endpoints_tested = 0
    for p in findings_paths:
        if not p.exists():
            continue
        d = load_json(p, {})
        md = d.get("metadata", {})
        routes_tested += int(md.get("routesTested", 0) or 0)
        endpoints_tested += int(md.get("endpointsTested", 0) or 0)
        for r in md.get("rolesTested", []) or []:
            roles.add(str(r))
    for f in findings:
        sev = str(f.get("severity", "info"))
        counts[sev] = counts.get(sev, 0) + 1
    checks_with_findings = counts["critical"] + counts["error"] + counts["warning"]
    total_checks = max(0, routes_tested + endpoints_tested)
    passed = max(0, total_checks - checks_with_findings)
    denom = max(1, passed + checks_with_findings)
    pass_rate = round((passed / denom) * 100, 1)
    return {
        "counts": counts,
        "roles": sorted(roles),
        "routesTested": routes_tested,
        "endpointsTested": endpoints_tested,
        "passed": passed,
        "passRate": pass_rate,
    }


def append_history(
    report_base: Path,
    run_id: str,
    mode: str,
    risk_level: str,
    findings_paths: list[Path],
    sandbox_mode: bool = False,
    duration: str = "unknown",
) -> None:
    history_path = report_base / "sweep-history.json"
    history = load_json(history_path, {"runs": []})
    metrics = summarize_run_metrics(findings_paths)
    mode_name = "api-only" if mode == "api" else ("browser + api" if mode == "sweep" else mode)
    history["runs"].append(
        {
            "runId": run_id,
            "mode": mode_name,
            "duration": duration,
            "rolesTested": metrics["roles"],
            "routesTested": metrics["routesTested"],
            "endpointsTested": metrics["endpointsTested"],
            "findings": metrics["counts"],
            "passed": metrics["passed"],
            "passRate": metrics["passRate"],
            "sandboxMode": sandbox_mode,
            "timestamp": utc_now(),
            "riskLevel": risk_level,
            "generatedAt": utc_now(),
            "summary": metrics["counts"],
        }
    )
    save_json(history_path, history)


def write_subagent_briefs(
    run_dir: Path,
    command: str,
    risk_level: str,
    dry_run: bool,
    manifest_path: Path,
    findings_paths: list[Path],
    report_path: Path | None,
) -> list[Path]:
    briefs_dir = run_dir / "subagent-briefs"
    briefs_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    common = [
        f"Run ID: {run_dir.name}",
        f"Command: {command}",
        f"Risk level: {risk_level}",
        f"Dry run: {str(dry_run).lower()}",
        f"Manifest path: {manifest_path}",
    ]

    if command in {"manifest", "api", "sweep"}:
        manifest_brief = briefs_dir / "manifest-generator-task.md"
        manifest_brief.write_text(
            "\n".join(
                [
                    "# Sub-agent Task: Manifest Generator",
                    "",
                    *common,
                    "",
                    "Goal:",
                    "Generate or refine sentinel-manifest.json from project sources.",
                    "",
                    "Execution notes:",
                    "- Use read-only codebase analysis first.",
                    "- Prefer deterministic extraction from router/endpoints/schemas.",
                    "- Preserve manual entries when manifest already exists.",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        written.append(manifest_brief)

    if command in {"api", "sweep"}:
        api_brief = briefs_dir / "api-sweeper-task.md"
        api_brief.write_text(
            "\n".join(
                [
                    "# Sub-agent Task: API Sweeper",
                    "",
                    *common,
                    "",
                    "Goal:",
                    "Run API sweep and write api-findings.json for this run.",
                    "",
                    "Execution notes:",
                    "- Enforce risk policy before state-changing operations.",
                    "- Resolve params from lookup/static/env strategies.",
                    "- Output findings in canonical schema shape.",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        written.append(api_brief)

    if command == "sweep":
        browser_brief = briefs_dir / "browser-sweeper-task.md"
        browser_brief.write_text(
            "\n".join(
                [
                    "# Sub-agent Task: Browser Sweeper",
                    "",
                    *common,
                    "",
                    "Goal:",
                    "Run browser sweep and write browser-findings.json for this run.",
                    "",
                    "Execution notes:",
                    "- Execute responsive checks using configured breakpoints.",
                    "- Capture console/network/layout/i18n findings.",
                    "- Save screenshots on actionable failures when enabled.",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        written.append(browser_brief)

    report_brief = briefs_dir / "report-synthesizer-task.md"
    report_brief.write_text(
        "\n".join(
            [
                "# Sub-agent Task: Report Synthesizer",
                "",
                *common,
                f"Report path: {report_path if report_path else '(to be generated)'}",
                f"Findings inputs: {', '.join(str(p) for p in findings_paths) if findings_paths else '(none)'}",
                "",
                "Goal:",
                "Produce a concise sweep report and deduplicate findings by (endpoint, role, message).",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    written.append(report_brief)

    return written


def cmd_setup() -> int:
    print("Sentinel Codex Setup")
    print("- Checking Playwright availability...")
    ok_pw, msg_pw = check_tool(["npx", "playwright", "--version"])
    if ok_pw:
        print(f"- Playwright: OK ({msg_pw})")
    else:
        print("- Playwright: NOT INSTALLED (run: npx playwright install chromium)")

    ok_node, msg_node = check_tool(["node", "--version"])
    print(f"- Node: {'OK' if ok_node else 'MISSING'} ({msg_node})")
    ok_py, msg_py = check_tool(["python3", "--version"])
    print(f"- Python: {'OK' if ok_py else 'MISSING'} ({msg_py})")
    ok_curl, msg_curl = check_tool(["curl", "--version"])
    print(f"- curl: {'OK' if ok_curl else 'MISSING'} ({msg_curl})")
    ok_jq, msg_jq = check_tool(["jq", "--version"])
    print(f"- jq: {'OK' if ok_jq else 'MISSING'} ({msg_jq})")
    return 0


def cmd_setup_config(repo_root: Path, settings: dict[str, Any], positional: list[str]) -> int:
    source = positional[0] if positional else settings.get("target", {}).get("sourcePath", ".")
    source_root = (repo_root / source).resolve() if not os.path.isabs(source) else Path(source).resolve()
    if not source_root.exists():
        print(f"- Target source path not found: {source_root}")
        return 1

    frontend, backend = detect_frameworks(source_root)
    base_url, api_base_url = detect_base_urls(source_root)
    endpoints = extract_endpoints(source_root, backend)
    routes = extract_routes(source_root, frontend)
    ok_pw, msg_pw = check_tool(["npx", "playwright", "--version"])
    ok_node, msg_node = check_tool(["node", "--version"])
    ok_py, msg_py = check_tool(["python3", "--version"])
    ok_curl, msg_curl = check_tool(["curl", "--version"])
    ok_jq, msg_jq = check_tool(["jq", "--version"])

    local_settings = {
        "target": {"sourcePath": str(source_root)},
        "services": settings.get("services", []),
        "detected": {
            "framework": {"frontend": frontend, "backend": backend},
            "baseUrl": base_url,
            "apiBaseUrl": api_base_url,
            "routes": len(routes),
            "endpoints": len(endpoints),
            "capturedAt": utc_now(),
        },
        "setup": {
            "completedAt": utc_now(),
            "tools": {
                "playwright": {"ok": ok_pw, "detail": msg_pw},
                "node": {"ok": ok_node, "detail": msg_node},
                "python3": {"ok": ok_py, "detail": msg_py},
                "curl": {"ok": ok_curl, "detail": msg_curl},
                "jq": {"ok": ok_jq, "detail": msg_jq},
            },
        },
    }
    local_path = local_settings_path(repo_root)
    save_json(local_path, local_settings)
    print(f"- Target source: {source_root}")
    print(f"- Framework: frontend={frontend}, backend={backend}")
    print(f"- URLs: baseUrl={base_url}, apiBaseUrl={api_base_url}")
    print(f"- Discovery: routes={len(routes)}, endpoints={len(endpoints)}")
    print(f"- Saved setup state: {local_path}")

    method_stats = endpoint_method_stats(endpoints)
    route_static, route_dynamic = route_shape_stats(routes)
    print("")
    print("--- Setup Stats ---")
    print(f"  Project:        {source_root}")
    print(f"  Frontend:       {frontend}")
    print(f"  Backend:        {backend}")
    print(f"  Routes total:   {len(routes)}")
    print(f"  Routes static:  {route_static}")
    print(f"  Routes dynamic: {route_dynamic}")
    print(f"  Endpoints total:{len(endpoints)}")
    print(
        "  Endpoint methods:"
        f" GET={method_stats.get('GET', 0)}"
        f" POST={method_stats.get('POST', 0)}"
        f" PUT={method_stats.get('PUT', 0)}"
        f" PATCH={method_stats.get('PATCH', 0)}"
        f" DELETE={method_stats.get('DELETE', 0)}"
    )
    min_sev = effective_min_severity(settings, None)
    sec = settings.get("securityPolicy", {})
    print(f"  Min severity:   {min_sev}")
    print(
        "  Security policy:"
        f" enabled={bool(sec.get('enabled', True))}"
        f" requireAuthForApi={bool(sec.get('requireAuthForApi', True))}"
        f" blockDestructive={bool(sec.get('blockDestructiveByDefault', True))}"
        f" maxAllowedRisk={sec.get('maxAllowedEndpointRisk', 'high')}"
    )

    setup_settings = deep_merge(settings, local_settings)
    report_base = ensure_report_base(repo_root, setup_settings)
    run_id = run_id_now()
    run_dir = report_base / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = ensure_manifest(repo_root, report_base, run_dir, setup_settings, reuse_manifest=False)
    if not wait_for_file(manifest_path, timeout_s=30.0):
        print(f"- Manifest generation failed during setup: {manifest_path}")
        return 1
    setup_risk = effective_risk(setup_settings, False, None)
    report_path = write_report(run_dir, mode="setup", risk_level=setup_risk, findings_paths=[], settings=setup_settings)
    update_latest(report_base, run_id)
    append_history(report_base, run_id, "setup", setup_risk, [])
    print(f"- Setup manifest: {manifest_path}")
    print(f"- Setup report: {report_path}")
    return 0


def cmd_report(report_base: Path, list_mode: bool, severity: str | None, settings: dict[str, Any]) -> int:
    if list_mode:
        runs = sorted([p.name for p in report_base.iterdir() if p.is_dir() and p.name != "latest"], reverse=True)
        if not runs:
            print("No runs found.")
            return 0
        for r in runs:
            print(r)
        return 0

    latest_dir = report_base / "latest"
    latest_manifest = latest_dir / "sentinel-manifest.json"
    latest_report = latest_dir / "sweep.md"

    if not wait_for_file(latest_manifest, timeout_s=30.0):
        print("Latest run manifest is not ready yet. Try again in a moment.")
        return 1

    if not wait_for_file(latest_report, timeout_s=30.0):
        print("No report found. Run sentinel sweep or sentinel api first.")
        return 1

    text = latest_report.read_text(encoding="utf-8", errors="ignore")
    if not severity:
        print(text.rstrip())
        return 0

    sev_levels = ["critical", "error", "warning", "info"]
    if severity not in sev_levels:
        print(text.rstrip())
        return 0

    threshold = SEVERITY_RANK[severity]
    out: list[str] = []
    for line in text.splitlines():
        keep = False
        for sev in sev_levels:
            if f"[{sev}]" in line and SEVERITY_RANK[sev] >= threshold:
                keep = True
        if keep or line.startswith("#") or line.startswith("##") or line.startswith("- Run ID:") or line.startswith("- Mode:") or line.startswith("- Risk level:") or line.startswith("- Min severity:") or line.startswith("- Generated at:"):
            out.append(line)
    print("\n".join(out).rstrip())
    return 0


def cmd_trends(report_base: Path) -> int:
    history = load_json(report_base / "sweep-history.json", {"runs": []})
    runs = history.get("runs", [])
    if not runs:
        print("No sweep history found.")
        return 0

    total = len(runs)
    passing = 0
    for r in runs:
        s = r.get("summary", {})
        if int(s.get("critical", 0)) == 0 and int(s.get("error", 0)) == 0:
            passing += 1

    rate = round((passing / total) * 100, 2)
    print(f"Runs: {total}")
    print(f"Pass-rate (no critical/error): {rate}%")
    print("Recent runs:")
    for r in runs[-10:]:
        s = r.get("summary", {})
        print(
            f"- {r.get('runId')} mode={r.get('mode')} risk={r.get('riskLevel')} "
            f"c={s.get('critical',0)} e={s.get('error',0)} w={s.get('warning',0)} i={s.get('info',0)}"
        )

    trends_brief = report_base / "latest" / "subagent-briefs" / "trends-analyst-task.md"
    trends_brief.parent.mkdir(parents=True, exist_ok=True)
    trends_brief.write_text(
        "# Sub-agent Task: Trends Analyst\n\n"
        "Goal:\n"
        "Analyze sweep-history.json for pass-rate movement and recurring failure categories.\n",
        encoding="utf-8",
    )
    return 0


def load_run_findings(report_base: Path, run_id: str) -> list[dict[str, Any]]:
    run_dir = report_base / run_id
    paths = [run_dir / "api-findings.json", run_dir / "browser-findings.json"]
    return collect_findings(paths)


def finding_key(f: dict[str, Any]) -> tuple[str, str, str]:
    return (str(f.get("endpoint") or ""), str(f.get("role") or ""), str(f.get("message") or ""))


def cmd_diff(report_base: Path, run_ids: list[str]) -> int:
    runs = sorted([p.name for p in report_base.iterdir() if p.is_dir() and p.name != "latest"], reverse=True)
    if len(run_ids) >= 2:
        newer, older = run_ids[0], run_ids[1]
    elif len(run_ids) == 1:
        newer = run_ids[0]
        if newer not in runs:
            print(f"Run not found: {newer}")
            return 1
        idx = runs.index(newer)
        if idx + 1 >= len(runs):
            print("No previous run exists for diff.")
            return 1
        older = runs[idx + 1]
    else:
        if len(runs) < 2:
            print("Need at least 2 runs to diff.")
            return 1
        newer, older = runs[0], runs[1]

    new_findings = load_run_findings(report_base, newer)
    old_findings = load_run_findings(report_base, older)

    new_map = {finding_key(f): f for f in new_findings}
    old_map = {finding_key(f): f for f in old_findings}

    added = [k for k in new_map if k not in old_map]
    fixed = [k for k in old_map if k not in new_map]
    regressed = []
    for k in new_map.keys() & old_map.keys():
        if SEVERITY_RANK.get(str(new_map[k].get("severity")), 0) > SEVERITY_RANK.get(str(old_map[k].get("severity")), 0):
            regressed.append(k)

    print(f"Diff: {older} -> {newer}")
    print(f"- New findings: {len(added)}")
    print(f"- Fixed findings: {len(fixed)}")
    print(f"- Regressions: {len(regressed)}")

    diff_brief = report_base / newer / "subagent-briefs" / "diff-analyst-task.md"
    diff_brief.parent.mkdir(parents=True, exist_ok=True)
    diff_brief.write_text(
        "\n".join(
            [
                "# Sub-agent Task: Diff Analyst",
                "",
                f"Compare older run: {older}",
                f"Against newer run: {newer}",
                "",
                "Goal:",
                "Explain root causes behind new findings and regressions.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


def cmd_clean(report_base: Path, keep: int) -> int:
    runs = sorted([p for p in report_base.iterdir() if p.is_dir() and p.name != "latest"], key=lambda p: p.name, reverse=True)
    to_delete = runs[keep:]
    for p in to_delete:
        shutil.rmtree(p, ignore_errors=True)
        print(f"Removed {p.name}")

    # trim history
    history_path = report_base / "sweep-history.json"
    history = load_json(history_path, {"runs": []})
    keep_names = {p.name for p in runs[:keep]}
    history["runs"] = [r for r in history.get("runs", []) if r.get("runId") in keep_names]
    save_json(history_path, history)

    if runs[:keep]:
        update_latest(report_base, runs[0].name)
    return 0


def cmd_fix(report_base: Path) -> int:
    latest = report_base / "latest"
    if not latest.exists():
        print("No findings to fix. Run sentinel sweep or sentinel api first.")
        return 1

    findings = collect_findings([latest / "api-findings.json", latest / "browser-findings.json"])
    if not findings:
        print("No findings to fix.")
        return 0

    out = latest / "fix-suggestions.md"
    lines = ["# Fix Suggestions", ""]
    for i, f in enumerate(findings, start=1):
        lines.append(f"{i}. [{f.get('severity','info')}] {f.get('message','')}")
        suggestion = f.get("fixSuggestion") or "Investigate route/endpoint and apply corrective patch."
        lines.append(f"   Suggestion: {suggestion}")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    return 0


def usage() -> str:
    return (
        "Sentinel Codex Port\n\n"
        "Usage: sentinel <command> [flags]\n"
        "Workflow: run setup first; other commands are blocked until setup completes.\n"
        "Commands: setup, manifest, api, sweep, report, trends, diff, fix, clean\n"
        "Setup accepts optional source path: sentinel setup /path/to/target-app\n"
        "Flags: --sandbox --dry-run --reuse-manifest --risk-level <safe|medium|high|critical> --safe-only --list --severity <critical|error|warning|info>"
    )


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", nargs="?")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    ns = parser.parse_args()

    if not ns.command:
        print(usage())
        return 1

    command = ns.command
    if command not in {"setup", "manifest", "api", "sweep", "report", "trends", "diff", "fix", "clean"}:
        print(usage())
        return 1

    repo_root = Path(__file__).resolve().parents[2]
    settings_path = repo_root / "settings.json"
    codex_config_path = repo_root / "codex" / "config.json"
    legacy_local_settings_path = repo_root / "codex" / "settings.local.json"
    state_local_settings_path = local_settings_path(repo_root)
    settings = deep_merge(DEFAULTS, load_json(settings_path, {}))
    if codex_config_path.exists():
        settings = deep_merge(settings, load_json(codex_config_path, {}))
    if legacy_local_settings_path.exists():
        settings = deep_merge(settings, load_json(legacy_local_settings_path, {}))
    settings = deep_merge(settings, load_json(state_local_settings_path, {}))
    report_base = ensure_report_base(repo_root, settings)

    # flag parsing
    sandbox = "--sandbox" in ns.rest
    dry_run = "--dry-run" in ns.rest
    reuse_manifest = "--reuse-manifest" in ns.rest
    safe_only = "--safe-only" in ns.rest
    list_mode = "--list" in ns.rest

    severity = None
    risk_override = None
    positional: list[str] = []

    i = 0
    while i < len(ns.rest):
        tok = ns.rest[i]
        if tok == "--severity" and i + 1 < len(ns.rest):
            severity = ns.rest[i + 1]
            i += 2
            continue
        if tok == "--risk-level" and i + 1 < len(ns.rest):
            risk_override = ns.rest[i + 1]
            i += 2
            continue
        if tok.startswith("--"):
            i += 1
            continue
        positional.append(tok)
        i += 1

    risk_level = effective_risk(settings, safe_only, risk_override)

    if command == "setup":
        rc = cmd_setup()
        if rc != 0:
            return rc
        return cmd_setup_config(repo_root, settings, positional)

    setup_state = settings.get("setup", {})
    if not isinstance(setup_state, dict) or not setup_state.get("completedAt"):
        print("Setup required first. Run: sentinel setup /absolute/path/to/target-project")
        return 1

    if command == "report":
        return cmd_report(report_base, list_mode, severity, settings)
    if command == "trends":
        return cmd_trends(report_base)
    if command == "diff":
        return cmd_diff(report_base, positional)
    if command == "clean":
        keep = 5
        if positional:
            try:
                keep = max(1, int(positional[0]))
            except ValueError:
                pass
        return cmd_clean(report_base, keep)
    if command == "fix":
        return cmd_fix(report_base)

    run_id = run_id_now()
    run_dir = report_base / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = ensure_manifest(repo_root, report_base, run_dir, settings, reuse_manifest)
    if not wait_for_file(manifest_path, timeout_s=30.0):
        print(f"Manifest was not ready in time: {manifest_path}")
        return 1
    manifest = load_json(manifest_path, {})
    sec_ok, sec_reason = security_preflight(manifest, settings)
    if not sec_ok:
        print(f"Security preflight blocked execution: {sec_reason}")
        return 1

    findings_paths: list[Path] = []
    mode = command

    if command == "manifest":
        report_path = write_report(run_dir, mode="manifest", risk_level=risk_level, findings_paths=[], settings=settings, severity_override=severity)
        briefs = write_subagent_briefs(
            run_dir=run_dir,
            command=command,
            risk_level=risk_level,
            dry_run=dry_run,
            manifest_path=manifest_path,
            findings_paths=[],
            report_path=report_path,
        )
        update_latest(report_base, run_id)
        append_history(report_base, run_id, "manifest", risk_level, [], sandbox_mode=sandbox)
        print(f"Manifest generated: {manifest_path}")
        print(f"Report generated: {report_path}")
        print("Sub-agent briefs:")
        for b in briefs:
            print(f"- {b}")
        return 0

    if command == "api":
        api_path = write_api_findings(run_dir, manifest, risk_level, dry_run, settings)
        findings_paths.append(api_path)
        mode = "api"

    if command == "sweep":
        api_path = write_api_findings(run_dir, manifest, risk_level, dry_run, settings)
        browser_path = write_browser_findings(run_dir, manifest, risk_level, dry_run)
        findings_paths.extend([api_path, browser_path])
        mode = "sweep"

        if sandbox:
            env = os.getenv("APP_ENV", "")
            if env.lower() == "production":
                print("Warning: sandbox requested but APP_ENV=production; high-risk actions should be skipped.")

    report_path = write_report(
        run_dir,
        mode=mode,
        risk_level=risk_level,
        findings_paths=findings_paths,
        settings=settings,
        severity_override=severity,
    )
    briefs = write_subagent_briefs(
        run_dir=run_dir,
        command=command,
        risk_level=risk_level,
        dry_run=dry_run,
        manifest_path=manifest_path,
        findings_paths=findings_paths,
        report_path=report_path,
    )
    update_latest(report_base, run_id)
    append_history(report_base, run_id, mode, risk_level, findings_paths, sandbox_mode=sandbox)

    print(f"Run ID: {run_id}")
    print(f"Manifest: {manifest_path}")
    if findings_paths:
        for p in findings_paths:
            print(f"Findings: {p}")
    print(f"Report: {report_path}")
    print("Sub-agent briefs:")
    for b in briefs:
        print(f"- {b}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# Security Policy

## Supported versions

| Version | Security support |
|---|---|
| 2.0.x | Supported after the 2.0.0 release is published |
| 1.x | Legacy; migrate to the deterministic 2.0 trust model |

The exact release status is recorded in [PROGRESS.md](PROGRESS.md). Until 2.0.0 is
tagged and published from a passing exact-commit CI run, the 2.0 source tree is a
release candidate rather than a supported release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email
**info@maicore.dev** with:

- a concise description and affected version or commit;
- reproducible steps or a minimal fixture;
- expected and observed behavior;
- potential impact; and
- a suggested fix, if available.

Do not include production credentials, personal data, or an unredacted Sentinel run.
Use canary credentials and a disposable target. The maintainers will acknowledge the
report and coordinate disclosure privately.

## Trust model

Sentinel separates evidence from authority:

| Input | Classification | Allowed influence |
|---|---|---|
| Bundled runtime, schemas, and defaults | Trusted release assets | Contracts, limits, and default-deny behavior |
| Explicit operator config outside the target | Trusted only after location, identity, owner, mode, and schema validation | Exact origin, role secret references, adapter paths, stable-ID overrides, and mutation conditions |
| Target repository, imported contracts, pages, responses, redirects, and existing artifacts | Untrusted data | Discovery evidence and observations only |
| Environment secret values | Sensitive transient input | Approved transport calls only; never intentional persisted output |
| Claude or Codex host | Orchestrator and explainer | Choose one documented command and explain canonical results; no policy override |

Target content may contain prompt injection. The deterministic core does not obey
repository or page instructions, evaluate discovered JavaScript, import target
modules, invoke target-local binaries, or allow target metadata to grant authority.

## Trusted configuration

Every non-metadata command requires `--config`. The config must be:

- outside the target root lexically and canonically;
- a regular, non-symlinked file with one hard link;
- owned by the current effective user; and
- exactly mode `0600` or `0400` on POSIX.

The core binds the config path, ancestors, and opened file identity across the read
and rejects observable substitution. Store references such as
`env:SENTINEL_ADMIN_TOKEN`, never the token itself. Do not place the trusted config
inside the repository being tested, even if that repository is private.

Sentinel 2.0 accepts zero or one canonical approved origin and zero or one configured
service per invocation. Zero origins is valid for discovery/readiness but cannot
authorize executable API/browser work; execution requires exactly one. Multiple
distinct origins or services fail with `CONFIG_MULTI_SERVICE_UNSUPPORTED`. A service
entry must reference the sole approved origin, so a zero-origin config has no service
entry. Run a separate invocation and config for each service.

## Origins, requests, and redirects

- Every request is relative to one exact approved `http` or `https` origin.
- Configured origins with user information, base paths, queries, or fragments are
  rejected.
- Loopback is not implicitly approved; scheme, host, and port must match exactly.
- Non-loopback origins require `allowNonLoopback: true` in trusted config.
- Redirects use manual handling and can continue only on an approved exact origin.
- Cross-origin redirects are blocked before credentials are forwarded.
- Response time and byte limits bound individual API checks.
- Browser navigation observes and stops unapproved-origin activity.

Only use Sentinel against applications and infrastructure you own or are authorized
to test. Exact-origin enforcement is a safety boundary, not legal authorization.

## Secrets and authentication

Bearer-token environment references are the only deterministic 2.0 authentication
slice. During command initialization, the core resolves currently available
configured secrets to build its redactor. At execution, each selected API or browser
engine synchronously captures only the planned-role credentials before that engine
begins application I/O; it does not resolve a token separately for every request.
Values stay inside core memory and are not part of manifests, config, subprocess
arguments, return objects, finding identities, or intended logs. `setup` also
resolves role references only to report current availability and makes no application
requests. Chrome receives a fixed minimal environment with run-scoped `HOME`,
`XDG_CONFIG_HOME`, and `TMPDIR` directories (`XDG_CACHE_HOME` is isolated as well),
so bearer-token environment variables are not inherited by the browser process.

Sentinel applies redaction before schema validation and persistence and rejects
secret-bearing command results or existing artifacts when they are reread. It also
refuses to scan `.env`, `.env.local`, seed, SSH, cloud, and arbitrary documentation
files for credentials.

CLI and domain error messages are drawn from fixed tables and never embed target
data. Finding messages are template text that may carry bounded, target-derived
location detail — a route path, or a blocked browser target's scheme and pathname
— never an origin, port, query string, header, or body. Every finding string
passes the redactor before persistence, and published artifacts are re-read and
rejected if redaction would change them.

Operational rules:

- inject dedicated development/test tokens through a secret system or controlled
  environment;
- do not use production credentials;
- never put a token value in trusted config, command arguments, issue reports,
  screenshots, or chat transcripts;
- rotate a token if any external tool captures it; and
- treat generated artifacts as sensitive even though secret-containment checks are
  fail-closed.

## Mutation gate

`GET`, `HEAD`, and `OPTIONS` are the only read methods. Every other method is a
mutation and is blocked by default. A mutation executes only when all six authority
conditions hold:

1. trusted config sets `allowMutations: true`;
2. its exact stable operation ID is in `mutationAllowlist`;
3. trusted overrides establish known side effects and rollback instructions;
4. `targetEnvironment` is `development` or `test`;
5. the operation resolves to the exact approved origin; and
6. the invocation supplies an explicit valid `--sandbox-acknowledged` flag.

Known authentication and required parameter evidence are also required. In
non-interactive use, acknowledgement must be bound to an explicit `--run-id` by
setting `SENTINEL_CI_SANDBOX_ACK` to that exact ID. This prevents a reusable ambient
boolean from approving another run.

These gates prevent accidental execution; they do not make an approved mutation
harmless. Use a disposable test environment with verified rollback and backups.

## Chrome boundary

Browser checks launch headless Chrome/Chromium with a fresh run-scoped profile and a
loopback-only CDP endpoint. Sentinel accepts an absolute trusted `chromePath` or a
fixed list of system locations. A browser executable located inside the target is
rejected. Credentials are installed as transport headers in memory, not in Chrome
arguments.

Loopback-only is not an authentication boundary: Chrome's DevTools endpoint is
unauthenticated TCP, so for the duration of the browser sweep ANY local account on
the host — not just the sweep's own UID — can discover the ephemeral port, attach,
drive the browser, and observe the role token installed as a transport header. This
matches the default posture of Puppeteer/Playwright/Selenium, and it is one reason
role credentials must be disposable dev/test tokens (see above). Do not run browser
sweeps on hosts shared with untrusted local accounts; a migration to
`--remote-debugging-pipe` (no TCP listener) is the tracked remediation.

The launcher disables background features relevant to deterministic testing and
terminates the Chrome process group and removes the fresh profile at close. Do not
reuse an interactive personal browser profile.

**Host requirement — unprivileged user namespaces.** Chrome's own sandbox needs
them, and Sentinel never passes `--no-sandbox`. Stock Ubuntu 24.04 (and other
AppArmor-restricted hosts) disable them by default, so Chrome exits before CDP
readiness and browser checks fail closed with `CHROME_EXITED_EARLY` (which
reports the exit code, signal, and Chrome's stderr tail). Enable them with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or run sweeps
in a container/profile that permits them. Sentinel's CI applies exactly this
setting rather than weakening the launcher.

Browser-internal service workers (`chrome-extension:` / `chrome:`) are Chrome's
own component-extension infrastructure and are left untouched; page-initiated
service-worker registration remains blocked and reported.

## Filesystem, artifacts, and retention

The target, report root, run, and published outputs use Linux descriptor anchors,
no-follow/exclusive file operations, identity revalidation, private modes, and
transactional publication. By default, artifacts live under:

```text
<target>/sentinel-reports/sentinel-v2/
```

The versioned root is mode `0700`; regular artifacts and history are mode `0600`.
`latest` and history advance only after a complete run validates and is durably
published. Existing runs are revalidated before report, dashboard, export, trend,
diff, or cleanup operations.

Use `clean --keep <1-128>` for bounded transactional retention. Do not manually
delete a tracked run while another Sentinel process is active; manual drift causes
cleanup and history reconciliation to fail closed. Back up required evidence before
retention removes it.

## Linux and same-UID limitation

The 2.0 safety boundary depends on Linux procfs descriptor paths. Other operating systems are
outside the release support matrix.

Descriptor pins, private modes, lock ownership, hard-link publication, and identity
checks prevent or detect many path substitutions. They are not a sandbox against a
malicious process already running under the same Unix UID with write access to the
output parent. Same-UID processes must cooperate. Run hostile target code under a
different account, container/user namespace, or stronger sandbox when this
assumption is not acceptable.

## Dependencies and data transmission

The Node runtime has zero npm runtime and development dependencies. API transport
uses built-in `fetch`; browser transport uses the bundled WebSocket/CDP
implementation and a system Chrome executable. Sentinel itself has no telemetry or
analytics and does not intentionally send source or findings to a third party.

Network traffic to the exact approved application origin is the product's purpose.
The host platform and system browser may have their own policies; evaluate them for
your environment.

## Security release gates

No release should be described as goal-proven until the exact release commit proves:

- cross-origin receiver authorization count is zero;
- protected fixture tokens are absent from all artifacts and captured output;
- mutation handler counters remain zero under default-deny policy;
- malicious target comments, manifests, symlinks, and `.env` canaries cannot grant
  authority;
- concurrent/crash recovery cannot adopt incomplete artifacts;
- the real API and Chrome fixture produces the expected security findings; and
- the downloaded source archive matches and passes the tested release state.

Evidence placeholders and their current state are maintained in the
[canonical review report](docs/reports/2026-07-18-sentinel-plugin-review-and-architecture.md).

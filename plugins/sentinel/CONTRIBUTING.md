# Contributing to Sentinel

Sentinel's production boundary is intentionally smaller than its historical 1.x
prompts. Contributions must preserve deterministic behavior, explicit coverage,
default-deny execution, secret containment, transactional artifacts, and parity
between the root package and installable mirror.

Read [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and the
[ADR log](docs/adr/README.md) before changing discovery, policy, credentials,
origins, filesystem handling, browser execution, findings, history, or packaging.

## Development environment

- Linux with `/proc` mounted
- Node.js 18 or newer
- System Chrome/Chromium for browser integration and E2E tests
- Bash, Python 3, Git, and the Claude CLI for the plugin validation gate

The Node runtime has zero third-party dependencies, so there is no package install
step. Clone the repository and verify the toolchain:

```bash
git clone https://github.com/michelabboud/sentinel-sweep.git
cd sentinel-sweep
node --version
npm run audit
```

## Repository map

```text
sentinel-sweep/
├── runtime/
│   ├── cli.mjs                 # strict CLI and lifecycle orchestration
│   ├── discovery/              # OpenAPI JSON and static Vue Router adapters
│   ├── policy/                 # fail-closed execution decisions
│   ├── api/                    # bounded HTTP/RBAC/schema runner
│   ├── browser/                # WebSocket, CDP, Chrome, browser checks
│   └── lib/                    # contracts, boundaries, config, origins, secrets
├── schemas/                    # strict v2 settings/manifest/findings/history contracts
├── commands/ and skills/       # thin Claude host surfaces
├── agents/                     # explanation-only host roles
├── codex/                      # transparent Codex launcher and host docs
├── plugins/sentinel/           # installable byte-for-byte mirror
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── adversarial/
│   ├── integration/
│   └── e2e/
├── docs/adr/                   # append-only architecture decisions
├── docs/reports/               # durable review and verification reports
├── docs/guides/                # operator and migration guides
├── VERSION                     # release version source of truth
└── PROGRESS.md                 # exact release-gate state
```

## Non-negotiable invariants

1. The target repository, imported descriptions, pages, responses, redirects, and
   existing artifacts are untrusted data.
2. Only bundled assets and a validated private config outside the target can grant
   authority.
3. Discovery never evaluates or imports target code and never invokes target-local
   executables.
4. Sentinel 2.0 accepts zero or one canonical approved origin and zero or one
   configured service per invocation; executable work requires exactly one origin.
5. A request never leaves the exact approved origin; redirects are revalidated
   manually.
6. Secret values are transient. They must not enter serialized data, subprocess
   arguments, errors, stdout/stderr, screenshots metadata, or artifacts.
7. Every operation and route gets an explicit execute/skip policy decision.
8. Non-read methods remain blocked unless every documented mutation condition and
   required execution input is satisfied.
9. `sentinel-findings.json` is canonical; all consumers use its stored summary.
10. Failed or incomplete runs do not advance history or `latest`.
11. Persisted directories/files remain private and publication stays recoverable.
12. Linux descriptor anchoring and the cooperative same-UID limitation remain
    explicit; do not imply a stronger sandbox than the implementation provides.

## Change workflow

1. Add or update an ADR when a decision has credible alternatives, changes a trust
   boundary/public contract, or will be costly to reverse. ADRs are append-only;
   supersede an accepted record instead of rewriting its historical decision.
2. Write a focused test that fails for the intended reason.
3. Implement the smallest complete production slice, including failure behavior.
4. Run the focused test under the real Node 18 floor.
5. Run the aggregate unit, contract, adversarial, integration, legacy, and E2E gates
   proportionate to the change.
6. Update README, architecture, security, migration, changelog, progress, and durable
   reports affected by the change.
7. Synchronize the installable mirror and verify hashes; do not hand-maintain a
   divergent implementation.
8. Run the full release gate before claiming completion.

Do not add an npm dependency casually. A new dependency needs current version,
security, maintenance, adoption, and alternatives research recorded in
`docs/reports/`, or an ADR when architecturally significant.

## Tests and verification

Run the normal local gates:

```bash
npm test
npm run lint
npm run audit
bash tests/e2e/clean-install.test.sh
bash tests/e2e/plugin-install.test.sh
claude plugin validate --strict .
git diff --check
```

The aggregate suite includes legacy shell contracts plus Node unit, contract,
adversarial, integration, and real-goal E2E tests. Browser/release E2E is not allowed
to skip because Chrome is missing.

Verify the runtime floor rather than relying on a newer local Node version:

```bash
npx --yes -p node@18.20.8 -c 'node --version && npm test && npm run lint && npm run audit'
```

Use focused Node tests while iterating, for example:

```bash
node --test tests/unit/execution-policy.test.mjs
node --test tests/adversarial/trust-boundary.test.mjs
node --test tests/integration/api-sweep.test.mjs
node --test tests/e2e/goal-sweep.test.mjs
```

Never report a gate as passed without the actual command output from the exact code
state being evaluated.

## Adding or changing discovery support

Deterministic support requires more than recognizing a framework name. A new adapter
must have:

- a non-evaluating grammar and explicit allowlisted files;
- stable identities and provenance for every record;
- complete, partial, and unsupported outcomes with diagnostics;
- conflict and duplicate behavior;
- manifest-schema integration;
- policy behavior for every unknown field;
- adversarial fixtures; and
- a real end-to-end target that proves the public coverage claim.

Until all of those exist, document the pattern as unsupported enrichment. Never map
an unsupported application to an empty successful manifest.

## Changing the CLI or public contracts

The parser has an explicit command/flag matrix. Update together:

- `runtime/cli.mjs` and its contract tests;
- strict JSON schemas and golden fixtures when their data changes;
- `commands/sentinel.md` and `skills/run/SKILL.md` host mapping;
- root, Codex, security, architecture, migration, and history docs;
- mirror parity inventory; and
- clean-install/plugin-install tests.

Keep exit semantics stable: `0` is completion without critical/error findings for a
run, `1` is usage/config/readiness/runtime/publication failure, and `2` is a completed
run with critical/error findings.

## Config and secret tests

Use synthetic canary values only. Tests should prove absence by scanning every
artifact plus captured stdout/stderr without printing the canary into review output.
Config fixtures must be outside the target, owned by the current UID, mode `0600` or
`0400`, and not symlinked or hard-linked.

When testing multiple services, run one Sentinel invocation per service. A config
with multiple distinct origins/services should assert
`CONFIG_MULTI_SERVICE_UNSUPPORTED`.

## Mirror and release version

Root assets are canonical and `plugins/sentinel/` is the installable mirror. The
version source of truth is `VERSION`. At release time use:

```bash
./scripts/bump-version.sh 2.0.0
bash tests/test-mirror-parity.sh
bash tests/test-version-consistency.sh
```

The bump/sync process must include runtime modules, schemas, package metadata,
defaults, commands, skills, agents, README, security docs, Codex assets, and plugin
metadata. Do not tag or publish until the exact release commit has passed local and
remote gates.

## Documentation expectations

Documentation is part of the contract. Keep examples schema-valid and commands
copyable. Separate implemented source from observed proof, and preserve limitations
and pending evidence honestly. The durable 28-issue review lives at
`docs/reports/2026-07-18-sentinel-plugin-review-and-architecture.md`; update its gate
table when—and only when—the exact evidence exists.

## Commit and pull request guidance

Use focused conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`,
`release:`). Describe the trust assumptions and failure cases in the pull request.
Include exact test commands and results, Node/Chrome versions, and any gate that is
still pending.

Contributions are licensed under Apache-2.0; see [LICENSE](LICENSE).

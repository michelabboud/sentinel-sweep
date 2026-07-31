# Sentinel 2.0.x post-release hardening — lane spec

**Author:** Fable · **Date:** 2026-07-31 · **Source:** the four non-gating findings
from the 2.0.0 merge-gate seal and its adversarial delta-check
(`docs/reports/2026-07-31-sentinel-2.0-seal-review.md`).

**Scope:** the three LOW findings plus one observation. The MEDIUM (CDP over TCP →
`--remote-debugging-pipe`) is deliberately **NOT** in this lane: it is a transport
rewrite of a security-critical component and gets its own designed wave.

**Release shape:** patch, `2.0.1`. No behavior a user depends on changes; two new
fail-closed bounds become *diagnosable* where they were previously either unbounded
or opaque.

---

## L1 — Bound discovery file reads

**Defect.** `TargetBoundary.readText` (`runtime/lib/fs-boundary.mjs:289`) reads a whole
file with `fileHandle.readFile('utf8')` and no cap. Discovery paths are operator-chosen
but file *contents* are untrusted per the stated trust model, so a multi-gigabyte
`router.js` or OpenAPI document in the target exhausts process memory before any
downstream limit applies. `snapshotJson` bounds the resulting manifest, not the read.
Fails closed (no artifacts publish), so this is availability only.

**Required change.** Add a `maxBytes` option to `TargetBoundary.readText` and pass a cap
from both discovery call sites (`runtime/discovery/openapi.mjs:311`,
`runtime/discovery/vue-router.mjs:899`). A file exceeding the cap must fail **closed**
and surface as a **coverage diagnostic** naming the file and the limit — not an opaque
throw. `runtime/history.mjs:290` already contains a bounded-read helper: follow its
approach rather than inventing a second one.

The cap is a named constant, not a literal at the call site, and it belongs with the
other discovery bounds so a future reader finds all limits in one place.

## L2 — Depth guard in the Vue Router value parser

**Defect.** The mutually recursive `parseValue` / `parseArray` (`:387`) / `parseObject`
(`:411`) in `runtime/discovery/vue-router.mjs` have no depth bound. A target file with
tens of thousands of nested `[` or `{` overflows the V8 stack; the resulting `RangeError`
is not a `SentinelError`, so it escapes `buildManifest` and reaches `runCli`'s catch-all
as the opaque `CLI_COMMAND_FAILED`. Fails closed, but the operator learns nothing.

**Required change.** Thread a depth counter through the three functions and emit a
`VUE_DEPTH_LIMIT` coverage diagnostic when exceeded — matching how every other bound in
this codebase is expressed. Adding a reason code means updating the **closed contract
table** (`runtime/lib/findings-contract.mjs`) and any bundled schema enum that lists
diagnostic codes; find every place the existing Vue diagnostic codes are registered and
register this one identically. A missed registration must fail a test, not ship.

## L3 — Delete the dead, weaker `replaceLatest`

**Defect.** `RunBoundary.replaceLatest` (`runtime/lib/fs-boundary.mjs:912`) is
unreachable from the runtime — the live implementation is `runtime/history.mjs:1324`,
and `tests/integration/run-lifecycle.test.mjs:164` asserts the artifact-writer facade
does not expose the dead one. The dead copy is **strictly weaker**: it skips the
run-marker token check and the fingerprint match the live version performs. Its only
exerciser is `tests/unit/fs-boundary.test.mjs:414`.

**Required change.** Delete the dead method and retarget that unit test at the live
`history.mjs` implementation, preserving the behaviors the test actually pins. Do not
weaken or drop coverage: if a pinned behavior has no equivalent on the live path, say so
in the report instead of silently deleting the assertion.

## L4 — Redaction assert in `writeCommandFailure`

**Observation.** `writeCommandFailure` (`runtime/cli.mjs:587-594`) writes `message` and
`details` to stdout/stderr with no redaction assertion inside the helper. Both current
callers are safe by construction (fixed-table messages; `details` is `{failedEngines}`
drawn from the literals `'api'`/`'browser'`), so this is **latent, not live** — but it is
the one output sink in the file without an internal guard, and a future caller passing
dynamic detail would not be caught.

**Required change.** Add the internal guard so the helper is safe regardless of caller,
following the redaction-assert pattern already used at the other CLI output sinks
(`cli.mjs:746-751`, `:965-969`). A test must prove the guard fires on a hostile
dynamic detail.

---

## Gates (all must pass before you report success)

- `npm run lint` and `npm run audit` (audit proves the zero-dependency claim).
- **Focused suites only, in-lane**: `node --test tests/unit/<file>.test.mjs` for what you
  touch. **Do NOT run `npm test` / `tests/run-all.sh` in the lane** — the full suite
  binds loopback sockets the sandbox forbids (`EPERM` on `127.0.0.1`) and spawns Chrome.
  The orchestrator runs the full suite host-side.
- New tests for every change: the happy path **and** the failure path (an oversized file,
  an over-deep nest, a hostile dynamic detail).
- `bash tests/test-mirror-parity.sh` — **every runtime edit must be mirrored to
  `plugins/sentinel/`**; the mirror is byte-identical by contract and parity is enforced.

## Working rules

- **Do not commit.** Leave the tree dirty and report; the orchestrator reviews the diff,
  runs the full suite host-side, and commits. Do not touch `VERSION` or `CHANGELOG.md` —
  the release surfaces are the orchestrator's.
- Match the existing code's idiom, comment density, and error-construction style. Every
  new bound is a named constant with a comment saying *why that number*.
- Never widen scope: no refactors, no drive-by cleanups, no new dependencies.
- If a change would alter behavior a user depends on, STOP and report instead.

## Escalation clause

You are on the tier chosen for this task's security adjacency. If it exceeds you — stuck
after a genuine attempt, looping, or you would be guessing (especially about the
findings-contract registration surface) — stop and reply
`ESCALATE: <what is beyond you, what you tried, where you stopped>` rather than
continuing. Escalating early is cheaper than a wrong answer in a security module.

## Report

Write your close-out to the `-o` path: what changed per item, the exact gate commands
and their output, every judgment call you made, and anything you chose not to do.

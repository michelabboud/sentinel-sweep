# Sentinel 2.0 Sweep History Specification

## Purpose

Sweep history is a bounded, validated index of successfully published Sentinel 2.0
runs. It supports `latest`, `trends`, `diff`, existing-run report/export operations,
crash reconciliation, and transactional retention without treating directory names
or old JSON as trusted.

History is not a free-form analytics log and is never appended after an incomplete
engine or failed artifact publication.

## Location and permissions

Trusted config supplies a relative `reportDir` beneath the target. The CLI appends
`sentinel-v2` unless the final path segment is already `sentinel-v2`:

```text
<target>/<reportDir>/sentinel-v2/
├── <UTC-run-id>/
├── sweep-history.json
└── latest -> <UTC-run-id>
```

The versioned report root and run directories must be owned by the current UID and
mode `0700`. History and regular artifacts are mode `0600`. Safe history operations
are Linux-only because they pin the report root and runs through procfs descriptor
paths (`/proc/self/fd` or subprocess-stable `/proc/<pid>/fd`).

## Public contract

`sweep-history.json` validates against `schemas/sweep-history.schema.json` with:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | constant string | Always `"2.0"` |
| `runs` | array, maximum 128 | Strictly increasing unique run records |
| `pendingCleanup` | optional object | Durable internal recovery intent for transactional cleanup; operators must not edit it |

Each run record contains:

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | Valid filesystem-safe UTC run ID and direct child directory name |
| `startedAt` | string | Canonical findings start timestamp |
| `finishedAt` | string | Canonical findings finish timestamp |
| `coverageStatus` | enum | `complete`, `partial`, or `unsupported` |
| `summary` | object | Canonical `critical`, `error`, `warning`, `info`, and `skipped` counts |
| `findingsDigest` | 64 lowercase hex characters | SHA-256 of canonical findings JSON |
| `markerToken` | 64 lowercase hex characters | Private run-identity token bound to the published run marker |
| `dev`, `ino`, `birthtimeNs`, `uid`, `mode` | decimal strings | Filesystem identity recorded for later revalidation |
| `healthScore` | optional integer or null | Reserved compatible metric; 0 through 100 when present |
| `commitSha` | optional string or null | Reserved source association when explicitly supplied by a future trusted path |

Run IDs use this family:

```text
YYYY-MM-DDTHH-MM-SSZ
YYYY-MM-DDTHH-MM-SS-mmmZ
YYYY-MM-DDTHH-MM-SSZ-<8 lowercase hex>
YYYY-MM-DDTHH-MM-SS-mmmZ-<8 lowercase hex>
```

New CLI runs use the millisecond-plus-entropy form so concurrent invocations do not
collide.

`pendingCleanup` contains a 24-hex transaction ID and a sorted set of exact run
fingerprints plus deterministic tombstone names. It is an implementation-level
recovery journal, not a user-editable API.

## Canonical publication sequence

For `api`, `browser`, or `sweep`, publication follows this order:

1. Validate trusted config and pin the target/report boundaries.
2. Generate a fresh strict manifest and complete execution plan.
3. Reject the selected mode if it has no executable required work.
4. Reserve a unique private staging directory and create a private run boundary.
5. Write `sentinel-manifest.json`.
6. Execute every required engine. For `sweep`, API and browser both must complete.
7. Normalize, redact, deduplicate, and validate canonical findings.
8. Render and write canonical artifacts:
   `sentinel-findings.json`, `sweep.md`, `dashboard.html`, and `pr-comment.md`, plus
   any configured failure screenshots.
9. Validate the entire staged tree, write the private run identity marker, and
   publish the run directory atomically.
10. Under the history metadata lock, reread and validate the published artifacts,
    append the exact history entry atomically, and durably update `latest`.
11. Revalidate the report root and published run before returning success.

If a required engine, redaction check, schema check, file write, durability check,
or identity check fails, the run is not recorded as successful and `latest` does not
advance.

## Reconciliation and tamper detection

History, directory names, markers, symlinks, and artifacts are untrusted when read
back. `readSweepHistory` and `readPublishedRun` acquire the metadata lock and
reconcile observable state before returning data. They verify:

- private ownership/modes and non-symlink file types;
- exact report-root and run descriptor identities;
- unique/sorted run IDs, marker tokens, and filesystem identities;
- the private run marker;
- required artifact presence and bounded file size;
- strict manifest/findings schemas;
- canonical findings digest and summary agreement; and
- exact rendered Markdown, dashboard, and PR-ready Markdown.

A duplicate run ID is idempotent only when canonical content and identity match
exactly. A same-ID run with different content fails with a duplicate/corruption
error. Untracked run directories, missing tracked runs, unsafe tombstones, or an
invalid `latest` pointer are not silently trusted.

Crash recovery may adopt only a fully validated published/staged run that is bound
to the exact transaction identity. Incomplete or ambiguous state remains a failure;
recovery does not fabricate a successful run.

## `latest`

`latest` is a relative symlink whose target is the newest tracked run ID. It is
replaced through a private temporary link only after history and run validation.
Readers reconcile it under the same metadata lock. It is a convenience pointer, not
authority; the tracked run is still opened and validated independently.

## `trends`

Invocation:

```bash
node runtime/cli.mjs trends --target <target> --config <external-config> --json
```

`computeTrends` returns canonical JSON shaped as:

```json
{
  "runs": [
    {
      "runId": "2026-07-18T12-30-45-123Z-a1b2c3d4",
      "coverageStatus": "complete",
      "summary": {
        "critical": 0,
        "error": 1,
        "warning": 2,
        "info": 3,
        "skipped": 4
      }
    }
  ],
  "latestSummary": {
    "critical": 0,
    "error": 1,
    "warning": 2,
    "info": 3,
    "skipped": 4
  },
  "deltas": []
}
```

Runs are sorted by run ID. Each delta contains `fromRunId`, `toRunId`, and the
newer-minus-older value for all five summary fields. Empty history returns an empty
run/delta list and an all-zero `latestSummary`. Trends do not invent pass rates,
durations, health scores, or resolved finding identities.

## `diff`

Invocation:

```bash
node runtime/cli.mjs diff \
  --target <target> \
  --config <external-config> \
  --run <newer-run-id> \
  --against <older-run-id> \
  --json
```

Both runs must be tracked and fully valid. The result preserves each canonical
summary and compares stable finding IDs:

- `added`: present only in the newer run;
- `resolved`: present only in the older run; and
- `persisting`: present in both.

This is an identity diff, not a fuzzy message comparison.

## Existing-run consumers

`report`, `dashboard`, and `export` require an exact tracked `--run`. Before writing
an external output, they validate the run, canonical artifacts, and current secret
redaction policy. Report/dashboard outputs are private atomic files. Export writes a
private atomic tree and contains variable references, never resolved secret values.

## Retention and `clean`

History is capped at 128 runs. Sentinel does not silently discard evidence to make
room; a new publication fails when the bound is exhausted until the operator runs
cleanup.

```bash
node runtime/cli.mjs clean \
  --target <target> \
  --config <external-config> \
  --keep 20 \
  --json
```

`--keep` accepts 1 through 128 at the CLI. Cleanup requires exact agreement between
history and direct-child run directories. It pins every tracked run, validates its
marker/tree, writes durable `pendingCleanup` intent, renames selected old runs to
transaction-specific tombstones, removes only the exact bounded private tree, and
then clears the intent atomically. A crash resumes from the persisted intent. Unsafe
or changed state fails closed and may require operator investigation.

Cleanup returns sorted `kept` and `removed` run ID arrays. Back up evidence before
retention removes it.

## Concurrency and limitations

History publication and cleanup use an identity-bound, crash-recoverable metadata
lock. Independent run staging remains isolated, while history/latest changes are
serialized. Dead lock records are recovered only after process identity and Linux
start markers prove the owner is gone.

This model assumes cooperation among processes running as the same Unix UID. A
malicious same-UID process with write access to the output parent is inside the
principal boundary; POSIX path APIs cannot provide a universal sandbox against it.
Isolate hostile target code under a separate user or stronger sandbox.

## Compatibility

Sentinel 1.x history has a different shape and is not imported. Version 2 artifacts
live in the `sentinel-v2` subroot so old evidence is preserved rather than silently
rewritten. Migration starts with a fresh v2 config, manifest, and run history.

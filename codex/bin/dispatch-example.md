# Codex Sub-agent Dispatch Examples

This file shows how to dispatch Sentinel Codex run briefs to sub-agents.

Assume you already ran:

```bash
./codex/bin/sentinel-codex.sh sweep --dry-run
```

And got a run folder:

`sentinel-reports/<RUN_ID>/subagent-briefs/`

## 1) Manifest worker

Use the generated brief:

`sentinel-reports/<RUN_ID>/subagent-briefs/manifest-generator-task.md`

Example flow:

1. `spawn_agent` with `agent_type: "worker"` and message:
   - "Read `.../manifest-generator-task.md`, execute the task, and write output files exactly as requested."
2. `wait_agent` for completion.

## 2) API + Browser workers in parallel (recommended for `sweep`)

Use:

- `sentinel-reports/<RUN_ID>/subagent-briefs/api-sweeper-task.md`
- `sentinel-reports/<RUN_ID>/subagent-briefs/browser-sweeper-task.md`

Example flow:

1. Spawn API worker.
2. Spawn Browser worker.
3. Wait for whichever finishes first.
4. Continue local non-overlapping work.
5. Wait for the second worker.

## 3) Report synthesizer worker

Use:

`sentinel-reports/<RUN_ID>/subagent-briefs/report-synthesizer-task.md`

Example flow:

1. Spawn a worker for report synthesis after findings exist.
2. Wait for completion.
3. Confirm `sweep.md` and dedup summary are updated.

## 4) Diff analyst worker

After running:

```bash
./codex/bin/sentinel-codex.sh diff
```

Use:

`sentinel-reports/<NEWER_RUN_ID>/subagent-briefs/diff-analyst-task.md`

## 5) Trends analyst worker

After running:

```bash
./codex/bin/sentinel-codex.sh trends
```

Use:

`sentinel-reports/latest/subagent-briefs/trends-analyst-task.md`

## Suggested worker prompt template

Use this exact structure in `spawn_agent.message`:

```text
You are assigned one Sentinel Codex task.
Read this brief file and execute it end-to-end:
<ABSOLUTE_BRIEF_PATH>

Rules:
- You are not alone in the codebase. Do not revert others' changes.
- Only edit files required by the brief.
- Report the exact files changed.
```


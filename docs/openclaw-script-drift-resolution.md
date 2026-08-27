# OpenClaw workspace drift resolution

Date: 2026-08-28

This records why the 14 non-test workspace copies that differed from an
existing Git source were not accepted wholesale. The comparison used the live
`herman.hermes` workspace, the current task branch and the live `my-wechat`
checkout. It is a source decision record, not proof that production callers
have already moved.

## X pipeline: keep the repository implementations

The eight workspace X copies predate the repository split and later safety
work. The repository versions are authoritative:

| File | Workspace drift | Resolution |
| --- | --- | --- |
| `x_explorer.py` | Writes directly to `/home/herman/.openclaw/workspace/data/x_explore` | Keep repository `x_paths.data_dir()` |
| `x_timeline_collector.py` | Writes directly to the OpenClaw timeline | Keep repository `x_paths.data_dir()` |
| `x_timeline_dedup.py` | Derives state from the old workspace parent | Keep repository `x_paths.data_dir()` |
| `x_timeline_migrate_explore.py` | Derives both data paths from the old workspace parent | Keep repository `x_paths.data_dir()` |
| `x_topic_search.py` | Derives exploration state from the old workspace parent | Keep repository `x_paths.data_dir()` |
| `x_timeline_store.py` | Lacks later canonicalization of `/photo`, `/history` and similar status URL suffixes | Keep repository canonical identity fix |
| `x_neighborhood.py` | Uses raw anchors, restricted values and free-text bridge material in automatic traversal | Keep repository explicit runtime roots and sanitized topology |
| `x_insight_pipeline.py` | Lacks later current-collection projection, deduplication, pending-receipt fail-closed behavior, locked prepare/confirm updates and pending-theme persistence | Keep repository delivery and selection safeguards |

The three drifted X tests (`test_x_insight_pipeline.py`,
`test_x_neighborhood.py`, `test_x_timeline_dedup.py`) follow those older
workspace semantics, so the repository tests remain authoritative as well.

## my-wechat wrappers: merge production intent, remove both legacy roots

| File | Why it drifted | Resolution in this repository |
| --- | --- | --- |
| `mywechat_ai_context_daily.sh` | `my-wechat` Git hard-codes `/home/rita/my-wechat`; workspace added an uncommitted multi-host probe | Retain `MYWECHAT_DIR`, default only to `$HOME/my-wechat` |
| `mywechat_ai_context_hourly.sh` | Same deployment-only multi-host patch | Same resolution |
| `mywechat_pull.sh` | Same deployment-only multi-host patch | Same resolution |
| `mywechat_sync_daemon.sh` | Same deployment-only multi-host patch and executable-mode drift | Same resolution; repository owns executable mode |
| `mywechat_watchdog.sh` | The Git copy contains a cron-output re-send block; the production workspace disabled it after `weixin-retry-queue` made it duplicate delivery | Keep the production decision: watchdog reports health only; DSH delivery owns retries and receipts |
| `send_tg_ops.sh` | One copy defaults to a Hermes profile, the other to an OpenClaw profile | Choose neither path; require explicit `TELEGRAM_OPS_*` variables or explicit `OPS_ENV` |

`cron_conflict_check.py` was byte-identical in the old workspace and
`my-wechat`, but both copies read the already absent Hermes `jobs.json`. The
repository version now folds DSH `jobs.jsonl` and reads the latest `nextRunAt`
from DSH `runs.jsonl`.

## Direct OpenClaw code

The old `x-delivery-receipt` plugin, reminder template and six trigger source
files were first imported byte-for-byte in commit `01f6355` so their behavior
could be audited, then removed from the current tree once caller verification
showed that they were disabled, superseded or executable only inside OpenClaw.
They were not ported by renaming APIs:

- X delivery receipts already have a DSH-native implementation under
  `x-feed/src/receipt.ts` and the repository X pipeline.
- OpenClaw trigger JavaScript depends on `tools.call`, `json`, trigger state or
  `cron_changed`; DSH does not execute that sandbox contract.
- Former trigger behavior must use a DSH command job, a non-empty stdout gate,
  or an Agent job with an explicit provider contract.
- Rita delivery now calls an explicit external sender adapter; the repository
  relay no longer invokes `openclaw message send`.

The same retirement removed four orphaned one-shot reminders, the unused daily
and weekly OpenClaw upstream briefs, the disabled `info_monitor.py` path and the
`mywechat_sync_daemon.sh` wrapper superseded by the systemd unit's direct
`sync.py` invocation. Their pre-retirement sources remain recoverable from
`01f6355`; none is shipped as an active automation.

## Remaining production cutover

Source ownership and no-OpenClaw execution paths are now defined. Production
still requires a separately authorized release/cutover that changes DSH cron
argv paths, updates the host OOM unit, deploys the Rita sender/helper, validates
external assets and only then permits OpenClaw removal. No production caller
was changed while resolving source drift.

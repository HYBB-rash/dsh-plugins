# Repository-owned automations

This directory owns the automation source that previously existed only under
the OpenClaw workspace. OpenClaw is not a runtime prerequisite: active code
must work when its CLI, service, plugins, state database and home directory are
all absent.

## Source map

- `bzp/`: Baozupo meter queries, BLE reads, monitoring and WeChat dispatch.
- `mywechat/`: my-wechat context generation, repository update and watchdog
  entrypoints.
- `relay-sites/`: relay-site inspection and daily discovery.
- `search/`: browser/CDP and fallback web-search mechanics, including the
  committed Selenium helper but no browser profile or cookies.
- `cron/`, `deepseek/`, `github/`, `notion/`, `telegram/`, `wechat/` and
  `zerochan/`: task sources whose business owner is explicit from the directory.
- `scripts/`: support code without one business owner. It must not become a
  second flat collection of business task entrypoints.
- Mutable automation state defaults to
  `${DSH_HOME:-$HOME/.dsh}/storages/automations`; set
  `DSH_AUTOMATION_STATE_DIR` to override it.
- `../x-feed/python/`: the active X pipeline, including `x_daily_report.py`
  and the imported `test_insight_engine.py`. X state remains under
  `DSH_X_FEED_DATA_DIR`.
- `requirements.lock`: direct Python dependency versions observed in the
  relevant production/search runtimes at import time. Browser executables,
  device authentication, profiles and business state remain external assets.
- `tests/`: repository ownership, path isolation, DSH ledger and relay adapter
  contracts.

The original 41 non-test workspace scripts, 10 workspace tests, nested search
helper, loaded plugin, reminder template and inline trigger programs remain
recoverable from Git commit `01f6355` (`chore: import OpenClaw-hosted automation
sources`). The current tree deliberately ships only sources with a supported
runtime owner; orphaned one-shot reminders, disabled OpenClaw-only code and
superseded wrappers were removed after caller verification.

## Runtime boundaries

| Boundary | Repository source | External requirement |
| --- | --- | --- |
| DSH command/Agent jobs | `automations/<business>/`, `automations/scripts/`, `x-feed/python/` | Job definitions must invoke immutable image paths, never a home-directory source checkout |
| X feed | `x-feed/python/` and `x-feed/src/` | Chrome/CDP and persistent `DSH_X_FEED_DATA_DIR` |
| BLE | `automations/bzp/` | BLE device, mode-0600 auth file and locked Python dependencies |
| my-wechat | `automations/mywechat/` | Independent `$HOME/my-wechat` checkout, database, virtualenv and health files |
| Browser/search | `automations/search/` | Operator browser profile, Firefox/geckodriver/xvfb where applicable; profiles and cookies are never committed |
| Host OOM guard | `automations/wechat/wechat_oom_protect.py` | A separately managed host systemd unit and the required `/proc` permission |
| Rita WeChat relay | `automations/bzp/bzp_weixin_relay.py` | An explicit non-OpenClaw sender executable accepting `--target` and message bytes on stdin |

The release image masks `/home/herman/.openclaw` with an empty tmpfs. This
makes accidental dependency visible even during the transition period when a
host copy may still exist.

## Configuration rules

- Credentials come from explicit environment variables or an explicitly named
  credential file. No active script searches an OpenClaw profile or `.env`.
- State belongs under `DSH_HOME`, not beside immutable scripts.
- Other Git projects such as `my-wechat`, `deepseek-usage-report` and the
  upstream OpenClaw mirror remain independent inputs; their source and data are
  not copied here.
- Retired OpenClaw plugin, trigger and reminder code is historical Git evidence,
  not a runtime compatibility layer. Reintroducing a capability requires a DSH
  command job, Agent gate or existing X delivery receipt with an active owner.

## Local checks

```bash
python3 -m unittest discover -s automations/tests -p 'test_*.py'
python3 -m unittest automations/bzp/test_bzp_ble_read_until_success.py
(cd x-feed/python && python3 -m unittest discover -p 'test_x_*.py')
find automations -type f -name '*.sh' -exec bash -n {} \;
```

The BLE crypto tests require `openssl` on `PATH`; the immutable release image
installs it and runs the same test file there.

# herman.hermes DSH Web outage report — 2026-09-04

## Summary

At 2026-09-04T14:27Z, `herman.hermes` had no running DSH Web supervisor and no listeners on either required `3080` endpoint. The latest recorded start had reached the Harness token URL generation step, but the LAN proxy then crashed on an unhandled socket `ECONNRESET`. Because `dsh-web-start` supervises both Harness Web and the LAN proxy with `wait -n`, the proxy crash caused the whole portable Web service to exit.

No OpenClaw state was inspected or modified.

## Observed production state

- Host checked: `herman.hermes`.
- Deployment root: `/home/herman/.local/share/dsh-web-package`.
- Remote archive verification: `dsh-web.tar.gz: OK`.
- `current` symlink target: `releases/fccbd3b5d7f410e25d569297c026a5bdcf5cf12ebbfa11791ab9d7234de02adf`.
- Supervisor process: none found for `/home/herman/.local/share/dsh-web-package/dsh-web-start`.
- Listeners: none on `127.0.0.1:3080` or `192.168.6.240:3080`.
- Loopback `/api/llm/listProviders`: connection failed because no listener existed.
- LAN `/api/llm/listProviders`: connection failed because no listener existed.
- Local and remote helper SHA-256 values matched for:
  - `dsh-web-start`
  - `dsh-web-lan-proxy.mjs`
  - `dsh-web-notify-start-url.mjs`

## Failure evidence

Latest stderr log: `/home/herman/.local/share/dsh-web-package/logs/start-20260904T133204Z.err`.

Relevant redacted error:

```text
Error: write ECONNRESET
    at Server.<anonymous> (file:///home/herman/.local/share/dsh-web-package/dsh-web-lan-proxy.mjs:59:14)
Emitted 'error' event on Socket instance
Node.js v24.19.0
```

Latest stdout showed that Harness had emitted a startup URL before the crash. The token value is intentionally omitted from this report.

## Root cause

`dsh-web-lan-proxy.mjs` rejected forbidden WebSocket upgrade clients by calling `socket.end(...)`. If that client reset the TCP connection while the proxy wrote the rejection response, Node emitted an `error` event on the client socket. The forbidden-upgrade path had no socket error handler, so the `ECONNRESET` became an unhandled exception and terminated the LAN proxy process.

`dsh-web-start` is designed to stop the sibling process when either Web or proxy exits, so the proxy-only crash correctly brought down the supervised service instead of leaving a half-running deployment.

## Fix

Added an error handler to the forbidden WebSocket upgrade socket before writing the `403 Forbidden` response. This keeps the security behavior unchanged while making client resets non-fatal.

Changed files:

- `scripts/dsh-web-lan-proxy.mjs`
- `scripts/tests/dsh-web-lan-proxy.test.mjs`

## Verification before deployment

TDD red check:

- `nix develop -c node --test scripts/tests/dsh-web-lan-proxy.test.mjs` failed before the code change with `AssertionError [ERR_ASSERTION]: Got unwanted exception. Actual message: "write ECONNRESET"`.

Post-fix checks passed:

```bash
nix develop -c bash scripts/tests/dsh-web-deploy.test.sh
nix develop -c bash scripts/tests/package-dsh-web.test.sh
nix develop -c bash scripts/tests/dsh-web-packages.test.sh
nix develop -c bash scripts/tests/self-describing-plugins.test.sh
nix develop -c node --test \
  scripts/tests/dsh-web-lan-proxy.test.mjs \
  scripts/tests/dsh-web-notify-start-url.test.mjs
bash -n \
  scripts/package-dsh-web \
  scripts/dsh-web-deploy \
  scripts/dsh-web-start \
  scripts/dsh-web-install-plugins \
  scripts/dsh-web-runtime \
  scripts/tests/dsh-web-deploy.test.sh
git diff --check
```

## Deployment and production verification

Deployment upload completed through `scripts/dsh-web-deploy`:

- Archive SHA-256: `4a37a2181a451d5b9da530477aa138b80179f227ac8c9e3b08e6cfd5cd831473`.
- Remote upload target: `herman.hermes:/home/herman/.local/share/dsh-web-package`.

Before start:

- No existing `dsh-web-start` supervisor was present.
- No listeners existed on `127.0.0.1:3080` or `192.168.6.240:3080`.
- Remote `sha256sum -c dsh-web.tar.gz.sha256` passed.

Start:

- Run id: `20260904T142853Z`.
- Supervisor PID: `3108407`.
- Stdout: `/home/herman/.local/share/dsh-web-package/logs/start-20260904T142853Z.out`.
- Stderr: `/home/herman/.local/share/dsh-web-package/logs/start-20260904T142853Z.err`.

Production checks:

- Supervisor remained alive with two children: Harness Web and LAN proxy.
- Listeners present:
  - `127.0.0.1:3080` owned by Harness Web.
  - `192.168.6.240:3080` owned by LAN proxy.
- Current release target: `releases/4a37a2181a451d5b9da530477aa138b80179f227ac8c9e3b08e6cfd5cd831473`.
- Stderr contained no `ERR_DLOPEN_FAILED`, undefined symbol, fatal, module-load, pnpm, workspace, OOM, or Telegram notification failure markers.
- Token URL was present in stdout and was used only via variables; the token is intentionally omitted here.
- Loopback token login final status: `200`.
- External HTTPS token login final status: `200`; external root with session: `200`.
- No-session HTTP status matrix:
  - `http://127.0.0.1:3080/api/llm/listProviders`: `401`.
  - `http://192.168.6.240:3080/api/llm/listProviders` from the allowed workstation, with LAN Host: `401`.
  - LAN request with `Host: dsh.man-her.icu` from the allowed workstation: `401`.
  - `https://dsh.man-her.icu/api/llm/listProviders`: `401`.
  - Host/Origin mismatch from the allowed workstation: `403`.
  - Non-whitelisted source via the hermes LAN self-interface: `403 Forbidden`.

Not independently verified by automation:

- Whether Telegram visibly received the new HTTPS login URL. The startup log shows Harness generated a token URL and stderr had no notification-failure marker, but Telegram client receipt still requires user-side confirmation.
- Real model, cron, Notion, and Telegram business workflows beyond Web login and HTTP health.

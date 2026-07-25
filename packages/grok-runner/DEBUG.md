# Debugging Grok + Cyrus (fork trial)

> **Full install + Ubuntu + systemd + rollback guide:** see repo-root
> [`FORK_DEVELOPMENT.md`](../../FORK_DEVELOPMENT.md) (delete that file before upstream PR).

## What gets logged

### Console (all of Cyrus)

Controlled by **`CYRUS_LOG_LEVEL`**:

| Level | What you see |
|-------|----------------|
| `DEBUG` | EdgeWorker webhooks, runner selection, Grok ACP steps, MCP list, stderr from `grok` |
| `INFO` (default) | Auth, session id, log file paths, prompt finished |
| `WARN` / `ERROR` | Failures, resume fallbacks |

Format:

```text
2026-07-22T21:00:00.000Z [INFO ] [GrokRunner] Authenticated via cached_token (SuperGrok Heavy)
2026-07-22T21:00:00.000Z [DEBUG] [EdgeWorker] ...
```

Under **systemd** (this host): set `CYRUS_LOG_LEVEL=DEBUG` in **`~/.cyrus/.env`** (loaded by the unit) and read:

```bash
journalctl -u cyrus -f
# or: journalctl -u cyrus -n 200 --no-pager
```

### Session files (per Grok run)

Under **`~/.cyrus/logs/<workspaceName>/`** (or `$CYRUS_HOME/logs/...`):

| File | Contents |
|------|----------|
| `session-grok-<sessionId>-<ts>.jsonl` | SDKMessage bus (what Linear’s pipeline sees): init, tool_use, tool_result, result |
| `acp-wire-grok-<sessionId>-<ts>.jsonl` | Raw ACP `session/update` payloads from Grok |

Claude uses the same logs directory with `session-*.jsonl` / `.md`.

### Grok’s own sessions

`~/.grok/sessions/<encoded-cwd>/<sessionId>/` — Grok Build native transcripts (`updates.jsonl`). Useful if ACP mapping looks wrong but Grok itself ran fine.

---

## Run the fork in debug mode

From the monorepo root (`~/Projects/cyrus` on the proven Ubuntu layout):

### Preferred when systemd owns Cyrus

```bash
# ~/.cyrus/.env
CYRUS_LOG_LEVEL=DEBUG
# Do NOT set CYRUS_DEFAULT_RUNNER=grok for first tests — use Linear label "grok"

sudo systemctl restart cyrus
journalctl -u cyrus -f
```

Confirm the service is running the monorepo entrypoint (not stock npm global):

```bash
ls -la ~/.nvm/versions/node/*/bin/cyrus
readlink -f ~/.nvm/versions/node/$(node -v)/bin/cyrus
# expect: .../Projects/cyrus/apps/cli/dist/src/app.js
```

### Foreground (only if systemd is stopped)

```bash
cd ~/Projects/cyrus
pnpm install && pnpm build

export CYRUS_LOG_LEVEL=DEBUG
# optional force-all-Grok: export CYRUS_DEFAULT_RUNNER=grok

mkdir -p ~/cyrus-debug-logs
node apps/cli/dist/src/app.js start 2>&1 | tee ~/cyrus-debug-logs/cyrus-$(date +%Y%m%d-%H%M%S).log
```

**Do not** `npm install -g` a published package if you want this fork — run from the built monorepo and point the nvm/systemd bin at `apps/cli/dist/src/app.js` (see `FORK_DEVELOPMENT.md` step 3).

### Env checklist

```bash
# In ~/.cyrus/.env (systemd) or shell (foreground):
CYRUS_LOG_LEVEL=DEBUG

# Grok subscription: use `grok login` (no XAI_API_KEY needed)
# Optional: GROK_PATH=$HOME/.grok/bin/grok
# Optional: CYRUS_HOME=/path/to/custom/.cyrus
# Only when ready: CYRUS_DEFAULT_RUNNER=grok
```

### After a bad run — attach these

1. Journal or tee: `journalctl -u cyrus ...` / `~/cyrus-debug-logs/cyrus-*.log`
2. Latest under `~/.cyrus/logs/**/session-grok-*.jsonl`
3. Matching `acp-wire-grok-*.jsonl`
4. Optional: `~/.grok/sessions/.../updates.jsonl` for the same session id
5. Issue identifier + whether label was `grok` / `[agent=grok]`
6. Commit: `cd ~/Projects/cyrus && git rev-parse --short HEAD`

Redact tokens from `.env` / MCP headers before sharing.

---

## Why this helps

| Artifact | Answers |
|----------|---------|
| Console DEBUG | Webhook → runner selection → workspace → Grok start/resume |
| `session-grok-*.jsonl` | Did we emit correct tool_use / result for Linear? |
| `acp-wire-*.jsonl` | Did Grok send the update and we mis-mapped it? |
| `~/.grok/sessions` | Did Grok itself fail or succeed? |

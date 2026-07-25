# Fork development & install (Grok Build support)

> **Temporary doc for this fork.** Delete before opening an upstream PR to `cyrusagents/cyrus`.
>
> Audience: humans **and** coding agents installing this branch on a machine that may already run stock Cyrus.
>
> **Proven on:** Ubuntu host with stock `cyrus-ai@0.2.66` (npm global via nvm), **system** systemd unit
> `/etc/systemd/system/cyrus.service`, clone at `~/Projects/cyrus`, branch `feat/grok-build-support`.
> Adjust paths if your layout differs; the pitfalls below still apply.

---

## What this fork is

| Item | Value |
|------|--------|
| Public fork | https://github.com/gautamjain/cyrus |
| Feature branch | `feat/grok-build-support` |
| Branch URL | https://github.com/gautamjain/cyrus/tree/feat/grok-build-support |
| Upstream | https://github.com/cyrusagents/cyrus |
| Purpose | Add **Grok Build** as a Cyrus agent runner (ACP), alongside Claude / Codex / Cursor / Gemini |

Grok is **additive**. Existing Linear / GitHub / Claude setup in `~/.cyrus` should keep working. Prefer testing Grok via labels, not by switching the global default until you are ready.

---

## Should you use an existing Cyrus machine?

**Yes, if** it already has Linear + GitHub (+ Claude) configured.

- **Keep** `~/.cyrus/` (config, tokens, repos) — do **not** wipe it.
- You only replace the **Cyrus binary/code**, not OAuth integrations.
- Leave `"defaultRunner"` as Claude (or unset). Test Grok with Linear label **`grok`** or description tag **`[agent=grok]`**.

---

## Reference layout (this host)

| Piece | Path / value |
|-------|----------------|
| Fork clone | `~/Projects/cyrus` |
| Stock package (npm global, nvm) | `~/.nvm/versions/node/<ver>/lib/node_modules/cyrus-ai` |
| Stock / service bin | `~/.nvm/versions/node/<ver>/bin/cyrus` |
| systemd unit | `/etc/systemd/system/cyrus.service` (system unit, needs `sudo`) |
| Unit `ExecStart` | absolute path to nvm `bin/cyrus` (not bare `cyrus` on PATH) |
| Unit env file | `EnvironmentFile=/home/<user>/.cyrus/.env` |
| Unit `PATH` | nvm node bin + standard system paths (**no** `~/.local/bin`, **no** `~/.grok/bin`) |
| Config / state | `~/.cyrus/` |
| Grok CLI | `~/.grok/bin/grok` (often also linked as `~/.local/bin/grok`) |
| pnpm global (after setup) | `PNPM_HOME=~/.local/share/pnpm` |

Discover your active install:

```bash
which cyrus
readlink -f "$(which cyrus)"
npm list -g --depth=0 | grep cyrus
cyrus --version
systemctl status cyrus --no-pager   # or: systemctl --user status cyrus
systemctl cat cyrus.service 2>/dev/null || systemctl --user cat cyrus.service
```

---

## Install / replace stock Cyrus (Ubuntu + systemd + nvm)

Assumes: Node 20+ (nvm is fine), git, and an existing `cyrus` from `npm install -g cyrus-ai`.

### 0. Stop the running worker

On this host the service is a **system** unit (not pm2, not `systemctl --user`):

```bash
sudo systemctl stop cyrus
systemctl is-active cyrus.service   # expect: inactive
```

Other setups (for reference only):

```bash
pm2 stop cyrus 2>/dev/null || true
# or: systemctl --user stop cyrus
# or: kill the tmux/screen session running `cyrus`
```

**Note:** Non-interactive agent shells often cannot run `sudo` (no TTY for password). The human must run stop/start/restart in a real terminal.

### 1. Clone this branch

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone -b feat/grok-build-support https://github.com/gautamjain/cyrus.git
cd ~/Projects/cyrus
```

(`gh repo clone gautamjain/cyrus` then `git checkout feat/grok-build-support` is equivalent.)

### 2. Build the monorepo

```bash
cd ~/Projects/cyrus
corepack enable
corepack prepare pnpm@10.33.1 --activate   # matches packageManager in package.json
pnpm --version   # expect 10.33.1
pnpm install
pnpm build
```

#### 2a. cloudflared binary (easy to miss)

pnpm 10 may **ignore** dependency build scripts. You will see a warning like:

```text
Ignored build scripts: ... cloudflared@...
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

Without the postinstall, the Cloudflare tunnel binary is missing and the worker will fail to tunnel when started. Fix once after install:

```bash
# From monorepo root — path version may differ; locate package if needed:
cd ~/Projects/cyrus
CF_PKG=$(find node_modules/.pnpm -path '*/cloudflared@*/node_modules/cloudflared/package.json' | head -1 | xargs dirname)
cd "$CF_PKG"
npm run postinstall
# Expect bin/cloudflared (ELF binary) under that package
ls -la bin/cloudflared
```

Re-check after any clean `pnpm install` that wipes `node_modules`.

### 3. Point `cyrus` at the local CLI

This monorepo uses **pnpm workspaces** (`workspace:*`). Do **not** use `npm link` — it does not resolve workspace packages correctly.

#### 3a. `pnpm setup` + global link (interactive shells)

```bash
pnpm setup
# opens a new shell or:
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

cd ~/Projects/cyrus/apps/cli
pnpm link --global

# Verify link:
ls -la "$PNPM_HOME/global/5/node_modules/cyrus-ai"   # -> .../Projects/cyrus/apps/cli
"$PNPM_HOME/cyrus" --version
```

`pnpm link --global` alone is **not enough** for systemd on this host (see 3b).

#### 3b. Retarget the nvm bin that systemd actually runs (required here)

The unit uses an **absolute** `ExecStart`:

```ini
ExecStart=/home/<user>/.nvm/versions/node/<ver>/bin/cyrus
Environment=PATH=.../node/<ver>/bin:/usr/local/sbin:...
```

That path still points at the **published** `cyrus-ai` package until you retarget it. `~/.local/share/pnpm` and `~/.local/bin` are **not** on the unit’s `PATH`.

```bash
# Use the bin *symlink* path (same as ExecStart), not readlink -f (that resolves to stock app.js).
# node -v is like "v24.18.0" and matches the nvm directory name.
NVM_CYRUS="$HOME/.nvm/versions/node/$(node -v)/bin/cyrus"
FORK_APP="$HOME/Projects/cyrus/apps/cli/dist/src/app.js"

# Cross-check against the unit if present:
# systemctl cat cyrus.service | grep ExecStart

ls -la "$NVM_CYRUS"          # before: -> .../lib/node_modules/cyrus-ai/dist/src/app.js
test -f "$FORK_APP" || { echo "Build first (step 2)"; exit 1; }

ln -sfn "$FORK_APP" "$NVM_CYRUS"

ls -la "$NVM_CYRUS"          # after: -> .../Projects/cyrus/apps/cli/dist/src/app.js
readlink -f "$NVM_CYRUS"
"$NVM_CYRUS" --version
```

Verify Node can load the fork’s Grok package via the CLI entrypoint:

```bash
node -e "
import { createRequire } from 'module';
const require = createRequire(process.env.HOME + '/Projects/cyrus/apps/cli/dist/src/app.js');
const ew = require.resolve('cyrus-edge-worker');
const gr = require.resolve('cyrus-grok-runner', { paths: [ew] });
console.log('edge-worker:', ew);
console.log('grok-runner:', gr);
"
```

Leave the stock package installed under nvm `lib/node_modules/cyrus-ai` — rollback reuses it or reinstalls it.

#### 3c. Alternatives (not used on this host)

**Foreground only** (no global bin change):

```bash
node ~/Projects/cyrus/apps/cli/dist/src/app.js start
```

**PATH wrapper** — only works if the process manager runs `cyrus` from a PATH that includes the wrapper. **Does not work** with an absolute `ExecStart` to nvm’s bin unless you also change the unit.

### 4. Install and log in to Grok Build (subscription)

Skip if `grok models` already shows a logged-in session.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
# Binary lives at ~/.grok/bin/grok (installer may also link ~/.local/bin/grok)

grok login          # browser or: grok login --device-auth
grok models         # expect: logged in + default model (e.g. grok-4.5)
```

Prefer **`grok login`** (subscription). Do **not** set `XAI_API_KEY` unless you intentionally want API billing.

**systemd PATH note:** The unit’s `PATH` often omits `~/.local/bin` and `~/.grok/bin`. That is OK for this fork: `resolveGrokBinary()` checks **`$HOME/.grok/bin/grok` by absolute path** before falling back to `PATH`. Optional belt-and-suspenders in `~/.cyrus/.env`:

```bash
GROK_PATH=/home/<user>/.grok/bin/grok
```

### 5. Config: keep Claude as default while testing

Edit `~/.cyrus/config.json` only if needed. For first tests:

- **Do not** set `"defaultRunner": "grok"` yet.
- Trigger Grok with Linear label **`grok`** / **`xai`**, or issue description **`[agent=grok]`**.

Default runner logic (when unset): auto-detect from env keys; with only Claude credentials → **claude**. Grok subscription login (`~/.grok/auth.json`) does **not** flip the default (by design).

When ready to default everything to Grok:

```json
{
  "defaultRunner": "grok"
}
```

Or env: `CYRUS_DEFAULT_RUNNER=grok`.

### 6. Debug logging + start the service

#### Logging under systemd

Do **not** rely on `cyrus start 2>&1 | tee ...` while the **systemd unit** owns the process. Logs go to the journal; env comes from `~/.cyrus/.env`.

```bash
# In ~/.cyrus/.env (already loaded by the unit):
CYRUS_LOG_LEVEL=DEBUG
```

Then:

```bash
sudo systemctl start cyrus
systemctl status cyrus --no-pager
journalctl -u cyrus -f
# or last lines:
journalctl -u cyrus -n 100 --no-pager
```

Optional: also capture journal to a file for bug reports:

```bash
mkdir -p ~/cyrus-debug-logs
journalctl -u cyrus -f | tee ~/cyrus-debug-logs/cyrus-$(date +%Y%m%d-%H%M%S).log
```

#### Foreground start (only if not using systemd)

```bash
export CYRUS_LOG_LEVEL=DEBUG
export PATH="$HOME/.grok/bin:$PATH"
mkdir -p ~/cyrus-debug-logs
node ~/Projects/cyrus/apps/cli/dist/src/app.js start 2>&1 | tee ~/cyrus-debug-logs/cyrus-$(date +%Y%m%d-%H%M%S).log
```

### 7. Smoke-check Grok from Linear

1. Create or pick a Linear issue on a repo Cyrus already handles.
2. Add label **`grok`** (or put `[agent=grok]` in the description).
3. Assign / delegate to Cyrus as you normally do.
4. Confirm agent activity: model thought, tool actions, final response.
5. Post a follow-up comment and confirm a second turn (resume) works.

---

## Logging (what agents should collect)

### Console levels

Set **`CYRUS_LOG_LEVEL`** to one of: `DEBUG` | `INFO` | `WARN` | `ERROR` | `SILENT`.

Default is `INFO`. Use **`DEBUG`** for fork trials (put it in `~/.cyrus/.env` for systemd).

Lines look like:

```text
2026-07-22T21:00:00.000Z [INFO ] [EdgeWorker] ...
2026-07-22T21:00:00.000Z [DEBUG] [GrokRunner] Spawning ACP: ...
```

Covers **all** of Cyrus (EdgeWorker, webhooks, Claude, etc.), not only Grok.

### Session files (Grok runner)

Written under **`~/.cyrus/logs/<workspaceName>/`** (or `$CYRUS_HOME/logs/...`):

| Pattern | Contents |
|---------|----------|
| `session-grok-<sessionId>-*.jsonl` | SDKMessage bus (what Linear activity pipeline sees) |
| `acp-wire-grok-<sessionId>-*.jsonl` | Raw ACP `session/update` payloads from Grok |

Paths are logged at INFO when a Grok session starts.

### Grok Build native sessions

`~/.grok/sessions/<url-encoded-cwd>/<sessionId>/` (e.g. `updates.jsonl`) — Grok’s own transcript. Useful when mapping looks wrong but Grok itself ran fine.

### Claude / other runners

Same `~/.cyrus/logs/` tree; Claude also writes `session-*.jsonl` / `.md`.

---

## What to attach when reporting a bug

1. Journal or tee capture: `journalctl -u cyrus ...` / `~/cyrus-debug-logs/cyrus-*.log`
2. Latest `~/.cyrus/logs/**/session-grok-*.jsonl`
3. Matching `acp-wire-grok-*.jsonl`
4. Optional: `~/.grok/sessions/.../updates.jsonl` for the same session id
5. Linear issue id + how Grok was selected (label / tag / defaultRunner)
6. Commit: `cd ~/Projects/cyrus && git rev-parse --short HEAD`
7. What `cyrus` resolves to: `ls -la ~/.nvm/versions/node/*/bin/cyrus` and `readlink -f` of that path

**Redact** tokens in `.env`, MCP `Authorization` headers, and auth dumps before sharing.

---

## Rollback to stock Cyrus

Goal: restore the published npm package as the binary systemd runs, without touching `~/.cyrus` integrations.

Pin the version you came from when possible (this host used **`0.2.66`**). Prefer that over `@latest` if you need an exact restore.

```bash
# 0) Stop the fork worker (system unit — needs a real terminal for sudo)
sudo systemctl stop cyrus
systemctl is-active cyrus.service   # expect: inactive

# 1) Undo pnpm global link (if you ran pnpm link --global)
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"
cd ~/Projects/cyrus/apps/cli
pnpm unlink --global 2>/dev/null || true
# If a global package entry remains:
#   pnpm remove -g cyrus-ai 2>/dev/null || true

# 2) Remove optional PATH wrapper (only if you created one)
rm -f ~/.local/bin/cyrus

# 3) Reinstall published package into the same nvm prefix the unit uses
#    This recreates: ~/.nvm/versions/node/<ver>/bin/cyrus
#                 -> .../lib/node_modules/cyrus-ai/dist/src/app.js
hash -r
npm install -g cyrus-ai@0.2.66
# or: npm install -g cyrus-ai@latest   # only if you accept moving with latest

# 4) Verify stock binary (must match ExecStart path)
NVM_CYRUS="$HOME/.nvm/versions/node/$(node -v)/bin/cyrus"
ls -la "$NVM_CYRUS"
readlink -f "$NVM_CYRUS"    # expect: .../lib/node_modules/cyrus-ai/dist/src/app.js
"$NVM_CYRUS" --version      # expect published version, e.g. 0.2.66

# Optional: confirm Grok runner is NOT loadable from stock package
node -e "
import { createRequire } from 'module';
const p = process.env.HOME + '/.nvm/versions/node/' + process.version + '/lib/node_modules/cyrus-ai/dist/src/app.js';
const require = createRequire(p);
try {
  require.resolve('cyrus-grok-runner', { paths: [require.resolve('cyrus-edge-worker')] });
  console.log('UNEXPECTED: grok-runner still resolves');
} catch {
  console.log('OK: stock package has no cyrus-grok-runner');
}
" 2>/dev/null || echo "OK: stock resolve check finished"

# 5) Start stock service again
#    Leave CYRUS_LOG_LEVEL=DEBUG in .env if you want, or set back to INFO
sudo systemctl start cyrus
systemctl status cyrus --no-pager
journalctl -u cyrus -n 50 --no-pager
```

### Rollback notes

| Keep | Discard / restore |
|------|-------------------|
| `~/.cyrus/` (config, tokens, repos, worktrees) | nvm bin symlink → published package |
| Grok CLI install + `~/.grok/auth.json` | pnpm global link to monorepo |
| Fork git clone (optional; safe to leave on disk) | monorepo only needed if you re-enable the fork |

You do **not** need to delete `~/Projects/cyrus` to roll back. Re-enable the fork later by rebuilding (if needed), re-running `pnpm link --global`, re-pointing the nvm bin (step 3b), and `sudo systemctl restart cyrus`.

If `npm install -g cyrus-ai@0.2.66` does not fix the bin symlink (rare), force it:

```bash
STOCK_APP="$HOME/.nvm/versions/node/$(node -v)/lib/node_modules/cyrus-ai/dist/src/app.js"
NVM_CYRUS="$HOME/.nvm/versions/node/$(node -v)/bin/cyrus"
test -f "$STOCK_APP" && ln -sfn "$STOCK_APP" "$NVM_CYRUS"
```

---

## Update the fork later

```bash
sudo systemctl stop cyrus   # optional but cleaner during rebuild

cd ~/Projects/cyrus
git fetch origin
git checkout feat/grok-build-support
git pull origin feat/grok-build-support
pnpm install
pnpm build
# Re-run cloudflared postinstall if install wiped ignored build scripts (step 2a)
# Confirm nvm bin still points at monorepo app.js (step 3b)

sudo systemctl start cyrus
# or: sudo systemctl restart cyrus
```

Remotes on a typical clone of this fork:

```bash
git remote -v
# origin    -> gautamjain/cyrus
# upstream  -> cyrusagents/cyrus   (if gh clone added it)
```

---

## Grok turn timeouts (idle, not wall-clock)

The Grok runner no longer kills a turn after a fixed 1 hour. Like Codex:

- **Control-plane** RPCs (initialize, auth, session load) keep a wall-clock bound (**60s**, same as Codex).
- **`session/prompt`** uses an **idle watchdog** (default **5 minutes** of silence).
  Any ACP activity (`session/update` notifications, reverse RPCs) resets the timer.
  Long productive turns (multi-hour with tools/subagents) are allowed.

Override:

```bash
# ~/.cyrus/.env — milliseconds of *silence* before failing the turn
# 0 = disable idle watchdog (only process exit / stop ends the turn)
GROK_TURN_IDLE_TIMEOUT_MS=300000
```

Or `turnIdleTimeoutMs` on runner config when constructing `GrokRunner` in code.

Error strings:

- `ACP request idle timeout: session/prompt (no activity for …ms)` — true silence
- `ACP request timed out: session/prompt` — legacy wall-clock (should no longer appear on prompts)
- `ACP client closed` — process killed/teardown (e.g. overlapping Linear prompts)

---

## Pitfalls (learned on this host)

1. **`systemctl --user` vs system unit** — this install uses `/etc/systemd/system/cyrus.service` → always `sudo systemctl … cyrus`.
2. **`pnpm link --global` ≠ what systemd runs** — unit `ExecStart` is an absolute nvm path; retarget that symlink (step 3b).
3. **`npm link` is wrong** for this monorepo (`workspace:*` deps).
4. **`pnpm` not on PATH** until corepack prepare / `pnpm setup` (`PNPM_HOME`).
5. **Ignored build scripts** → missing `cloudflared` binary → tunnel failure at runtime.
6. **DEBUG + systemd** → set `CYRUS_LOG_LEVEL` in `~/.cyrus/.env`, read logs with `journalctl -u cyrus`, not only `tee` on a foreground process.
7. **Sudo needs a TTY** — agents cannot always stop/start the service; humans run those commands.
8. **Grok on PATH under systemd** — often missing; absolute `~/.grok/bin/grok` resolution covers it.

---

## Agent checklist (short)

```text
[ ] sudo systemctl stop cyrus  (human terminal if needed)
[ ] Clone gautamjain/cyrus @ feat/grok-build-support → ~/Projects/cyrus
[ ] corepack + pnpm@10.33.1; pnpm install && pnpm build
[ ] cloudflared postinstall if build scripts were ignored
[ ] pnpm setup; pnpm link --global from apps/cli
[ ] ln -sfn monorepo apps/cli/dist/src/app.js → nvm bin/cyrus (systemd ExecStart)
[ ] Verify resolve cyrus-grok-runner from monorepo entrypoint
[ ] grok login && grok models (skip if already logged in)
[ ] Keep defaultRunner unset/Claude; use label "grok" for tests
[ ] CYRUS_LOG_LEVEL=DEBUG in ~/.cyrus/.env
[ ] sudo systemctl start cyrus; journalctl -u cyrus -f
[ ] One Linear issue with label grok; collect session-grok + acp-wire + journal if issues
```

### Rollback checklist

```text
[ ] sudo systemctl stop cyrus
[ ] pnpm unlink --global (from apps/cli) / remove pnpm global cyrus-ai
[ ] npm install -g cyrus-ai@0.2.66  (or the version you came from)
[ ] Confirm nvm bin/cyrus → stock package dist/src/app.js
[ ] sudo systemctl start cyrus
[ ] Leave ~/.cyrus intact
```

---

## Related files in this repo

| Path | Notes |
|------|--------|
| `packages/grok-runner/README.md` | Package overview |
| `packages/grok-runner/DEBUG.md` | Shorter logging notes |
| `skills/cyrus-setup-grok-auth/SKILL.md` | Guided Grok login skill |
| `docs/SELF_HOSTING.md` | General self-host + Grok auth blurb |

---

## Delete before upstream PR

```bash
git rm FORK_DEVELOPMENT.md
# optionally also packages/grok-runner/DEBUG.md if you want a cleaner PR
git commit -m "chore: remove fork-only development docs before upstream PR"
```

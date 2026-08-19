---
name: cyrus-setup-grok-auth
description: Configure Grok Build authentication for Cyrus via browser login (Grok subscription).
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env`, `~/.grok/auth.json`, or any credential file. Use only `Bash` commands that do not print secrets.**

# Setup Grok Build Auth

Configures Grok Build so Cyrus can run agent sessions on the user's **Grok subscription** (e.g. SuperGrok Heavy), the same way the `grok` CLI does — browser login, not per-token API billing.

## How it works

1. User installs the Grok Build CLI
2. User runs `grok login` which **opens a browser** to auth.x.ai
3. Credentials are stored in `~/.grok/auth.json` (managed by Grok Build)
4. Cyrus spawns `grok agent stdio` and authenticates with ACP `cached_token`

Cyrus does **not** need a copy of tokens in `~/.cyrus/.env` for the happy path.

Optional: `XAI_API_KEY` is only for CI / headless hosts without browser login, and bills via the xAI API (avoid for personal subscription use).

## Step 1: Check Grok CLI

```bash
command -v grok || test -x "$HOME/.grok/bin/grok" && echo "found" || echo "missing"
```

If missing, install:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Ensure `~/.grok/bin` is on PATH (the installer usually adds this). Verify:

```bash
grok version
```

## Step 2: Check existing login

```bash
# Safe: does not print tokens
test -f "$HOME/.grok/auth.json" && echo "auth.json present" || echo "auth.json missing"
grok models 2>&1 | head -20
```

If output includes `You are logged in with grok.com` (or similar) and lists a default model, auth is ready.

If already logged in:

> Grok Build authentication is already configured. Skipping this step.
> To re-login, run `grok logout` then `grok login`.

Skip to completion.

## Step 3: Browser login (subscription)

Tell the user:

> 1. Run this in a terminal on the machine that will host Cyrus:
>
> ```bash
> grok login
> ```
>
> 2. A browser window will open to sign in with your Grok account (subscription / SuperGrok Heavy).
> 3. After success, return here.

On headless servers without a browser, use:

```bash
grok login --device-auth
```

Then complete the device code flow on another device.

**Do not** recommend pasting an API key unless the user explicitly cannot use browser login and accepts console API billing.

## Step 4: Verify

```bash
test -f "$HOME/.grok/auth.json" && echo "auth.json present" || echo "auth.json missing"
grok models 2>&1 | head -20
```

Success criteria:

- `auth.json present`
- `grok models` shows logged in and a default model (currently `grok-4.5`)

If still missing, re-run Step 3.

## Step 5: Make Grok the default runner (recommended if Grok-only)

Browser login alone does **not** auto-select Grok as the default harness (other agents may also be installed). Set:

```json
{
  "defaultRunner": "grok"
}
```

in `~/.cyrus/config.json` (or use env `CYRUS_DEFAULT_RUNNER=grok`).

Alternatively, per-issue:

- Linear label **`grok`** (or `xai`)
- Description tag **`[agent=grok]`**

## Completion

> ✓ Grok Build authentication configured (browser subscription login).
> Cyrus will use `cached_token` from your Grok CLI session — same account as interactive `grok`.
>
> Trigger a session with Linear label **grok** or `[agent=grok]` in the issue description.

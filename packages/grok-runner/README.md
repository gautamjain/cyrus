# cyrus-grok-runner

Grok Build harness for Cyrus. Spawns `grok agent stdio` (ACP) and maps session events to Cyrus's Claude-shaped `SDKMessage` bus so Linear (and other trackers) get the same tool timeline as other runners.

## Auth (subscription-first)

1. Install Grok Build and run **`grok login`** (browser OAuth → `~/.grok/auth.json`)
2. At session start, ACP authenticates with **`cached_token`**
3. Prefer this over `XAI_API_KEY` so usage stays on your Grok subscription

## Model default

Omit model / use sentinel `"default"` so Grok Build picks its current default (`grok models`). Override with config `grokDefaultModel`, issue label, or `[model=…]`.

## Select this runner

- Linear label: `grok` (or `xai`)
- Description tag: `[agent=grok]`
- Config: `"defaultRunner": "grok"`

## Architecture

```
GrokRunner
  → AcpClient (JSON-RPC over stdio)
  → grok agent --always-approve stdio
  → GrokEventMapper (ACP session/update → SDKMessage)
  → GrokMessageFormatter (Linear activity text)
```

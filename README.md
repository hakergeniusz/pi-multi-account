# Multi-Account Extension

Allows using **multiple API accounts for the same provider** to effectively double your rate limits. For example, with two OpenCode API keys, you can cycle between them to avoid hitting usage caps.

## How It Works

1. You define multiple accounts (each with its own API key) for a provider in a JSON config file.
2. The extension registers **virtual providers** — one per account — each pointing to the same API endpoint with the same models but a different API key.
3. You switch between accounts via `/account` command or `Alt+A` shortcut. The current model is preserved; only the API key changes.

## Installation

```bash
pi install git:github.com/hakergeniusz/pi-multi-account
```

Or copy it manually into your Pi extensions directory:

```
~/.pi/agent/extensions/multi-account/index.ts
```

Then:

1. Create the config file at `~/.pi/agent/multi-account.json`.
2. Start Pi: `pi`.
3. Select a virtual provider's model via `/model` (e.g., `opencode-primary/kimi-k2.6`).

## Config File

**Location:** `~/.pi/agent/multi-account.json` (global) or `<cwd>/.pi/multi-account.json` (project-local, merged on top of global).

### Fields

| Field | Description |
|-------|-------------|
| `providers` | Map of provider definitions (see below) |
| `cycleShortcut` | Shortcut key for cycling accounts (default: `alt+a`) |

### Provider fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name (defaults to the key) |
| `baseUrl` | Yes | API endpoint URL |
| `api` | Yes | API type: `openai-completions`, `openai-responses`, `openai-codex-responses`, `anthropic-messages`, etc. |
| `accounts` | Yes | Array of accounts (see below) |
| `models` | No | Static model list (see `ProviderModelConfig`) |
| `modelUrl` | No | URL to fetch models from (dynamic discovery) |
| `headers` | No | Static headers applied to all requests |
| `authHeader` | No | If `true`, adds `Authorization: Bearer` header |
| `sessionHeaders` | No | Dynamic headers (supports `"$sessionId"`) |
| `compat` | No | Provider-level compatibility settings |

### Account fields

| Field | Required | Description |
|-------|----------|-------------|
| `label` | Yes | Human-readable name (used in provider display name and status) |
| `apiKey` | Yes | API key (supports `$ENV_VAR`, `!command`, or literal values) |
| `headers` | No | Per-account headers (merged on top of provider headers) |

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/account` | Show interactive selector with all accounts; pick one to switch |
| `/account list` | Same as `/account` (opens selector) |
| `/account cycle` | Switch to the next account (same model, different API key) |
| `/account <label>` | Switch to a specific account by label (e.g., `/account secondary`) |

### Shortcut

| Key | Action |
|-----|--------|
| `Alt+A` | Cycle to the next account |

### Status Bar

The footer shows `acc: <label>` when the current model is on a multi-account provider.

## Example: Two OpenCode Accounts

```json
{
  "providers": {
    "opencode": {
      "name": "OpenCode",
      "baseUrl": "https://api.open-code.ai/v1",
      "api": "openai-codex-responses",
      "sessionHeaders": {
        "x-opencode-session": "$sessionId",
        "x-opencode-client": "pi"
      },
      "accounts": [
        { "label": "Primary",   "apiKey": "$OPENCODE_API_KEY_1" },
        { "label": "Secondary", "apiKey": "$OPENCODE_API_KEY_2" }
      ],
      "models": [
        {
          "id": "kimi-k2.6",
          "name": "Kimi K2.6",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1.1, "output": 4.4, "cacheRead": 0.275, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 64000
        }
      ]
    }
  }
}
```

This registers two virtual providers:
- `opencode-primary` — same as OpenCode, API key from `$OPENCODE_API_KEY_1`
- `opencode-secondary` — same endpoint, API key from `$OPENCODE_API_KEY_2`

Both expose the same model `kimi-k2.6`. When you press `Alt+A`, pi switches from `opencode-primary/kimi-k2.6` to `opencode-secondary/kimi-k2.6` (or vice versa), effectively doubling your rate limit.

## Example: OpenAI with Two API Keys

```json
{
  "providers": {
    "openai": {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-responses",
      "accounts": [
        { "label": "Work",    "apiKey": "$OPENAI_WORK_KEY" },
        { "label": "Personal", "apiKey": "$OPENAI_PERSONAL_KEY" }
      ],
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 1.0, "output": 5.0, "cacheRead": 0.25, "cacheWrite": 2.5 },
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

## Example: Dynamic Model Discovery

If the provider supports a `/v1/models` endpoint, use `modelUrl` instead of listing models:

```json
{
  "providers": {
    "ollama": {
      "name": "Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "accounts": [
        { "label": "Local", "apiKey": "ollama" }
      ],
      "modelUrl": "http://localhost:11434/v1/models"
    }
  }
}
```

## How Account Switching Works

When you cycle accounts:

1. The extension checks the current model (e.g., `opencode-primary/kimi-k2.6`).
2. It determines which account group the model belongs to (`opencode`, account index 0).
3. It calculates the next account index (1).
4. It looks up the same model ID (`kimi-k2.6`) on the next account's virtual provider (`opencode-secondary`).
5. It calls `pi.setModel()` to switch, preserving your thinking level, tools, and conversation context.

The active account index is persisted in the session, so it survives restarts.

## Notes

- Each virtual provider is a fully independent Pi provider. You can select any of them via `/model`.
- The `apiKey` field supports environment variable interpolation (`$VAR` or `${VAR}`), shell command execution (`!command`), and literal values.
- The `sessionHeaders` field supports the special `"$sessionId"` value, which is replaced with the current Pi session ID at request time. This is useful for providers like OpenCode that track sessions.
- Project-local config (`.pi/multi-account.json`) is only loaded for trusted projects.

## Auto-Switch on Failure

When a request fails for **any reason** — rate limit, quota, auth, 404, 5xx,
billing, or anything unclassified — the extension automatically switches to the
next account and retries, until **every account in the group has been tried and
failed**. Only then does the error surface.

**Router models are left alone.** When the selected model is a virtual router
(`api: "pi-virtual"`, e.g. `google/gemini-flash` from `pi-gemini-router` or
`poolside/laguna-s` from `pi-poolside-router`), the router owns the account
choice for every request it routes. Switching the session model to a physical
`provider-keyN` would abandon the router and its ladder, so the switch is
skipped and the router rotates on its own. The same applies to `/account cycle`,
`Alt+A`, and `/account <label>`.

| Config field | Default | Description |
|--------------|---------|-------------|
| `autoSwitchOnFailure` | `true` | Auto-switch account on any failure |
| `autoRetry` | `true` | Also auto-resend the last prompt after switching (only when no tools ran yet, to avoid duplicating tool actions) |

Example:

```json
{
  "autoSwitchOnFailure": true,
  "autoRetry": true,
  "providers": { "...": "..." }
}
```

**How it works:**
1. Assistant response ends with `stopReason: "error"`.
2. User-abort/cancel errors are the only ones skipped — rotating accounts
cannot help when the user gave up. Everything else rotates, including errors
that look fatal (a 404 on one key may just mean that key lacks access).
3. The extension switches to the next account (same model) and notifies you.
4. If `autoRetry` is not disabled and no tools ran in the failed turn, the last
prompt is automatically resent — so rotation continues without interaction.
5. Loop protection: after cycling through all accounts without success (N
switches for N accounts), it stops, warns that all accounts are exhausted, and
the original error surfaces. The counter resets on the next successful
response.
6. If tools already ran in the failed turn, the account still switches but the
prompt is **not** auto-resent (resending would duplicate tool actions);
resend manually and the fresh account is used.

**Manual fallback:** press `Alt+A` or run `/account cycle` at any time.

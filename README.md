# proxy-acpx-x

[![npm version](https://img.shields.io/npm/v/proxy-acpx-x.svg)](https://www.npmjs.com/package/proxy-acpx-x)

ACP adapters and OpenAI-compatible HTTP proxy for routing traffic through **Claude Code CLI**, **Codex CLI**, or **Gemini CLI** — use your existing CLI subscription auth instead of separate API keys.

## Quick Start

```bash
# 1. Install
npm install -g proxy-acpx-x

# 2. Authenticate Claude Code CLI
claude auth login

# 3. Start the proxy server (daemon mode)
proxy-acpx-server -d

# 4. Edit ~/.openclaw/openclaw.json — add models section:
#    "models": {
#      "providers": {
#        "claude-local": {
#          "api": "openai-completions",
#          "baseUrl": "http://127.0.0.1:52088/v1",
#          "apiKey": "sk-dummy-key",
#          "models": [{"id": "claude-code-proxy", "name": "Claude Code Proxy"}]
#        }
#      }
#    }

# 5. Set as default model
openclaw models set claude-code-proxy

# 6. Test with curl
curl http://127.0.0.1:52088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is 2+2?"}],"stream":true}'

# Done — talk to OpenClaw, all requests route through Claude Code CLI
```

---

## Supported Backends

| Backend | ACP Adapter | HTTP Server | CLI Used |
|---------|-------------|-------------|----------|
| **Claude Code** | `proxy-acpx-claude` | `proxy-acpx-server` | `claude` |
| **Codex CLI** | `proxy-acpx-codex` | — | `codex` |
| **Gemini CLI** | `proxy-acpx-gemini` | — | `gemini` |

## Architecture

```
HTTP Server mode (recommended for OpenClaw model provider):
  OpenClaw → POST /v1/chat/completions → proxy-acpx-server → claude CLI → Anthropic API
                                          (port 52088)

ACP Adapter mode:
  OpenClaw → openclaw acp client → proxy-acpx-claude → claude CLI → Anthropic API
  OpenClaw → openclaw acp client → proxy-acpx-codex  → codex CLI  → OpenAI API
  OpenClaw → openclaw acp client → proxy-acpx-gemini → gemini CLI → Google AI API
```

> **Naming:** `proxy-acpx-x` where `x` is the target CLI — `proxy-acpx-claude`, `proxy-acpx-codex`, `proxy-acpx-gemini`.

---

## Quick Start

### Step 1: Install

```bash
npm install -g proxy-acpx-x
```

Verify the binaries are available:
```bash
proxy-acpx-server --help
proxy-acpx-claude --help  # (no --help, but should not error)
```

### Step 2: Authenticate the target CLI

```bash
# For Claude Code
claude auth status          # check login
claude auth login           # login if needed

# For Codex
codex                       # first run triggers auth

# For Gemini
gemini                      # first run triggers auth
```

### Step 3: Start the HTTP proxy server

```bash
# Foreground (see logs in terminal)
proxy-acpx-server

# As background daemon
proxy-acpx-server -d

# Custom port
proxy-acpx-server -p 9000
proxy-acpx-server -d -p 9000

# Manage daemon
proxy-acpx-server --status   # check if running
proxy-acpx-server --stop     # stop daemon
```

Server starts at `http://127.0.0.1:52088` by default.

### Step 4: Configure OpenClaw model provider

Edit `~/.openclaw/openclaw.json` — **merge** this `models` block into your existing config:

```json
{
  "meta": { "..." : "keep your existing meta" },
  "commands": { "..." : "keep your existing commands" },
  "gateway": { "..." : "keep your existing gateway" },
  "models": {
    "providers": {
      "claude-local": {
        "api": "openai-completions",
        "baseUrl": "http://127.0.0.1:52088/v1",
        "apiKey": "sk-dummy-key",
        "models": [{"id": "claude-code-proxy", "name": "Claude Code Proxy"}]
      }
    }
  }
}
```

> **Important:** Don't replace the whole file. Add the `models` section alongside your existing `meta`, `commands`, `gateway` sections.

> **Custom port?** If you used `-p 9000`, change `baseUrl` to `http://127.0.0.1:9000/v1`.

### Step 5: Set as default model and verify

```bash
openclaw models set claude-code-proxy
openclaw models status
```

### Step 6: Test

Talk to OpenClaw — all requests now route through Claude Code CLI with your subscription auth.

**Test with curl:**
```bash
curl http://127.0.0.1:52088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is 2+2?"}],"stream":true}'
```

**Test model listing:**
```bash
curl http://127.0.0.1:52088/v1/models
```

---

## HTTP Server Reference

**Command:** `proxy-acpx-server`

```
Usage:
  proxy-acpx-server [options]

Options:
  -p, --port <port>    Port (default: 52088)
  -H, --host <host>    Host (default: 127.0.0.1)
  -m, --model <name>   Model name (default: claude-code-proxy)
  -d, --daemon         Run as background daemon
  --stop               Stop running daemon
  --status             Check daemon status
  -h, --help           Show help

Environment variables:
  PROXY_ACPX_PORT      Same as --port
  PROXY_ACPX_HOST      Same as --host
  PROXY_ACPX_MODEL     Same as --model
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming SSE or JSON) |

**PID file:** `~/.proxy-acpx-server.pid`

---

## ACP Adapters (alternative to HTTP server)

For direct ACP protocol usage without the HTTP wrapper:

```bash
# Via OpenClaw ACP client
openclaw acp client --server "proxy-acpx-claude" --verbose
openclaw acp client --server "proxy-acpx-codex" --verbose
openclaw acp client --server "proxy-acpx-gemini" --verbose

# Via stdin (raw ACP messages)
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; \
 sleep 2; \
 echo '{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2?"}]}}'; \
 sleep 30) | proxy-acpx-claude
```

---

## Protocol Mapping

<details>
<summary>Claude Code Adapter</summary>

**Input:** ACP → `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`

| ACP | Claude Code stream-json |
|-----|------------------------|
| `session/prompt { prompt }` | `{"type":"user","message":{"role":"user","content":"…"}}` on stdin |
| `session/cancel` | SIGTERM |
| `session/close` | Close stdin + SIGTERM |

**Output:** Claude Code stream-json → ACP

| Claude event | ACP |
|-------------|-----|
| `stream_event { content_block_delta, text_delta }` | `session/update { agent_message_chunk }` |
| `stream_event { content_block_stop }` (after tool_use) | `session/update { tool_call }` |
| `result { subtype: "success" }` | prompt response (end_turn) |

Reference: [Claude Code headless docs](https://code.claude.com/docs/en/headless)

</details>

<details>
<summary>Codex CLI Adapter</summary>

**Input:** ACP → `codex exec --json --full-auto "<prompt>"`

| ACP | Codex CLI |
|-----|----------|
| `session/prompt` (1st) | `codex exec --json --full-auto "…"` |
| `session/prompt` (2nd+) | `codex exec resume --last --json "…"` |

**Output:** Codex JSON Lines → ACP

| Codex event | ACP |
|------------|-----|
| `item.created { message }` | `session/update { agent_message_chunk }` |
| `item.created { tool_use }` | `session/update { tool_call }` |
| `turn.completed` | prompt response (end_turn) |

Reference: [Codex CLI docs](https://developers.openai.com/codex/cli)

</details>

<details>
<summary>Gemini CLI Adapter</summary>

**Input:** ACP → `gemini --output-format stream-json --yolo "<prompt>"`

| ACP | Gemini CLI |
|-----|-----------|
| `session/prompt` (1st) | `gemini --output-format stream-json --yolo "…"` |
| `session/prompt` (2nd+) | `gemini ... --resume latest "…"` |

**Output:** Gemini stream-json → ACP

| Gemini event | ACP |
|-------------|-----|
| `message { role: "assistant" }` | `session/update { agent_message_chunk }` |
| `tool_use { tool_name }` | `session/update { tool_call }` |
| `result { status: "success" }` | prompt response (end_turn) |

Reference: [Gemini CLI docs](https://geminicli.com/docs/cli/headless) | [GitHub](https://github.com/google-gemini/gemini-cli)

</details>

---

## Installation from Source

```bash
git clone https://github.com/clonn/proxy-acpx-x.git
cd proxy-acpx-x
npm install
npm run build

# HTTP server
node dist/http-server.js

# ACP adapters
node dist/adapter.js          # Claude
node dist/codex-adapter.js    # Codex
node dist/gemini-adapter.js   # Gemini
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm start            # Run HTTP server
npm run start:acp    # Run Claude ACP adapter
```

## Testing

```bash
npm test             # 97 unit + integration tests (vitest)
npm run test:watch   # Watch mode
npm run test:smoke   # 24 shell smoke tests (8 per adapter)
```

**Test files:**
- `test/protocol.test.ts` — 24 tests: ACP ↔ Claude stream-json
- `test/codex-protocol.test.ts` — 16 tests: ACP ↔ Codex JSON Lines
- `test/gemini-protocol.test.ts` — 15 tests: ACP ↔ Gemini stream-json
- `test/adapter-acp.test.ts` — 42 tests: integration (all 3 adapters as child processes)
- `test/smoke.sh` — 24 tests: E2E shell tests

## Troubleshooting

**"Failed to spawn claude/codex/gemini"** — CLI not in PATH. Run `which claude` / `which codex` / `which gemini`.

**`[object Object]` in responses** — Update to latest version: `npm install -g proxy-acpx-x@latest`

**No output** — Check stderr logs: `[proxy-acpx-x:http]`, `[proxy-acpx-x]`, `[proxy-acpx-x:codex]`, `[proxy-acpx-x:gemini]`.

**Auth errors (Claude)** — Run `claude auth login`. The server does NOT use `--bare` so subscription auth works.

**Context overflow in OpenClaw** — Normal on first request with large system prompts. OpenClaw auto-compacts and retries.

## References

- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Agent SDK streaming](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Gemini CLI headless](https://geminicli.com/docs/cli/headless)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [npm package](https://www.npmjs.com/package/proxy-acpx-x)

## License

MIT

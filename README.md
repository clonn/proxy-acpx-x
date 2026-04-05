# proxy-acpx-x

ACP adapters for routing OpenClaw/acpx traffic through **Claude Code CLI** or **Codex CLI**, enabling subscription-based authentication instead of requiring separate API keys.

## Supported Backends

| Backend | Command | CLI Used |
|---------|---------|----------|
| **Claude Code** | `proxy-acpx-x` | `claude -p --input-format stream-json --output-format stream-json` |
| **Codex CLI** | `proxy-acpx-x-codex` | `codex exec --json --full-auto` |

## Architecture

```
Claude Code backend:
  OpenClaw → acpx → proxy-acpx-x       → claude CLI (stream-json) → Anthropic API

Codex CLI backend:
  OpenClaw → acpx → proxy-acpx-x-codex → codex exec (JSON Lines)  → OpenAI API
```

Both adapters are thin NDJSON translators. The ACP side is identical — only the CLI protocol differs.

---

## Claude Code Adapter

### Protocol Mapping

**Input: ACP → Claude Code CLI stdin** (`--input-format stream-json`)

| ACP (from acpx)                           | Claude Code stream-json stdin                                       |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `session/prompt { prompt: [{text:"…"}] }` | `{"type":"user","message":{"role":"user","content":"…"}}`           |
| `session/cancel`                          | SIGTERM to child process                                            |
| `session/close`                           | Close stdin + SIGTERM                                               |

**Output: Claude Code CLI stdout → ACP** (`--output-format stream-json`)

| Claude Code stream-json stdout                                                  | ACP (to acpx)                    |
| ------------------------------------------------------------------------------- | -------------------------------- |
| `stream_event { event: { type: "content_block_delta", delta: { text } } }`      | `session/update { agent_message_chunk }` |
| `stream_event { event: { type: "content_block_start", content_block: { type: "tool_use" } } }` | (tracked internally)   |
| `stream_event { event: { type: "content_block_stop" } }` (after tool_use)      | `session/update { tool_call }`   |
| `{ type: "result", subtype: "success" }`                                        | prompt response (stopReason: end_turn) |
| `{ type: "system", subtype: "api_retry" }`                                     | logged to stderr                 |

### CLI Flags

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --bare \
  --permission-mode bypassPermissions
```

| Flag | Purpose |
| ---- | ------- |
| `-p` | Non-interactive (print) mode |
| `--input-format stream-json` | Accept NDJSON messages on stdin |
| `--output-format stream-json` | Emit NDJSON streaming events on stdout |
| `--verbose` | Full turn-by-turn output |
| `--include-partial-messages` | Emit `stream_event` with real-time text/tool deltas |
| `--bare` | Skip hooks, plugins, MCP, CLAUDE.md for fast startup |
| `--permission-mode bypassPermissions` | Auto-approve all tools (required for non-interactive ACP) |

Reference: [Claude Code headless docs](https://code.claude.com/docs/en/headless)

---

## Codex CLI Adapter

### Protocol Mapping

**Input: ACP → Codex CLI** (spawns `codex exec` per prompt)

| ACP (from acpx)                           | Codex CLI                                  |
| ----------------------------------------- | ------------------------------------------ |
| `session/prompt { prompt: [{text:"…"}] }` | `codex exec --json --full-auto "…"`        |
| `session/prompt` (2nd+)                   | `codex exec resume --last --json "…"`      |
| `session/cancel`                          | SIGTERM to child process                   |
| `session/close`                           | SIGTERM + reset session                    |

**Output: Codex CLI JSON Lines → ACP**

| Codex exec event                                          | ACP (to acpx)                    |
| --------------------------------------------------------- | -------------------------------- |
| `item.created { item: { type: "message", content } }`    | `session/update { agent_message_chunk }` |
| `item.created { item: { type: "tool_use" } }`            | `session/update { tool_call }`   |
| `item.created { item: { type: "tool_result" } }`         | `session/update { tool_result }` |
| `turn.completed { usage }`                                | prompt response (stopReason: end_turn) |
| `turn.failed { error }`                                   | prompt response (stopReason: error) |
| `thread.started { session_id }`                           | captured for session resume      |

### CLI Flags

```bash
codex exec --json --full-auto "<prompt>"
codex exec resume --last --json --full-auto "<follow-up>"
```

| Flag | Purpose |
| ---- | ------- |
| `exec` | Non-interactive mode |
| `--json` | JSON Lines output for machine parsing |
| `--full-auto` | Auto-approve reads, writes, and commands (sandboxed) |
| `resume --last` | Continue previous session for multi-turn |

Reference: [Codex CLI docs](https://developers.openai.com/codex/cli)

---

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** (`claude` in PATH) — for Claude adapter
- **Codex CLI** (`codex` in PATH) — for Codex adapter
- **OpenClaw** with acpx plugin

## Installation

```bash
# From npm
npm install -g proxy-acpx-x

# Or from source
git clone https://github.com/clonn/proxy-acpx-x.git
cd proxy-acpx-x
npm install
npm run build
```

## Setup with OpenClaw / acpx

### Claude Code backend

```bash
acpx config set agents.claude-native.command "proxy-acpx-x"
```

### Codex CLI backend

```bash
acpx config set agents.codex-native.command "proxy-acpx-x-codex"
```

### OpenClaw config (`~/.openclaw/config.json`)

```json
{
  "acp": {
    "enabled": true,
    "dispatch": { "enabled": true },
    "backend": "acpx",
    "defaultAgent": "claude-native"
  }
}
```

Change `defaultAgent` to `"codex-native"` to use Codex by default.

### Direct execution (testing)

```bash
# Claude adapter
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node dist/adapter.js

# Codex adapter
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node dist/codex-adapter.js
```

## Usage

Once configured, OpenClaw routes requests through the adapter automatically:

```
You: "Refactor this function"
```

**Manual spawn:**
```
/acp spawn claude-native --mode persistent --thread auto
/acp spawn codex-native --mode persistent --thread auto
```

**Common commands:**

| Command            | Description               |
| ------------------ | ------------------------- |
| `/acp status`      | Check current session     |
| `/acp steer <msg>` | Send follow-up instruction|
| `/acp cancel`      | Cancel current turn       |
| `/acp close`       | Close session             |

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Run Claude adapter with ts-node
```

## Testing

```bash
npm test             # Run all unit tests (vitest, 40 tests)
npm run test:watch   # Run tests in watch mode
npm run test:smoke   # Run E2E smoke tests against Claude adapter
```

**Unit tests:**
- `test/protocol.test.ts` — 24 tests for ACP ↔ Claude Code stream-json translation
- `test/codex-protocol.test.ts` — 16 tests for ACP ↔ Codex CLI translation

**Smoke tests** (`test/smoke.sh`) — 5 tests against the built Claude adapter process.

### Manual E2E test

```bash
npm run build

# Claude adapter
node dist/adapter.js
# paste: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# paste: {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2?"}]}}

# Codex adapter
node dist/codex-adapter.js
# paste: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# paste: {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2?"}]}}
```

## Troubleshooting

**"Failed to spawn claude/codex"** — Ensure the CLI is in your PATH. Run `which claude` or `which codex`.

**No output** — Check stderr logs (prefixed `[proxy-acpx-x]` or `[proxy-acpx-x:codex]`).

**Permission errors** — Claude adapter uses `bypassPermissions`, Codex adapter uses `--full-auto`. For finer control, modify the spawn args.

**Slow startup (Claude)** — Uses `--bare` to skip hooks/plugins. Remove if you need CLAUDE.md context.

## References

- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Agent SDK streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Codex CLI features](https://developers.openai.com/codex/cli/features)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)

## License

MIT

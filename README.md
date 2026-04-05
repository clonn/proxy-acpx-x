# proxy-acpx-x

ACP ↔ Claude Code `stream-json` adapter. Routes OpenClaw/acpx traffic through the **Claude Code CLI**, enabling subscription-based authentication instead of requiring a separate API key.

## Architecture

```
Before (API key required):
  OpenClaw → acpx → @zed/claude-agent-acp → Anthropic API (API key)

After (subscription auth via CLI):
  OpenClaw → acpx → proxy-acpx-x → claude CLI (stream-json) → Anthropic API (subscription OK)
```

The adapter is a thin NDJSON translator (~300 lines) that sits between acpx and the Claude Code CLI. Both protocols use stdin/stdout NDJSON, so only field-name mapping is needed.

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

### CLI Flags Used

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

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated (`claude` command in PATH)
- **OpenClaw** with acpx plugin

## Installation

```bash
# From npm (once published)
npm install -g proxy-acpx-x

# Or from source
git clone https://github.com/clonn/proxy-acpx-x.git
cd proxy-acpx-x
npm install
npm run build
```

## Setup with OpenClaw / acpx

### Option 1: Register as an acpx agent

```bash
# If installed globally
acpx config set agents.claude-native.command "proxy-acpx-x"

# If running from source
acpx config set agents.claude-native.command "node /path/to/proxy-acpx-x/dist/adapter.js"
```

Then edit `~/.openclaw/config.json`:

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

### Option 2: Direct execution (testing)

```bash
# Pipe ACP messages manually
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node dist/adapter.js
```

## Usage

Once configured, OpenClaw routes requests through the adapter automatically:

**Direct conversation:**
```
You: "Refactor this function using Claude Code"
```

**Manual spawn:**
```
/acp spawn claude-native --mode persistent --thread auto
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
npm run dev          # Run directly with ts-node
```

## Testing

```bash
npm test             # Run unit tests (vitest, 24 tests)
npm run test:watch   # Run tests in watch mode
npm run test:smoke   # Run E2E smoke tests against built adapter
```

**Unit tests** (`test/protocol.test.ts`) — test all pure protocol translation functions:
- ACP ↔ stream-json message building
- Tool classification, input extraction, summarization
- CLI argument construction

**Smoke tests** (`test/smoke.sh`) — test the actual adapter process:
- ACP `initialize` handshake
- `session/create` with custom session ID
- Empty prompt returns `end_turn` immediately
- Unknown method returns JSON-RPC error
- `session/close` graceful shutdown

### Manual E2E test (with real Claude CLI)

```bash
# 1. Build
npm run build

# 2. Start the adapter
node dist/adapter.js

# 3. In the same terminal, paste these lines one by one:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2? Reply with just the number."}]}}

# 4. Watch stdout for ACP responses and stderr for debug logs
# 5. Ctrl+C to stop
```

## How It Works

The adapter has 4 parts:

### Part 1: CLI Spawn (~20 lines)
Starts `claude` as a child process with stream-json I/O flags. Uses `--bare` for fast startup and `--include-partial-messages` for real-time streaming events.

### Part 2: ACP → stream-json (~60 lines)
Reads NDJSON from stdin (ACP messages from acpx). Translates:
- `initialize` → spawn Claude CLI, return capabilities
- `session/prompt` → `{"type":"user","message":{"role":"user","content":"…"}}` to Claude's stdin
- `session/cancel` → SIGTERM the Claude process
- `session/close` → graceful stdin close + SIGTERM

### Part 3: stream-json → ACP (~120 lines)
Reads Claude's stdout stream events and translates:
- `stream_event` with `content_block_delta` (`text_delta`) → `session/update { agent_message_chunk }`
- `stream_event` with `content_block_start` (`tool_use`) → track tool name/id
- `stream_event` with `content_block_delta` (`input_json_delta`) → accumulate tool input
- `stream_event` with `content_block_stop` → emit `session/update { tool_call }` with complete input
- `result` → ACP prompt response with stop reason and usage stats
- `system` (`api_retry`) → logged to stderr

### Part 4: Utilities (~30 lines)
JSON emitters (`emitAcp`, `emitAcpResponse`, `emitAcpNotification`), prompt text extraction, input summarization, tool classification.

## Permission Handling

This adapter uses **Method A: pre-approved permissions** (`--permission-mode bypassPermissions`). ACP sessions are non-interactive, so all file writes and command executions are auto-approved.

For dynamic permission control (Method B), integrate the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)'s `permissionHandler` callback — see [concept.md](./concept.md) for details.

## Troubleshooting

**"Failed to spawn claude"** — Ensure `claude` CLI is in your PATH. Run `which claude` to verify.

**No output from Claude** — Check stderr logs (lines prefixed `[proxy-acpx-x]`). The adapter logs all lifecycle events to stderr.

**Permission errors** — The adapter runs with `bypassPermissions`. For finer control, modify the spawn args to use `--allowedTools` instead.

**Slow startup** — The adapter uses `--bare` to skip hooks/plugins/MCP discovery. If you need project context (CLAUDE.md, etc.), remove `--bare` from the spawn args.

## References

- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Agent SDK streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

## License

MIT

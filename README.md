# proxy-acpx-x

ACP adapters for routing OpenClaw/acpx traffic through **Claude Code CLI**, **Codex CLI**, or **Gemini CLI**, enabling subscription-based authentication instead of requiring separate API keys.

## Supported Backends

| Backend | Command | CLI Used |
|---------|---------|----------|
| **Claude Code** | `proxy-acpx-claude` | `claude -p --input-format stream-json --output-format stream-json` |
| **Codex CLI** | `proxy-acpx-codex` | `codex exec --json --full-auto` |
| **Gemini CLI** | `proxy-acpx-gemini` | `gemini --output-format stream-json --yolo` |

## Architecture

```
Claude Code backend:
  OpenClaw → acpx → proxy-acpx-claude → claude CLI (stream-json) → Anthropic API

Codex CLI backend:
  OpenClaw → acpx → proxy-acpx-codex  → codex exec (JSON Lines)  → OpenAI API

Gemini CLI backend:
  OpenClaw → acpx → proxy-acpx-gemini → gemini CLI (stream-json) → Google AI API
```

All adapters are thin NDJSON translators. The ACP side is identical — only the CLI protocol differs.

> **Naming:** `proxy-acpx-x` where `x` is the target CLI — `proxy-acpx-claude`, `proxy-acpx-codex`, `proxy-acpx-gemini`, etc.

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
  --permission-mode bypassPermissions
```

| Flag | Purpose |
| ---- | ------- |
| `-p` | Non-interactive (print) mode |
| `--input-format stream-json` | Accept NDJSON messages on stdin |
| `--output-format stream-json` | Emit NDJSON streaming events on stdout |
| `--verbose` | Full turn-by-turn output |
| `--include-partial-messages` | Emit `stream_event` with real-time text/tool deltas |
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

## Gemini CLI Adapter

### Protocol Mapping

**Input: ACP → Gemini CLI** (spawns `gemini` per prompt)

| ACP (from acpx)                           | Gemini CLI                                            |
| ----------------------------------------- | ----------------------------------------------------- |
| `session/prompt { prompt: [{text:"…"}] }` | `gemini --output-format stream-json --yolo "…"`       |
| `session/prompt` (2nd+)                   | `gemini --output-format stream-json --yolo --resume latest "…"` |
| `session/cancel`                          | SIGTERM to child process                              |
| `session/close`                           | SIGTERM + reset session                               |

**Output: Gemini CLI stream-json → ACP**

| Gemini stream-json event                                    | ACP (to acpx)                    |
| ----------------------------------------------------------- | -------------------------------- |
| `{ type: "message", role: "assistant", content, delta }`    | `session/update { agent_message_chunk }` |
| `{ type: "tool_use", tool_name, tool_id, parameters }`     | `session/update { tool_call }`   |
| `{ type: "tool_result", tool_id, status, output }`         | `session/update { tool_result }` |
| `{ type: "result", status: "success", stats }`             | prompt response (stopReason: end_turn) |
| `{ type: "init", session_id, model }`                      | captured for session resume      |
| `{ type: "error", message }`                               | prompt response (stopReason: error) |

### CLI Flags

```bash
gemini --output-format stream-json --yolo "<prompt>"
gemini --output-format stream-json --yolo --resume latest "<follow-up>"
```

| Flag | Purpose |
| ---- | ------- |
| `--output-format stream-json` | NDJSON streaming events on stdout |
| `--yolo` | Auto-approve all tool calls (required for non-interactive ACP) |
| `--resume latest` | Continue previous session for multi-turn |

Reference: [Gemini CLI docs](https://geminicli.com/docs/cli/headless) | [GitHub](https://github.com/google-gemini/gemini-cli)

---

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** (`claude` in PATH) — for Claude adapter
- **Codex CLI** (`codex` in PATH) — for Codex adapter
- **Gemini CLI** (`gemini` in PATH) — for Gemini adapter
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
acpx config set agents.claude-native.command "proxy-acpx-claude"
```

### Codex CLI backend

```bash
acpx config set agents.codex-native.command "proxy-acpx-codex"
```

### Gemini CLI backend

```bash
acpx config set agents.gemini-native.command "proxy-acpx-gemini"
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

# Gemini adapter
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node dist/gemini-adapter.js
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
/acp spawn gemini-native --mode persistent --thread auto
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
npm test             # Run all unit tests (vitest, 97 tests)
npm run test:watch   # Run tests in watch mode
npm run test:smoke   # Run E2E smoke tests against Claude adapter
```

**Unit tests:**
- `test/protocol.test.ts` — 24 tests for ACP ↔ Claude Code stream-json translation
- `test/codex-protocol.test.ts` — 16 tests for ACP ↔ Codex CLI translation
- `test/gemini-protocol.test.ts` — 15 tests for ACP ↔ Gemini CLI translation
- `test/adapter-acp.test.ts` — 42 integration tests (14 per adapter, spawned as child processes)

**Smoke tests** (`test/smoke.sh`) — 24 shell tests (8 per adapter).

### Manual E2E test

```bash
npm run build

# Claude adapter
node dist/adapter.js
# paste: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# paste: {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2?"}]}}

# Codex adapter
node dist/codex-adapter.js

# Gemini adapter
node dist/gemini-adapter.js

# Then paste for any adapter:
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
# {"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"What is 2+2?"}]}}
```

## Troubleshooting

**"Failed to spawn claude/codex/gemini"** — Ensure the CLI is in your PATH. Run `which claude`, `which codex`, or `which gemini`.

**No output** — Check stderr logs (prefixed `[proxy-acpx-x]`, `[proxy-acpx-x:codex]`, or `[proxy-acpx-x:gemini]`).

**Permission errors** — Claude uses `bypassPermissions`, Codex uses `--full-auto`, Gemini uses `--yolo`. For finer control, modify the spawn args.

**Slow startup (Claude)** — Add `--bare` to `buildClaudeArgs({ bare: true })` in `src/protocol.ts` to skip hooks/plugins for faster startup (but this also skips OAuth auth).

## References

- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Agent SDK streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Codex CLI features](https://developers.openai.com/codex/cli/features)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Gemini CLI headless mode](https://geminicli.com/docs/cli/headless)
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)

## License

MIT

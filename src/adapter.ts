#!/usr/bin/env node

/**
 * proxy-acpx-x: ACP ↔ Claude Code stream-json adapter
 *
 * Translates between ACP protocol (stdin/stdout NDJSON from acpx) and
 * Claude Code CLI's --input-format stream-json / --output-format stream-json.
 *
 * Architecture:
 *   OpenClaw → acpx → [this adapter] → claude CLI (stream-json) → Anthropic API
 *                                        (subscription auth OK)
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import {
  AcpMessage,
  ClaudeStreamOutput,
  buildAcpResponse,
  buildAcpError,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  buildClaudeUserMessage,
  buildClaudeArgs,
  extractTextFromPrompt,
  summarizeInput,
} from "./protocol";

// ─── State ───────────────────────────────────────────────────────────────────

let claudeProcess: ChildProcess | null = null;
let currentRequestId: string | number | undefined = undefined;
let sessionId: string | null = null;
let accumulatedUsage = { inputTokens: 0, outputTokens: 0 };

// Tool streaming state
let currentToolName: string | null = null;
let currentToolId: string | null = null;
let currentToolInput = "";

// ─── Output helpers ──────────────────────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[proxy-acpx-x] ${msg}\n`);
}

// ─── Part 1: Spawn Claude Code CLI ───────────────────────────────────────────

function spawnClaude(): ChildProcess {
  const args = buildClaudeArgs();
  log(`Spawning: claude ${args.join(" ")}`);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    log(`Failed to spawn claude: ${err.message}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: `Failed to spawn claude CLI: ${err.message}`,
      }));
      currentRequestId = undefined;
    }
  });

  proc.on("exit", (code, signal) => {
    log(`Claude exited (code=${code}, signal=${signal})`);
    claudeProcess = null;
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: `Claude process exited unexpectedly (code=${code})`,
      }));
      currentRequestId = undefined;
    }
  });

  if (proc.stdout) setupClaudeOutputHandler(proc);
  if (proc.stderr) {
    const rl = createInterface({ input: proc.stderr });
    rl.on("line", (line) => process.stderr.write(`[claude-stderr] ${line}\n`));
  }

  return proc;
}

// ─── Part 3: Claude Code stream-json output → ACP events ────────────────────

function setupClaudeOutputHandler(proc: ChildProcess): void {
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: ClaudeStreamOutput;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`Failed to parse Claude output: ${line}`);
      return;
    }
    handleClaudeMessage(msg);
  });
}

function handleClaudeMessage(msg: ClaudeStreamOutput): void {
  switch (msg.type) {
    case "stream_event": handleStreamEvent(msg); break;
    case "assistant": handleAssistantMessage(msg); break;
    case "result": handleResultMessage(msg); break;
    case "system": handleSystemMessage(msg); break;
    default: log(`Unknown message type: ${msg.type}`);
  }
}

function handleStreamEvent(msg: ClaudeStreamOutput): void {
  const event = msg.event;
  if (!event) return;

  switch (event.type) {
    case "message_start": {
      if (event.message?.usage) {
        accumulatedUsage.inputTokens = event.message.usage.input_tokens ?? 0;
      }
      break;
    }

    case "content_block_start": {
      const block = event.content_block;
      if (block?.type === "tool_use") {
        currentToolName = block.name ?? null;
        currentToolId = block.id ?? null;
        currentToolInput = "";
        log(`Tool starting: ${currentToolName}`);
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta;
      if (!delta) break;

      if (delta.type === "text_delta" && delta.text) {
        emit(buildAgentMessageChunk(sessionId, delta.text));
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        currentToolInput += delta.partial_json;
      }
      break;
    }

    case "content_block_stop": {
      if (currentToolName && currentToolId) {
        let parsedInput: unknown = currentToolInput;
        try { parsedInput = JSON.parse(currentToolInput); } catch { /* keep as string */ }

        emit(buildToolCall(sessionId, currentToolId, currentToolName, parsedInput));
        log(`Tool call emitted: ${currentToolName}`);
        currentToolName = null;
        currentToolId = null;
        currentToolInput = "";
      }
      break;
    }

    case "message_delta": {
      if (event.delta?.stop_reason) {
        log(`Stop reason: ${event.delta.stop_reason}`);
      }
      if (event.usage) {
        accumulatedUsage.outputTokens += event.usage.output_tokens ?? 0;
      }
      break;
    }

    case "message_stop":
      log("Message complete");
      break;

    default:
      log(`Unhandled stream event: ${event.type}`);
  }
}

function handleAssistantMessage(msg: ClaudeStreamOutput): void {
  if (!msg.message?.content) return;
  for (const block of msg.message.content) {
    if (block.type === "tool_result") {
      emit(buildToolResult(sessionId, block.id ?? "", block.text ?? ""));
    }
  }
}

function handleResultMessage(msg: ClaudeStreamOutput): void {
  log(`Result: subtype=${msg.subtype}`);
  emit(buildPromptResponse(
    currentRequestId,
    msg.subtype === "success" ? "end_turn" : "error",
    msg.result ?? "",
    accumulatedUsage,
  ));
  currentRequestId = undefined;
  accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
}

function handleSystemMessage(msg: ClaudeStreamOutput): void {
  if (msg.subtype === "api_retry") {
    log(`API retry: attempt=${msg.attempt}/${msg.max_retries}, error=${msg.error}`);
  } else if (msg.subtype === "init") {
    log(`Claude session initialized: ${msg.session_id}`);
  } else {
    log(`System: ${JSON.stringify(msg)}`);
  }
}

// ─── Part 2: ACP input → Claude Code stream-json ────────────────────────────

function sendToClaude(obj: Record<string, unknown>): void {
  if (!claudeProcess?.stdin?.writable) {
    log("Claude stdin not writable");
    return;
  }
  const line = JSON.stringify(obj) + "\n";
  log(`→ Claude stdin: ${line.trim().slice(0, 120)}`);
  claudeProcess.stdin.write(line);
}

function handleAcpMessage(raw: string): void {
  let msg: AcpMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    log(`Failed to parse ACP input: ${raw}`);
    return;
  }

  const method = msg.method;
  log(`ACP ← ${method} (id=${msg.id})`);

  switch (method) {
    case "initialize": {
      sessionId = `session-${Date.now()}`;
      emit(buildAcpResponse(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { streaming: true, tools: true },
        serverInfo: { name: "proxy-acpx-x", version: "1.0.0" },
      }));
      if (!claudeProcess) claudeProcess = spawnClaude();
      break;
    }

    case "session/create": {
      sessionId = (msg.params?.sessionId as string) ?? `session-${Date.now()}`;
      emit(buildAcpResponse(msg.id, { sessionId }));
      break;
    }

    case "session/prompt": {
      currentRequestId = msg.id;
      accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
      const prompts = msg.params?.prompt ?? [];
      const text = extractTextFromPrompt(prompts);

      if (!text) {
        emit(buildAcpResponse(msg.id, {
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        }));
        break;
      }

      log(`Prompt: ${summarizeInput(text)}`);
      if (!claudeProcess) claudeProcess = spawnClaude();
      sendToClaude(buildClaudeUserMessage(text));
      break;
    }

    case "session/cancel": {
      if (claudeProcess) {
        claudeProcess.kill("SIGTERM");
        claudeProcess = null;
      }
      emit(buildAcpResponse(msg.id, { cancelled: true }));
      currentRequestId = undefined;
      break;
    }

    case "session/close": {
      if (claudeProcess) {
        claudeProcess.stdin?.end();
        setTimeout(() => {
          if (claudeProcess) {
            claudeProcess.kill("SIGTERM");
            claudeProcess = null;
          }
        }, 1000);
      }
      emit(buildAcpResponse(msg.id, { closed: true }));
      sessionId = null;
      currentRequestId = undefined;
      break;
    }

    case "notifications/initialized":
      break;

    default: {
      log(`Unhandled ACP method: ${method}`);
      emit(buildAcpError(msg.id, -32601, `Method not found: ${method}`));
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  log("Adapter started, waiting for ACP input...");
  log("Using Claude Code CLI with stream-json I/O");

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => { if (line.trim()) handleAcpMessage(line); });
  rl.on("close", () => {
    log("stdin closed, shutting down");
    shutdown();
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function shutdown(): void {
  log("Shutting down...");
  if (claudeProcess) {
    claudeProcess.stdin?.end();
    claudeProcess.kill("SIGTERM");
  }
  process.exit(0);
}

main();

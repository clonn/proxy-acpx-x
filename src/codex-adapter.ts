#!/usr/bin/env node

/**
 * proxy-acpx-x codex adapter: ACP ↔ Codex CLI (codex exec --json)
 *
 * Translates between ACP protocol (stdin/stdout NDJSON from acpx) and
 * Codex CLI's exec mode with JSON Lines output.
 *
 * Architecture:
 *   OpenClaw → acpx → [this adapter] → codex exec --json → OpenAI API
 *
 * Key difference from Claude adapter:
 *   Codex exec is one-shot per prompt (spawns a new process each time),
 *   with session resume via `codex exec resume --last`.
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import {
  AcpMessage,
  CodexEvent,
  buildAcpResponse,
  buildAcpError,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  buildCodexExecArgs,
  buildCodexResumeArgs,
  classifyTool,
  summarizeInput,
  isTextMessage,
  isToolUse,
  isToolResult,
  isTurnCompleted,
  isTurnFailed,
  isThreadStarted,
  isError,
} from "./codex-protocol";
import { extractTextFromPrompt } from "./protocol";

// ─── State ───────────────────────────────────────────────────────────────────

let codexProcess: ChildProcess | null = null;
let currentRequestId: string | number | undefined = undefined;
let sessionId: string | null = null;
let codexSessionId: string | null = null; // Codex's own session ID for resume
let accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
let isFirstPrompt = true;

// ─── Output helpers ──────────────────────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[proxy-acpx-x:codex] ${msg}\n`);
}

// ─── Part 1: Spawn Codex CLI ─────────────────────────────────────────────────

function spawnCodex(prompt: string): ChildProcess {
  let args: string[];

  if (isFirstPrompt || !codexSessionId) {
    args = buildCodexExecArgs(prompt);
    isFirstPrompt = false;
  } else {
    // Resume previous session for multi-turn
    args = buildCodexResumeArgs(prompt, codexSessionId);
  }

  log(`Spawning: codex ${args.join(" ")}`);

  const proc = spawn("codex", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    log(`Failed to spawn codex: ${err.message}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: `Failed to spawn codex CLI: ${err.message}`,
      }));
      currentRequestId = undefined;
    }
  });

  proc.on("exit", (code, signal) => {
    log(`Codex exited (code=${code}, signal=${signal})`);
    codexProcess = null;

    // Codex exec exits after each prompt — this is normal.
    // Only send error if we still have a pending request without a result.
    if (currentRequestId !== undefined) {
      if (code !== 0) {
        emit(buildAcpResponse(currentRequestId, {
          stopReason: "error",
          error: `Codex process exited with code ${code}`,
        }));
      } else {
        // Normal exit without explicit turn.completed — send success
        emit(buildPromptResponse(
          currentRequestId,
          "end_turn",
          "",
          accumulatedUsage,
        ));
      }
      currentRequestId = undefined;
      accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
    }
  });

  if (proc.stdout) {
    setupCodexOutputHandler(proc);
  }

  if (proc.stderr) {
    const rl = createInterface({ input: proc.stderr });
    rl.on("line", (line) => process.stderr.write(`[codex-stderr] ${line}\n`));
  }

  return proc;
}

// ─── Part 3: Codex CLI JSON output → ACP events ─────────────────────────────
//
// codex exec --json emits NDJSON events:
//   thread.started  — session started, contains session_id
//   turn.started    — new turn beginning
//   item.created    — content item (message, tool_use, tool_result)
//   turn.completed  — turn done, contains usage
//   turn.failed     — turn errored
//   error           — fatal error

function setupCodexOutputHandler(proc: ChildProcess): void {
  const rl = createInterface({ input: proc.stdout! });

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let event: CodexEvent;
    try {
      event = JSON.parse(line);
    } catch {
      log(`Failed to parse Codex output: ${line}`);
      return;
    }

    handleCodexEvent(event);
  });
}

function handleCodexEvent(event: CodexEvent): void {
  if (isThreadStarted(event)) {
    codexSessionId = event.session_id ?? null;
    log(`Codex session: ${codexSessionId}`);
    return;
  }

  if (isTextMessage(event)) {
    const text = event.item?.content ?? "";
    if (text) {
      emit(buildAgentMessageChunk(sessionId, text));
    }
    return;
  }

  if (isToolUse(event)) {
    const item = event.item!;
    emit(buildToolCall(
      sessionId,
      item.id ?? "",
      item.name ?? "unknown",
      item.input,
    ));
    log(`Tool call: ${item.name}`);
    return;
  }

  if (isToolResult(event)) {
    const item = event.item!;
    emit(buildToolResult(
      sessionId,
      item.id ?? "",
      item.output ?? "",
    ));
    return;
  }

  if (isTurnCompleted(event)) {
    const usage = event.usage ?? {};
    accumulatedUsage.inputTokens += usage.input_tokens ?? 0;
    accumulatedUsage.outputTokens += usage.output_tokens ?? 0;
    log(`Turn completed (in=${accumulatedUsage.inputTokens}, out=${accumulatedUsage.outputTokens})`);

    // Send response — codex exec will exit after this
    if (currentRequestId !== undefined) {
      emit(buildPromptResponse(
        currentRequestId,
        "end_turn",
        "",
        accumulatedUsage,
      ));
      currentRequestId = undefined;
      accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
    }
    return;
  }

  if (isTurnFailed(event)) {
    log(`Turn failed: ${event.error ?? event.message ?? "unknown"}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: event.error ?? event.message ?? "Turn failed",
      }));
      currentRequestId = undefined;
    }
    return;
  }

  if (isError(event)) {
    log(`Error: ${event.message ?? event.error ?? "unknown"}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: event.message ?? event.error ?? "Codex error",
      }));
      currentRequestId = undefined;
    }
    return;
  }

  // Log unhandled events for debugging
  log(`Unhandled event: ${event.type}`);
}

// ─── Part 2: ACP input → Codex CLI ──────────────────────────────────────────

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
        serverInfo: { name: "proxy-acpx-x-codex", version: "1.0.0" },
      }));
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

      // Kill previous process if still running (shouldn't happen with exec)
      if (codexProcess) {
        codexProcess.kill("SIGTERM");
        codexProcess = null;
      }

      // Spawn new codex exec for each prompt
      codexProcess = spawnCodex(text);
      break;
    }

    case "session/cancel": {
      if (codexProcess) {
        codexProcess.kill("SIGTERM");
        codexProcess = null;
      }
      emit(buildAcpResponse(msg.id, { cancelled: true }));
      currentRequestId = undefined;
      break;
    }

    case "session/close": {
      if (codexProcess) {
        codexProcess.kill("SIGTERM");
        codexProcess = null;
      }
      emit(buildAcpResponse(msg.id, { closed: true }));
      sessionId = null;
      codexSessionId = null;
      currentRequestId = undefined;
      isFirstPrompt = true;
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
  log("Codex adapter started, waiting for ACP input...");
  log("Using Codex CLI exec mode with JSON output");

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
  if (codexProcess) {
    codexProcess.kill("SIGTERM");
  }
  process.exit(0);
}

main();

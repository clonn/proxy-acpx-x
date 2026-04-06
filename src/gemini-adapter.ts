#!/usr/bin/env node

/**
 * proxy-acpx-gemini: ACP ↔ Gemini CLI (stream-json) adapter
 *
 * Translates between ACP protocol (stdin/stdout NDJSON from acpx) and
 * Gemini CLI's headless mode with stream-json output.
 *
 * Architecture:
 *   OpenClaw → acpx → [this adapter] → gemini CLI (stream-json) → Google AI API
 *
 * Gemini CLI headless: piped stdin or -p flag triggers non-interactive mode.
 * Each prompt spawns a new `gemini` process (like Codex, not persistent like Claude).
 * Session resume: `gemini --resume latest "<follow-up>"`
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import {
  AcpMessage,
  GeminiEvent,
  buildAcpResponse,
  buildAcpError,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  buildGeminiArgs,
  classifyGeminiTool,
  summarizeInput,
  isInit,
  isAssistantMessage,
  isToolUse,
  isToolResult,
  isResult,
  isError,
} from "./gemini-protocol";
import { extractTextFromPrompt } from "./protocol";

// ─── State ───────────────────────────────────────────────────────────────────

let geminiProcess: ChildProcess | null = null;
let currentRequestId: string | number | undefined = undefined;
let sessionId: string | null = null;
let geminiSessionId: string | null = null; // Gemini's own session ID for resume
let accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
let isFirstPrompt = true;

// ─── Output helpers ──────────────────────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`[proxy-acpx-x:gemini] ${msg}\n`);
}

// ─── Part 1: Spawn Gemini CLI ────────────────────────────────────────────────

function spawnGemini(prompt: string): ChildProcess {
  let args: string[];

  if (!isFirstPrompt && geminiSessionId) {
    // Resume previous session
    args = ["--output-format", "stream-json", "--yolo", "--resume", "latest", prompt];
  } else {
    args = buildGeminiArgs(prompt);
    isFirstPrompt = false;
  }

  log(`Spawning: gemini ${args.join(" ")}`);

  const proc = spawn("gemini", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    log(`Failed to spawn gemini: ${err.message}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: `Failed to spawn gemini CLI: ${err.message}`,
      }));
      currentRequestId = undefined;
    }
  });

  proc.on("exit", (code, signal) => {
    log(`Gemini exited (code=${code}, signal=${signal})`);
    geminiProcess = null;

    // Gemini exits after each prompt — send result if not already sent
    if (currentRequestId !== undefined) {
      if (code !== 0 && code !== null) {
        emit(buildAcpResponse(currentRequestId, {
          stopReason: "error",
          error: `Gemini process exited with code ${code}`,
        }));
      } else {
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

  if (proc.stdout) setupGeminiOutputHandler(proc);
  if (proc.stderr) {
    const rl = createInterface({ input: proc.stderr });
    rl.on("line", (line) => process.stderr.write(`[gemini-stderr] ${line}\n`));
  }

  return proc;
}

// ─── Part 3: Gemini CLI stream-json output → ACP events ─────────────────────
//
// gemini --output-format stream-json emits NDJSON events:
//   init         — session started, contains session_id and model
//   message      — user/assistant messages (assistant has delta:true for streaming)
//   tool_use     — tool call with tool_name, tool_id, parameters
//   tool_result  — tool output with tool_id, status, output
//   result       — final result with status and stats
//   error        — error events

function setupGeminiOutputHandler(proc: ChildProcess): void {
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let event: GeminiEvent;
    try {
      event = JSON.parse(line);
    } catch {
      log(`Failed to parse Gemini output: ${line}`);
      return;
    }
    handleGeminiEvent(event);
  });
}

function handleGeminiEvent(event: GeminiEvent): void {
  if (isInit(event)) {
    geminiSessionId = event.session_id ?? null;
    log(`Gemini session: ${geminiSessionId}, model: ${event.model}`);
    return;
  }

  if (isAssistantMessage(event)) {
    const text = event.content ?? "";
    if (text) {
      emit(buildAgentMessageChunk(sessionId, text));
    }
    return;
  }

  if (isToolUse(event)) {
    emit(buildToolCall(
      sessionId,
      event.tool_id ?? "",
      event.tool_name ?? "unknown",
      event.parameters,
    ));
    log(`Tool call: ${event.tool_name}`);
    return;
  }

  if (isToolResult(event)) {
    emit(buildToolResult(
      sessionId,
      event.tool_id ?? "",
      event.output ?? "",
    ));
    return;
  }

  if (isResult(event)) {
    const stats = event.stats ?? {};
    accumulatedUsage.inputTokens += stats.input_tokens ?? 0;
    accumulatedUsage.outputTokens += stats.output_tokens ?? 0;
    log(`Result: status=${event.status}, tokens=${stats.total_tokens ?? 0}`);

    if (currentRequestId !== undefined) {
      emit(buildPromptResponse(
        currentRequestId,
        event.status === "success" ? "end_turn" : "error",
        "",
        accumulatedUsage,
      ));
      currentRequestId = undefined;
      accumulatedUsage = { inputTokens: 0, outputTokens: 0 };
    }
    return;
  }

  if (isError(event)) {
    log(`Error: ${event.message ?? "unknown"}`);
    if (currentRequestId !== undefined) {
      emit(buildAcpResponse(currentRequestId, {
        stopReason: "error",
        error: event.message ?? "Gemini error",
      }));
      currentRequestId = undefined;
    }
    return;
  }

  if (event.type === "message" && event.role === "user") {
    // User message echo — ignore
    return;
  }

  log(`Unhandled event: ${event.type}`);
}

// ─── Part 2: ACP input → Gemini CLI ─────────────────────────────────────────

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
        serverInfo: { name: "proxy-acpx-x-gemini", version: "1.0.0" },
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

      if (geminiProcess) {
        geminiProcess.kill("SIGTERM");
        geminiProcess = null;
      }

      // Spawn new gemini process for each prompt
      geminiProcess = spawnGemini(text);
      break;
    }

    case "session/cancel": {
      if (geminiProcess) {
        geminiProcess.kill("SIGTERM");
        geminiProcess = null;
      }
      emit(buildAcpResponse(msg.id, { cancelled: true }));
      currentRequestId = undefined;
      break;
    }

    case "session/close": {
      if (geminiProcess) {
        geminiProcess.kill("SIGTERM");
        geminiProcess = null;
      }
      emit(buildAcpResponse(msg.id, { closed: true }));
      sessionId = null;
      geminiSessionId = null;
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
  log("Gemini adapter started, waiting for ACP input...");
  log("Using Gemini CLI headless mode with stream-json output");

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
  if (geminiProcess) {
    geminiProcess.kill("SIGTERM");
  }
  process.exit(0);
}

main();

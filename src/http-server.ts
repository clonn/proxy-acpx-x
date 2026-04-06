#!/usr/bin/env node

/**
 * proxy-acpx-x HTTP server: OpenAI-compatible API wrapper
 *
 * Exposes POST /v1/chat/completions on localhost:52088 (configurable).
 * Translates OpenAI chat format → Claude Code CLI stream-json → SSE response.
 *
 * This lets OpenClaw (or any OpenAI-compatible client) use Claude Code CLI
 * as a model provider.
 *
 * Flow:
 *   Client → POST /v1/chat/completions → this server → claude CLI → Anthropic API
 *                                                        ↓
 *   Client ← SSE stream (OpenAI format) ← this server ←─┘
 */

import * as http from "http";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import * as fs from "fs";
import * as path from "path";

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const hasFlag = (flag: string) => args.includes(flag);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`proxy-acpx-server — OpenAI-compatible proxy to Claude Code CLI

Usage:
  proxy-acpx-server [options]

Options:
  -p, --port <port>    Port to listen on (default: 52088)
  -H, --host <host>    Host to bind to (default: 127.0.0.1)
  -m, --model <name>   Model name to advertise (default: claude-code-proxy)
  -d, --daemon         Run as background daemon (writes PID to ~/.proxy-acpx-server.pid)
  --bare               Use --bare mode for faster Claude startup (requires ANTHROPIC_API_KEY)
  --stop               Stop a running daemon
  --status             Check if daemon is running
  -h, --help           Show this help

Environment variables:
  PROXY_ACPX_PORT      Same as --port
  PROXY_ACPX_HOST      Same as --host
  PROXY_ACPX_MODEL     Same as --model
  ANTHROPIC_API_KEY    Required when using --bare mode

Examples:
  proxy-acpx-server                    # Start on port 52088
  proxy-acpx-server -p 9000            # Start on port 9000
  proxy-acpx-server -d                 # Start as daemon
  proxy-acpx-server -d -p 9000         # Daemon on port 9000
  proxy-acpx-server --stop             # Stop daemon
  proxy-acpx-server --status           # Check daemon status`);
  process.exit(0);
}

const PID_FILE = path.join(process.env.HOME ?? "/tmp", ".proxy-acpx-server.pid");

// --stop: kill running daemon
if (hasFlag("--stop")) {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_FILE);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch {
    console.log("No running daemon found");
  }
  process.exit(0);
}

// --status: check if running
if (hasFlag("--status")) {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check if alive
    console.log(`Daemon running (PID ${pid})`);
  } catch {
    console.log("Daemon not running");
  }
  process.exit(0);
}

// --daemon: fork and exit parent
if (hasFlag("-d") || hasFlag("--daemon")) {
  const childArgs = args.filter((a) => a !== "-d" && a !== "--daemon");
  const child = spawn(process.execPath, [__filename, ...childArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`PID file: ${PID_FILE}`);
  const port = getArg("-p", getArg("--port", process.env.PROXY_ACPX_PORT ?? "52088"));
  const host = getArg("-H", getArg("--host", process.env.PROXY_ACPX_HOST ?? "127.0.0.1"));
  console.log(`Listening on http://${host}:${port}`);
  console.log(`Stop with: proxy-acpx-server --stop`);
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(getArg("-p", getArg("--port", process.env.PROXY_ACPX_PORT ?? "52088")), 10);
const HOST = getArg("-H", getArg("--host", process.env.PROXY_ACPX_HOST ?? "127.0.0.1"));
const MODEL_NAME = getArg("-m", getArg("--model", process.env.PROXY_ACPX_MODEL ?? "claude-code-proxy"));
const BARE_MODE = hasFlag("--bare");

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>;
}

interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface ClaudeStreamOutput {
  type: string;
  subtype?: string;
  event?: {
    type: string;
    delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string };
    content_block?: { type: string; name?: string; id?: string };
    usage?: { output_tokens?: number };
    message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  };
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  result?: string;
  session_id?: string;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[proxy-acpx-x:http] ${msg}\n`);
}

function contentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n");
  }
  return String(content);
}

function extractPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const text = contentToString(msg.content);
    if (!text) continue;
    if (msg.role === "system") {
      parts.push(`[System] ${text}`);
    } else if (msg.role === "user") {
      parts.push(text);
    } else if (msg.role === "assistant") {
      parts.push(`[Previous assistant response] ${text}`);
    }
  }
  return parts.join("\n\n");
}

function sseChunk(content: string, model: string): string {
  const data = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: null,
    }],
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseDone(model: string): string {
  const data = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: "stop",
    }],
  };
  return `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`;
}

function nonStreamResponse(content: string, model: string, usage: { input: number; output: number }): string {
  return JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
  });
}

// ─── Persistent Claude CLI process ───────────────────────────────────────────
//
// Keep a single long-running Claude CLI process with stream-json I/O.
// This avoids the 15-20s cold start per request.
// Messages are sent via stdin, responses read from stdout.

let claudeProc: ChildProcess | null = null;
let claudeReady = false;
let currentRes: http.ServerResponse | null = null;
let currentModel: string = MODEL_NAME;
let hasStreamedText = false;
let resultSent = false;

function getClaudeArgs(): string[] {
  const cliArgs = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
  ];
  if (BARE_MODE) cliArgs.push("--bare");
  return cliArgs;
}

function ensureClaude(): void {
  if (claudeProc && !claudeProc.killed) return;

  const cliArgs = getClaudeArgs();
  log(`Spawning persistent Claude process (bare=${BARE_MODE})`);
  log(`Args: claude ${cliArgs.join(" ")}`);

  claudeProc = spawn("claude", cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  claudeProc.on("error", (err) => {
    log(`Claude spawn error: ${err.message}`);
    claudeProc = null;
    claudeReady = false;
    if (currentRes && !currentRes.writableEnded) {
      currentRes.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      currentRes.end();
      currentRes = null;
    }
  });

  claudeProc.on("exit", (code, signal) => {
    log(`Claude process exited (code=${code}, signal=${signal})`);
    claudeProc = null;
    claudeReady = false;
    if (currentRes && !currentRes.writableEnded) {
      if (!resultSent) {
        currentRes.write(sseDone(currentModel));
      }
      currentRes.end();
      currentRes = null;
    }
  });

  if (claudeProc.stdout) {
    const rl = createInterface({ input: claudeProc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: ClaudeStreamOutput;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      handleClaudeOutput(msg);
    });
  }

  if (claudeProc.stderr) {
    const errRl = createInterface({ input: claudeProc.stderr });
    errRl.on("line", (line) => log(`[claude] ${line}`));
  }

  claudeReady = true;
}

function handleClaudeOutput(msg: ClaudeStreamOutput): void {
  // System init — Claude is ready
  if (msg.type === "system" && msg.subtype === "init") {
    log(`Claude session ready: ${msg.session_id}`);
    return;
  }

  // No active response — skip
  if (!currentRes || currentRes.writableEnded || resultSent) return;

  if (msg.type === "stream_event" && msg.event) {
    const evt = msg.event;
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
      currentRes.write(sseChunk(String(evt.delta.text), currentModel));
      hasStreamedText = true;
    }
  } else if (msg.type === "assistant" && msg.message?.content && !hasStreamedText) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        currentRes.write(sseChunk(String(block.text), currentModel));
      }
    }
  } else if (msg.type === "result") {
    if (!hasStreamedText && msg.result && typeof msg.result === "string") {
      currentRes.write(sseChunk(msg.result, currentModel));
    }
    resultSent = true;
    currentRes.write(sseDone(currentModel));
    currentRes.end();
    currentRes = null;
  }
}

// ─── Request handlers ────────────────────────────────────────────────────────

function handleStreamingRequest(
  prompt: string,
  model: string,
  res: http.ServerResponse
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Reset per-request state
  currentRes = res;
  currentModel = model;
  hasStreamedText = false;
  resultSent = false;

  ensureClaude();

  if (!claudeProc?.stdin?.writable) {
    log("Claude stdin not writable, respawning");
    claudeProc = null;
    ensureClaude();
  }

  log(`Sending prompt to Claude: ${prompt.slice(0, 80)}`);
  const userMsg = JSON.stringify({ type: "user", message: { role: "user", content: prompt } });
  claudeProc!.stdin!.write(userMsg + "\n");

  // Handle client disconnect
  res.on("close", () => {
    currentRes = null;
  });
}

function handleNonStreamingRequest(
  prompt: string,
  model: string,
  res: http.ServerResponse
): void {
  // For non-streaming, spawn a one-shot process (simpler than collecting from persistent)
  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
  ];
  if (BARE_MODE) cliArgs.push("--bare");
  cliArgs.push(prompt);

  log(`Spawning claude one-shot for non-streaming: ${prompt.slice(0, 80)}`);
  const proc = spawn("claude", cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let output = "";
  proc.stdout!.on("data", (data) => { output += data.toString(); });

  proc.on("error", (err) => {
    log(`Claude spawn error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  });

  proc.on("exit", () => {
    try {
      const parsed = JSON.parse(output);
      const content = parsed.result ?? "";
      const usage = {
        input: parsed.usage?.input_tokens ?? 0,
        output: parsed.usage?.output_tokens ?? 0,
      };
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(nonStreamResponse(content, model, usage));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(nonStreamResponse(output.trim(), model, { input: 0, output: 0 }));
    }
  });

  if (proc.stderr) {
    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => log(`[claude] ${line}`));
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      object: "list",
      data: [{
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy-acpx-x",
      }],
    }));
    return;
  }

  // Chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let chatReq: ChatRequest;
      try {
        chatReq = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
        return;
      }

      if (!chatReq.messages?.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages array is required" } }));
        return;
      }

      const prompt = extractPrompt(chatReq.messages);
      const model = chatReq.model ?? MODEL_NAME;

      log(`Request: stream=${chatReq.stream !== false}, model=${model}`);

      if (chatReq.stream === false) {
        handleNonStreamingRequest(prompt, model, res);
      } else {
        handleStreamingRequest(prompt, model, res);
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, HOST, () => {
  log(`OpenAI-compatible server running at http://${HOST}:${PORT}`);
  log(`Model: ${MODEL_NAME}`);
  log(`Bare mode: ${BARE_MODE}`);
  log(`Endpoints:`);
  log(`  GET  /v1/models`);
  log(`  POST /v1/chat/completions`);
  log(`Configure in OpenClaw:`);
  log(`  Base URL: http://${HOST}:${PORT}/v1`);
  log(`  API Key: sk-dummy-key`);
  log(`  Model: ${MODEL_NAME}`);

  // Pre-spawn Claude CLI so first request is fast
  log("Pre-warming Claude CLI process...");
  ensureClaude();
});

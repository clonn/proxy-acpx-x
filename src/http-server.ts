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

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PROXY_ACPX_PORT ?? "52088", 10);
const HOST = process.env.PROXY_ACPX_HOST ?? "127.0.0.1";
const MODEL_NAME = process.env.PROXY_ACPX_MODEL ?? "claude-code-proxy";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
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

function extractPrompt(messages: ChatMessage[]): string {
  // Combine system prompt + user messages
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(`[System] ${msg.content}`);
    } else if (msg.role === "user") {
      parts.push(msg.content);
    } else if (msg.role === "assistant") {
      parts.push(`[Previous assistant response] ${msg.content}`);
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

// ─── Claude CLI integration ──────────────────────────────────────────────────

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

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
  ];

  log(`Spawning claude for streaming: ${prompt.slice(0, 80)}`);
  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    log(`Claude spawn error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
    res.end();
  });

  // Send prompt via stdin
  const userMsg = JSON.stringify({ type: "user", message: { role: "user", content: prompt } });
  proc.stdin!.write(userMsg + "\n");
  proc.stdin!.end();

  // Parse Claude output and forward as SSE
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: ClaudeStreamOutput;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "stream_event" && msg.event) {
      const evt = msg.event;
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        res.write(sseChunk(evt.delta.text, model));
      }
    } else if (msg.type === "assistant" && msg.message?.content) {
      // Complete message fallback (if stream_events weren't sent)
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          res.write(sseChunk(block.text, model));
        }
      }
    } else if (msg.type === "result") {
      res.write(sseDone(model));
      res.end();
    }
  });

  if (proc.stderr) {
    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => log(`[claude] ${line}`));
  }

  proc.on("exit", () => {
    if (!res.writableEnded) {
      res.write(sseDone(model));
      res.end();
    }
  });

  // Handle client disconnect
  res.on("close", () => {
    proc.kill("SIGTERM");
  });
}

function handleNonStreamingRequest(
  prompt: string,
  model: string,
  res: http.ServerResponse
): void {
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    prompt,
  ];

  log(`Spawning claude for non-streaming: ${prompt.slice(0, 80)}`);
  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let output = "";

  proc.stdout!.on("data", (data) => {
    output += data.toString();
  });

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
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(nonStreamResponse(content, model, usage));
    } catch {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
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
  log(`Endpoints:`);
  log(`  GET  /v1/models`);
  log(`  POST /v1/chat/completions`);
  log(`Configure in OpenClaw:`);
  log(`  Base URL: http://${HOST}:${PORT}/v1`);
  log(`  API Key: sk-dummy-key`);
  log(`  Model: ${MODEL_NAME}`);
});

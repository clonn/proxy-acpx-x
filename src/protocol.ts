/**
 * Protocol translation utilities for ACP ↔ Claude Code stream-json.
 * Pure functions — no side effects, no process I/O.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AcpPrompt {
  type: string;
  text: string;
}

export interface AcpMessage {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: {
    prompt?: AcpPrompt[];
    sessionId?: string;
    [key: string]: unknown;
  };
}

export interface ClaudeStreamEvent {
  type: string;
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { output_tokens?: number };
  index?: number;
}

export interface ClaudeStreamOutput {
  type: string;
  subtype?: string;
  event?: ClaudeStreamEvent;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  session_id?: string;
  uuid?: string;
  attempt?: number;
  max_retries?: number;
  error?: string;
  [key: string]: unknown;
}

// ─── ACP output builders ─────────────────────────────────────────────────────

export function buildAcpResponse(id: string | number | undefined, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function buildAcpNotification(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params };
}

export function buildAcpError(id: string | number | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ─── ACP → Claude Code stream-json ──────────────────────────────────────────

export function extractTextFromPrompt(prompts: AcpPrompt[]): string {
  return prompts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function buildClaudeUserMessage(text: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
  };
}

// ─── Claude Code stream-json → ACP ──────────────────────────────────────────

export function buildAgentMessageChunk(sessionId: string | null, textChunk: string): Record<string, unknown> {
  return buildAcpNotification("session/update", {
    sessionId,
    sessionUpdate: {
      type: "agent_message_chunk",
      textChunk,
    },
  });
}

export function buildToolCall(
  sessionId: string | null,
  toolCallId: string,
  toolName: string,
  input: unknown
): Record<string, unknown> {
  return buildAcpNotification("session/update", {
    sessionId,
    sessionUpdate: {
      type: "tool_call",
      toolCallId,
      toolName,
      toolCategory: classifyTool(toolName),
      input,
    },
  });
}

export function buildToolResult(
  sessionId: string | null,
  toolCallId: string,
  output: string
): Record<string, unknown> {
  return buildAcpNotification("session/update", {
    sessionId,
    sessionUpdate: {
      type: "tool_result",
      toolCallId,
      output,
    },
  });
}

export function buildPromptResponse(
  id: string | number | undefined,
  stopReason: string,
  result: string,
  usage: { inputTokens: number; outputTokens: number }
): Record<string, unknown> {
  return buildAcpResponse(id, { stopReason, result, usage });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function classifyTool(name: string): "read" | "write" | "execute" {
  const readTools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
  const writeTools = ["Write", "Edit", "NotebookEdit"];
  if (writeTools.includes(name)) return "write";
  if (readTools.includes(name)) return "read";
  return "execute";
}

export function summarizeInput(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
}

export function parseNdjsonLine(line: string): unknown | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Build the Claude CLI argument list.
 */
export function buildClaudeArgs(options?: {
  bare?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
}): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (options?.bare !== false) {
    args.push("--bare");
  }

  const mode = options?.permissionMode ?? "bypassPermissions";
  args.push("--permission-mode", mode);

  if (options?.allowedTools?.length) {
    args.push("--allowedTools", ...options.allowedTools);
  }

  return args;
}

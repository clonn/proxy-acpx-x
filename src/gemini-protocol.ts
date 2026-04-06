/**
 * Protocol translation utilities for ACP ↔ Gemini CLI (stream-json).
 * Pure functions — no side effects, no process I/O.
 *
 * Gemini CLI headless mode:
 *   gemini --output-format stream-json --yolo "<prompt>"
 *   echo "<prompt>" | gemini --output-format stream-json --yolo
 *
 * Output: NDJSON events on stdout:
 *   - init         { session_id, model, timestamp }
 *   - message      { role: "user"|"assistant", content, delta?, timestamp }
 *   - tool_use     { tool_name, tool_id, parameters, timestamp }
 *   - tool_result  { tool_id, status, output, timestamp }
 *   - error        { message, timestamp }
 *   - result       { status: "success"|"error", stats: { input_tokens, output_tokens, ... }, timestamp }
 *
 * Reference:
 *   - https://geminicli.com/docs/cli/headless
 *   - https://github.com/google-gemini/gemini-cli
 */

// Re-export shared ACP builders
export {
  buildAcpResponse,
  buildAcpNotification,
  buildAcpError,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  classifyTool as classifyToolDefault,
  summarizeInput,
  parseNdjsonLine,
} from "./protocol";

export type { AcpPrompt, AcpMessage } from "./protocol";

// ─── Gemini-specific types ───────────────────────────────────────────────────

export interface GeminiEvent {
  type: string;
  timestamp?: string;
  // init
  session_id?: string;
  model?: string;
  // message
  role?: string;        // "user" | "assistant"
  content?: string;
  delta?: boolean;
  // tool_use
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  // tool_result
  status?: string;      // "success" | "error"
  output?: string;
  // result
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  // error
  message?: string;
  [key: string]: unknown;
}

// ─── Gemini CLI argument builders ────────────────────────────────────────────

export function buildGeminiArgs(
  prompt: string,
  options?: {
    outputFormat?: string;
    approvalMode?: string;
    yolo?: boolean;
    model?: string;
    allowedTools?: string[];
  }
): string[] {
  const args: string[] = [];

  const format = options?.outputFormat ?? "stream-json";
  args.push("--output-format", format);

  if (options?.yolo !== false && options?.approvalMode === undefined) {
    args.push("--yolo");
  } else if (options?.approvalMode) {
    args.push("--approval-mode", options.approvalMode);
  }

  if (options?.model) {
    args.push("--model", options.model);
  }

  if (options?.allowedTools?.length) {
    args.push("--allowed-tools", ...options.allowedTools);
  }

  // Prompt as positional arg
  args.push(prompt);

  return args;
}

// ─── Gemini tool classification ──────────────────────────────────────────────

export function classifyGeminiTool(name: string): "read" | "write" | "execute" {
  const readTools = [
    "read_file", "read_many_files", "list_directory",
    "glob", "grep_search", "google_web_search", "web_fetch",
  ];
  const writeTools = ["write_file", "replace"];
  if (writeTools.includes(name)) return "write";
  if (readTools.includes(name)) return "read";
  return "execute";
}

// ─── Gemini event classification ─────────────────────────────────────────────

export function isInit(event: GeminiEvent): boolean {
  return event.type === "init";
}

export function isAssistantMessage(event: GeminiEvent): boolean {
  return event.type === "message" && event.role === "assistant";
}

export function isUserMessage(event: GeminiEvent): boolean {
  return event.type === "message" && event.role === "user";
}

export function isToolUse(event: GeminiEvent): boolean {
  return event.type === "tool_use";
}

export function isToolResult(event: GeminiEvent): boolean {
  return event.type === "tool_result";
}

export function isResult(event: GeminiEvent): boolean {
  return event.type === "result";
}

export function isError(event: GeminiEvent): boolean {
  return event.type === "error";
}

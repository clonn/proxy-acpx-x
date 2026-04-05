/**
 * Protocol translation utilities for ACP ↔ Codex CLI (codex exec --json).
 * Pure functions — no side effects, no process I/O.
 *
 * Codex CLI non-interactive mode:
 *   codex exec --json --full-auto "<prompt>"
 *
 * Output: NDJSON events on stdout:
 *   - thread.started   { session_id }
 *   - turn.started     {}
 *   - item.*           { type: "message"|"tool_use"|"tool_result", ... }
 *   - turn.completed   { usage }
 *   - turn.failed      { error }
 *   - error            { message }
 *
 * Session resume:
 *   codex exec resume --last "<follow-up>"
 *   codex exec resume <SESSION_ID> "<follow-up>"
 */

// Re-export shared ACP builders from protocol.ts
export {
  buildAcpResponse,
  buildAcpNotification,
  buildAcpError,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  classifyTool,
  summarizeInput,
  parseNdjsonLine,
} from "./protocol";

export type { AcpPrompt, AcpMessage } from "./protocol";

// ─── Codex-specific types ────────────────────────────────────────────────────

export interface CodexEvent {
  type: string;
  // thread.started
  session_id?: string;
  // item events
  item?: {
    type: string;         // "message", "tool_use", "tool_result", "web_search"
    role?: string;        // "assistant", "system"
    content?: string;     // text content for messages
    name?: string;        // tool name
    id?: string;          // tool call id
    input?: unknown;      // tool input
    output?: string;      // tool result output
    [key: string]: unknown;
  };
  // turn.completed
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  // error / turn.failed
  error?: string;
  message?: string;
  [key: string]: unknown;
}

// ─── Codex CLI argument builders ─────────────────────────────────────────────

export function buildCodexExecArgs(
  prompt: string,
  options?: {
    fullAuto?: boolean;
    json?: boolean;
    ephemeral?: boolean;
    sandbox?: string;
    model?: string;
  }
): string[] {
  const args = ["exec"];

  if (options?.json !== false) {
    args.push("--json");
  }

  if (options?.fullAuto !== false) {
    args.push("--full-auto");
  }

  if (options?.ephemeral) {
    args.push("--ephemeral");
  }

  if (options?.sandbox) {
    args.push("--sandbox", options.sandbox);
  }

  if (options?.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  return args;
}

export function buildCodexResumeArgs(
  prompt: string,
  sessionId?: string,
  options?: { json?: boolean; fullAuto?: boolean }
): string[] {
  const args = ["exec", "resume"];

  if (options?.json !== false) {
    args.push("--json");
  }

  if (options?.fullAuto !== false) {
    args.push("--full-auto");
  }

  if (sessionId) {
    args.push(sessionId);
  } else {
    args.push("--last");
  }

  args.push(prompt);

  return args;
}

// ─── Codex event classification ──────────────────────────────────────────────

export function isTextMessage(event: CodexEvent): boolean {
  return (
    event.type === "item.created" &&
    event.item?.type === "message" &&
    event.item?.role === "assistant" &&
    typeof event.item?.content === "string"
  );
}

export function isToolUse(event: CodexEvent): boolean {
  return (
    event.type === "item.created" &&
    event.item?.type === "tool_use"
  );
}

export function isToolResult(event: CodexEvent): boolean {
  return (
    event.type === "item.created" &&
    event.item?.type === "tool_result"
  );
}

export function isTurnCompleted(event: CodexEvent): boolean {
  return event.type === "turn.completed";
}

export function isTurnFailed(event: CodexEvent): boolean {
  return event.type === "turn.failed";
}

export function isThreadStarted(event: CodexEvent): boolean {
  return event.type === "thread.started";
}

export function isError(event: CodexEvent): boolean {
  return event.type === "error";
}

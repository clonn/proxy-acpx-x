import { describe, it, expect } from "vitest";
import {
  extractTextFromPrompt,
  buildClaudeUserMessage,
  buildAgentMessageChunk,
  buildToolCall,
  buildToolResult,
  buildPromptResponse,
  buildAcpResponse,
  buildAcpError,
  buildClaudeArgs,
  classifyTool,
  summarizeInput,
  parseNdjsonLine,
} from "../src/protocol";

// ─── extractTextFromPrompt ───────────────────────────────────────────────────

describe("extractTextFromPrompt", () => {
  it("extracts text from a single text prompt", () => {
    const prompts = [{ type: "text", text: "Hello Claude" }];
    expect(extractTextFromPrompt(prompts)).toBe("Hello Claude");
  });

  it("joins multiple text prompts with newline", () => {
    const prompts = [
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ];
    expect(extractTextFromPrompt(prompts)).toBe("Line 1\nLine 2");
  });

  it("filters out non-text prompts", () => {
    const prompts = [
      { type: "text", text: "Hello" },
      { type: "image", text: "base64data" },
      { type: "text", text: "World" },
    ];
    expect(extractTextFromPrompt(prompts)).toBe("Hello\nWorld");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextFromPrompt([])).toBe("");
  });
});

// ─── buildClaudeUserMessage ──────────────────────────────────────────────────

describe("buildClaudeUserMessage", () => {
  it("builds correct stream-json input format", () => {
    const msg = buildClaudeUserMessage("Fix the bug");
    expect(msg).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "Fix the bug",
      },
    });
  });
});

// ─── ACP output builders ─────────────────────────────────────────────────────

describe("buildAgentMessageChunk", () => {
  it("builds an ACP notification with text chunk", () => {
    const result = buildAgentMessageChunk("session-1", "Hello ");
    expect(result).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        sessionUpdate: {
          type: "agent_message_chunk",
          textChunk: "Hello ",
        },
      },
    });
  });
});

describe("buildToolCall", () => {
  it("builds an ACP notification with tool call", () => {
    const result = buildToolCall("session-1", "tool-123", "Read", { file_path: "/foo" });
    expect(result).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        sessionUpdate: {
          type: "tool_call",
          toolCallId: "tool-123",
          toolName: "Read",
          toolCategory: "read",
          input: { file_path: "/foo" },
        },
      },
    });
  });
});

describe("buildToolResult", () => {
  it("builds an ACP notification with tool result", () => {
    const result = buildToolResult("session-1", "tool-123", "file contents here");
    expect(result).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        sessionUpdate: {
          type: "tool_result",
          toolCallId: "tool-123",
          output: "file contents here",
        },
      },
    });
  });
});

describe("buildPromptResponse", () => {
  it("builds a success response", () => {
    const result = buildPromptResponse(42, "end_turn", "Done!", { inputTokens: 100, outputTokens: 50 });
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {
        stopReason: "end_turn",
        result: "Done!",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    });
  });
});

describe("buildAcpResponse", () => {
  it("wraps result in jsonrpc response", () => {
    const result = buildAcpResponse(1, { foo: "bar" });
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: { foo: "bar" } });
  });
});

describe("buildAcpError", () => {
  it("builds a jsonrpc error", () => {
    const result = buildAcpError(1, -32601, "Method not found");
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
  });
});

// ─── classifyTool ────────────────────────────────────────────────────────────

describe("classifyTool", () => {
  it("classifies read tools", () => {
    expect(classifyTool("Read")).toBe("read");
    expect(classifyTool("Glob")).toBe("read");
    expect(classifyTool("Grep")).toBe("read");
    expect(classifyTool("WebFetch")).toBe("read");
    expect(classifyTool("WebSearch")).toBe("read");
  });

  it("classifies write tools", () => {
    expect(classifyTool("Write")).toBe("write");
    expect(classifyTool("Edit")).toBe("write");
    expect(classifyTool("NotebookEdit")).toBe("write");
  });

  it("classifies unknown tools as execute", () => {
    expect(classifyTool("Bash")).toBe("execute");
    expect(classifyTool("Agent")).toBe("execute");
    expect(classifyTool("CustomTool")).toBe("execute");
  });
});

// ─── summarizeInput ──────────────────────────────────────────────────────────

describe("summarizeInput", () => {
  it("returns short text as-is", () => {
    expect(summarizeInput("Hello")).toBe("Hello");
  });

  it("truncates long first line", () => {
    const long = "a".repeat(100);
    const result = summarizeInput(long);
    expect(result.length).toBe(83); // 80 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("only uses first line", () => {
    expect(summarizeInput("First line\nSecond line")).toBe("First line");
  });
});

// ─── parseNdjsonLine ─────────────────────────────────────────────────────────

describe("parseNdjsonLine", () => {
  it("parses valid JSON", () => {
    expect(parseNdjsonLine('{"type":"user"}')).toEqual({ type: "user" });
  });

  it("returns null for empty line", () => {
    expect(parseNdjsonLine("")).toBeNull();
    expect(parseNdjsonLine("  ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseNdjsonLine("not json")).toBeNull();
  });
});

// ─── buildClaudeArgs ─────────────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
  it("builds default args without bare and with bypassPermissions", () => {
    const args = buildClaudeArgs();
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--bare");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  it("can enable bare mode", () => {
    const args = buildClaudeArgs({ bare: true });
    expect(args).toContain("--bare");
  });

  it("can set custom permission mode", () => {
    const args = buildClaudeArgs({ permissionMode: "acceptEdits" });
    expect(args).toContain("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
  });

  it("can add allowed tools", () => {
    const args = buildClaudeArgs({ allowedTools: ["Read", "Edit"] });
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Edit");
  });
});

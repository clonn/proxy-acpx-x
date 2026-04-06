import { describe, it, expect } from "vitest";
import {
  buildGeminiArgs,
  classifyGeminiTool,
  isInit,
  isAssistantMessage,
  isUserMessage,
  isToolUse,
  isToolResult,
  isResult,
  isError,
  GeminiEvent,
} from "../src/gemini-protocol";

// ─── buildGeminiArgs ─────────────────────────────────────────────────────────

describe("buildGeminiArgs", () => {
  it("builds default args with stream-json and yolo", () => {
    const args = buildGeminiArgs("fix the bug");
    expect(args).toEqual(["--output-format", "stream-json", "--yolo", "fix the bug"]);
  });

  it("can use custom approval mode instead of yolo", () => {
    const args = buildGeminiArgs("test", { approvalMode: "auto_edit" });
    expect(args).not.toContain("--yolo");
    expect(args).toContain("--approval-mode");
    expect(args).toContain("auto_edit");
  });

  it("can set model", () => {
    const args = buildGeminiArgs("test", { model: "gemini-2.5-pro" });
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
  });

  it("can set allowed tools", () => {
    const args = buildGeminiArgs("test", { allowedTools: ["read_file", "glob"] });
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("read_file");
    expect(args).toContain("glob");
  });

  it("can override output format", () => {
    const args = buildGeminiArgs("test", { outputFormat: "json" });
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
  });
});

// ─── classifyGeminiTool ──────────────────────────────────────────────────────

describe("classifyGeminiTool", () => {
  it("classifies read tools", () => {
    expect(classifyGeminiTool("read_file")).toBe("read");
    expect(classifyGeminiTool("read_many_files")).toBe("read");
    expect(classifyGeminiTool("list_directory")).toBe("read");
    expect(classifyGeminiTool("glob")).toBe("read");
    expect(classifyGeminiTool("grep_search")).toBe("read");
    expect(classifyGeminiTool("google_web_search")).toBe("read");
    expect(classifyGeminiTool("web_fetch")).toBe("read");
  });

  it("classifies write tools", () => {
    expect(classifyGeminiTool("write_file")).toBe("write");
    expect(classifyGeminiTool("replace")).toBe("write");
  });

  it("classifies execute tools", () => {
    expect(classifyGeminiTool("run_shell_command")).toBe("execute");
    expect(classifyGeminiTool("save_memory")).toBe("execute");
    expect(classifyGeminiTool("unknown_tool")).toBe("execute");
  });
});

// ─── Event classifiers ───────────────────────────────────────────────────────

describe("event classifiers", () => {
  it("identifies init", () => {
    const event: GeminiEvent = { type: "init", session_id: "s1", model: "auto" };
    expect(isInit(event)).toBe(true);
    expect(isResult(event)).toBe(false);
  });

  it("identifies assistant message", () => {
    const event: GeminiEvent = { type: "message", role: "assistant", content: "Hello", delta: true };
    expect(isAssistantMessage(event)).toBe(true);
    expect(isUserMessage(event)).toBe(false);
  });

  it("identifies user message", () => {
    const event: GeminiEvent = { type: "message", role: "user", content: "Hi" };
    expect(isUserMessage(event)).toBe(true);
    expect(isAssistantMessage(event)).toBe(false);
  });

  it("identifies tool_use", () => {
    const event: GeminiEvent = {
      type: "tool_use",
      tool_name: "read_file",
      tool_id: "read_file-123",
      parameters: { file_path: "README.md" },
    };
    expect(isToolUse(event)).toBe(true);
    expect(isToolResult(event)).toBe(false);
  });

  it("identifies tool_result", () => {
    const event: GeminiEvent = {
      type: "tool_result",
      tool_id: "read_file-123",
      status: "success",
      output: "file contents",
    };
    expect(isToolResult(event)).toBe(true);
  });

  it("identifies result", () => {
    const event: GeminiEvent = {
      type: "result",
      status: "success",
      stats: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    };
    expect(isResult(event)).toBe(true);
  });

  it("identifies error", () => {
    const event: GeminiEvent = { type: "error", message: "API key invalid" };
    expect(isError(event)).toBe(true);
  });
});

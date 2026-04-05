import { describe, it, expect } from "vitest";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  isTextMessage,
  isToolUse,
  isToolResult,
  isTurnCompleted,
  isTurnFailed,
  isThreadStarted,
  isError,
  CodexEvent,
} from "../src/codex-protocol";

// ─── buildCodexExecArgs ──────────────────────────────────────────────────────

describe("buildCodexExecArgs", () => {
  it("builds default args with json and full-auto", () => {
    const args = buildCodexExecArgs("fix the bug");
    expect(args).toEqual(["exec", "--json", "--full-auto", "fix the bug"]);
  });

  it("can disable json", () => {
    const args = buildCodexExecArgs("test", { json: false });
    expect(args).not.toContain("--json");
    expect(args).toContain("--full-auto");
  });

  it("can disable full-auto", () => {
    const args = buildCodexExecArgs("test", { fullAuto: false });
    expect(args).not.toContain("--full-auto");
    expect(args).toContain("--json");
  });

  it("can add ephemeral flag", () => {
    const args = buildCodexExecArgs("test", { ephemeral: true });
    expect(args).toContain("--ephemeral");
  });

  it("can set sandbox mode", () => {
    const args = buildCodexExecArgs("test", { sandbox: "danger-full-access" });
    expect(args).toContain("--sandbox");
    expect(args).toContain("danger-full-access");
  });

  it("can set model", () => {
    const args = buildCodexExecArgs("test", { model: "gpt-4" });
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4");
  });
});

// ─── buildCodexResumeArgs ────────────────────────────────────────────────────

describe("buildCodexResumeArgs", () => {
  it("builds resume --last when no session ID", () => {
    const args = buildCodexResumeArgs("follow up");
    expect(args).toEqual(["exec", "resume", "--json", "--full-auto", "--last", "follow up"]);
  });

  it("builds resume with session ID", () => {
    const args = buildCodexResumeArgs("follow up", "sess-123");
    expect(args).toEqual(["exec", "resume", "--json", "--full-auto", "sess-123", "follow up"]);
  });
});

// ─── Event classification ────────────────────────────────────────────────────

describe("event classifiers", () => {
  it("identifies thread.started", () => {
    const event: CodexEvent = { type: "thread.started", session_id: "s1" };
    expect(isThreadStarted(event)).toBe(true);
    expect(isTurnCompleted(event)).toBe(false);
  });

  it("identifies text message", () => {
    const event: CodexEvent = {
      type: "item.created",
      item: { type: "message", role: "assistant", content: "Hello" },
    };
    expect(isTextMessage(event)).toBe(true);
    expect(isToolUse(event)).toBe(false);
  });

  it("rejects non-assistant messages", () => {
    const event: CodexEvent = {
      type: "item.created",
      item: { type: "message", role: "system", content: "System info" },
    };
    expect(isTextMessage(event)).toBe(false);
  });

  it("identifies tool_use", () => {
    const event: CodexEvent = {
      type: "item.created",
      item: { type: "tool_use", name: "shell", id: "t1", input: { command: "ls" } },
    };
    expect(isToolUse(event)).toBe(true);
    expect(isTextMessage(event)).toBe(false);
  });

  it("identifies tool_result", () => {
    const event: CodexEvent = {
      type: "item.created",
      item: { type: "tool_result", id: "t1", output: "file.txt" },
    };
    expect(isToolResult(event)).toBe(true);
  });

  it("identifies turn.completed", () => {
    const event: CodexEvent = {
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(isTurnCompleted(event)).toBe(true);
  });

  it("identifies turn.failed", () => {
    const event: CodexEvent = { type: "turn.failed", error: "timeout" };
    expect(isTurnFailed(event)).toBe(true);
  });

  it("identifies error", () => {
    const event: CodexEvent = { type: "error", message: "auth failed" };
    expect(isError(event)).toBe(true);
  });
});

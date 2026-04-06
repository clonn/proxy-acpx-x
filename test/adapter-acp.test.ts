/**
 * Integration tests for Claude and Codex ACP adapters.
 * Spawns each adapter as a child process and validates the ACP protocol.
 */
import { describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { resolve } from "path";

const CLAUDE_ADAPTER = resolve(__dirname, "../dist/adapter.js");
const CODEX_ADAPTER = resolve(__dirname, "../dist/codex-adapter.js");
const GEMINI_ADAPTER = resolve(__dirname, "../dist/gemini-adapter.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function spawnAdapter(scriptPath: string): ChildProcess {
  return spawn("node", [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sendAndCollect(
  proc: ChildProcess,
  messages: string[],
  expectedLines: number,
  timeoutMs = 5000
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const results: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Timeout: got ${results.length}/${expectedLines} responses`));
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      try {
        results.push(JSON.parse(line));
      } catch {
        // skip non-JSON lines
      }
      if (results.length >= expectedLines) {
        clearTimeout(timer);
        proc.kill("SIGTERM");
        resolve(results);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Send all messages
    for (const msg of messages) {
      proc.stdin!.write(msg + "\n");
    }
  });
}

function sendOne(
  proc: ChildProcess,
  message: string,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return sendAndCollect(proc, [message], 1, timeoutMs).then((r) => r[0]);
}

// ─── Shared ACP test suite ──────────────────────────────────────────────────

function testAcpAdapter(name: string, scriptPath: string, serverInfoName: string) {
  describe(`${name} ACP protocol`, () => {
    it("responds to initialize with capabilities", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {},
      }));

      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      const result = res.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2024-11-05");
      expect(result.capabilities).toEqual({ streaming: true, tools: true });
      const serverInfo = result.serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe(serverInfoName);
      expect(serverInfo.version).toBe("1.0.0");
    });

    it("creates a session with custom ID", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "session/create",
        params: { sessionId: "my-session" },
      }));

      expect(res.id).toBe(2);
      const result = res.result as Record<string, unknown>;
      expect(result.sessionId).toBe("my-session");
    });

    it("creates a session with auto-generated ID", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "session/create", params: {},
      }));

      expect(res.id).toBe(3);
      const result = res.result as Record<string, unknown>;
      expect(result.sessionId).toMatch(/^session-\d+$/);
    });

    it("returns end_turn for empty prompt", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "session/prompt",
        params: { prompt: [] },
      }));

      expect(res.id).toBe(4);
      const result = res.result as Record<string, unknown>;
      expect(result.stopReason).toBe("end_turn");
    });

    it("returns end_turn for prompt with no text blocks", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "session/prompt",
        params: { prompt: [{ type: "image", text: "base64data" }] },
      }));

      expect(res.id).toBe(5);
      const result = res.result as Record<string, unknown>;
      expect(result.stopReason).toBe("end_turn");
    });

    it("returns JSON-RPC error for unknown method", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 6, method: "foo/bar", params: {},
      }));

      expect(res.id).toBe(6);
      expect(res.error).toBeDefined();
      const error = res.error as Record<string, unknown>;
      expect(error.code).toBe(-32601);
      expect(error.message).toContain("foo/bar");
    });

    it("handles session/cancel", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "session/cancel", params: {},
      }));

      expect(res.id).toBe(7);
      const result = res.result as Record<string, unknown>;
      expect(result.cancelled).toBe(true);
    });

    it("handles session/close", async () => {
      const proc = spawnAdapter(scriptPath);
      const res = await sendOne(proc, JSON.stringify({
        jsonrpc: "2.0", id: 8, method: "session/close", params: {},
      }));

      expect(res.id).toBe(8);
      const result = res.result as Record<string, unknown>;
      expect(result.closed).toBe(true);
    });

    it("handles notifications/initialized silently", async () => {
      const proc = spawnAdapter(scriptPath);
      // Send init + notification + close — expect only 2 responses (init + close)
      const results = await sendAndCollect(proc, [
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 11, method: "session/close", params: {} }),
      ], 2);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(10); // initialize response
      expect(results[1].id).toBe(11); // close response
    });

    it("recovers from invalid JSON input", async () => {
      const proc = spawnAdapter(scriptPath);
      // Send garbage, then a valid message — should still respond
      const results = await sendAndCollect(proc, [
        "this is not json",
        "",
        JSON.stringify({ jsonrpc: "2.0", id: 12, method: "session/close", params: {} }),
      ], 1);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(12);
      const result = results[0].result as Record<string, unknown>;
      expect(result.closed).toBe(true);
    });

    it("handles full ACP lifecycle: init → create → prompt(empty) → close", async () => {
      const proc = spawnAdapter(scriptPath);
      const results = await sendAndCollect(proc, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/create", params: { sessionId: "lifecycle-test" } }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { prompt: [] } }),
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/close", params: {} }),
      ], 4);

      expect(results).toHaveLength(4);

      // init
      expect(results[0].id).toBe(1);
      expect((results[0].result as Record<string, unknown>).protocolVersion).toBe("2024-11-05");

      // create
      expect(results[1].id).toBe(2);
      expect((results[1].result as Record<string, unknown>).sessionId).toBe("lifecycle-test");

      // empty prompt
      expect(results[2].id).toBe(3);
      expect((results[2].result as Record<string, unknown>).stopReason).toBe("end_turn");

      // close
      expect(results[3].id).toBe(4);
      expect((results[3].result as Record<string, unknown>).closed).toBe(true);
    });

    it("handles multiple session/create calls", async () => {
      const proc = spawnAdapter(scriptPath);
      const results = await sendAndCollect(proc, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/create", params: { sessionId: "first" } }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/create", params: { sessionId: "second" } }),
      ], 2);

      expect((results[0].result as Record<string, unknown>).sessionId).toBe("first");
      expect((results[1].result as Record<string, unknown>).sessionId).toBe("second");
    });

    it("handles cancel then close in sequence", async () => {
      const proc = spawnAdapter(scriptPath);
      const results = await sendAndCollect(proc, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/cancel", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/close", params: {} }),
      ], 2);

      expect((results[0].result as Record<string, unknown>).cancelled).toBe(true);
      expect((results[1].result as Record<string, unknown>).closed).toBe(true);
    });

    it("returns correct error code for multiple unknown methods", async () => {
      const proc = spawnAdapter(scriptPath);
      const results = await sendAndCollect(proc, [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x/a", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "y/b", params: {} }),
      ], 2);

      for (const res of results) {
        const error = res.error as Record<string, unknown>;
        expect(error.code).toBe(-32601);
      }
      expect((results[0].error as Record<string, unknown>).message).toContain("x/a");
      expect((results[1].error as Record<string, unknown>).message).toContain("y/b");
    });
  });
}

// ─── Run tests for both adapters ─────────────────────────────────────────────

testAcpAdapter("Claude", CLAUDE_ADAPTER, "proxy-acpx-x");
testAcpAdapter("Codex", CODEX_ADAPTER, "proxy-acpx-x-codex");
testAcpAdapter("Gemini", GEMINI_ADAPTER, "proxy-acpx-x-gemini");

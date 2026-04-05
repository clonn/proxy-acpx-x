你把整個資料流梳理得非常清晰！沒錯，你的 App（OpenClaw）就是發起請求的起點，而最終目標是讓指令安全地送到本機的 Claude Code 執行。

不過，我必須先踩個煞車：就像我們一開始聊到的，把原廠 CLI 包裝成 API 來規避官方計費通道，嚴格來說違反了 Anthropic 的服務條款。受限於我的安全與合規規範，**我無法直接幫你撰寫這個用來「攔截與轉換」的中介程式碼（Provider Wrapper 腳本），也無法提供規避平台限制的「一鍵安裝」實作步驟。**

但如果我們單純從「系統架構整合」與「OpenClaw 軟體設定」的工程角度來看，有經驗的開發者要將這些開源套件串接起來，通常會依循以下三個概念性的實作階段：

### 階段一：架設本地端的中介伺服器 (The Local Provider)
這是整個架構的核心，也就是你找到的 Gist 腳本發揮作用的地方。
1. **建立 API 端點**：開發者通常會用 Node.js (Express) 或 Python (FastAPI) 在本機起一個小型伺服器（例如跑在 `localhost:3000`）。這個伺服器必須對外提供一個 `POST /v1/chat/completions` 的端點，用來假裝自己是 OpenAI。
2. **接收與轉譯**：當伺服器收到 OpenClaw 傳來包含 `sould.md`（System Prompt）和使用者對話的 JSON 請求時，它需要將這些內容提取出來，轉換成文字指令。
3. **呼叫 `acpx` 子行程**：接著，伺服器在背景使用子行程模組（如 Node.js 的 `child_process.spawn`）執行類似 `npx acpx@latest ...` 的指令，把整理好的文字餵給它。

### 階段二：處理資料流與格式轉換 (Stream Parsing)
這一步是讓 OpenClaw 不會 Crash 的關鍵。
1. **接聽 NDJSON**：`acpx` 會在背景喚醒 Claude Code CLI，並將 CLI 的輸出轉化為乾淨的 JSON 行（NDJSON）回傳給你的伺服器。
2. **反向封裝**：你的伺服器必須即時（Streaming）讀取這些 `acpx` 的輸出，把裡面的文字提取出來，重新包裝成 OpenAI 規定的 Server-Sent Events (SSE) 格式。
   * 格式長得像這樣：`data: {"choices": [{"delta": {"content": "Claude 回覆的文字"}}]}`
3. **回傳給 OpenClaw**：把包裝好的資料流即時打回給 OpenClaw 的介面。

### 階段三：設定 OpenClaw 指向本地
當你的中介伺服器（Provider）順利跑起來之後，最後一步就是在 OpenClaw 裡「偷天換日」。
1. 打開 OpenClaw 的設定面板 (Settings / Preferences)。
2. 找到 **LLM Provider** 或 Model Settings 的區塊。
3. 將提供者切換為 **OpenAI Compatible** 或 **Custom Endpoint**。
4. **Base URL (API URL)**：填入你本地伺服器的位址，例如 `http://127.0.0.1:3000/v1`。
5. **API Key**：因為是打本機伺服器，通常隨便填個字串（例如 `sk-dummy-key`）讓軟體過關即可。
6. **Model Name**：填寫你想讓介面顯示的模型名稱（例如 `claude-3-5-sonnet-acpx`）。

---
https://gist.github.com/sing1ee/b0fa6438a28d2bce1aa2ca42f280b060

配置步骤：

```bash
# 1. 安装 acpx 插件
openclaw plugins install @openclaw/acpx

# 2. 配置 OpenClaw（.OPENCLAW 是你的 config 目录）
openclaw config set plugins.entries.acpx.enabled true
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set acp.enabled true
openclaw config set acp.dispatch.enabled true
openclaw config set acp.backend acpx
openclaw config set acp.defaultAgent claude

# 3. 重启 gateway
```

或者直接编辑 `~/.openclaw/config.json`：

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "permissionMode": "approve-all"
        }
      }
    }
  },
  "acp": {
    "enabled": true,
    "dispatch": { "enabled": true },
    "backend": "acpx",
    "defaultAgent": "claude"
  }
}
```

然后验证：
```bash
/acp doctor
/acp spawn claude --mode persistent --thread auto
```

## 该怎么用呢？

简单用法：

**方法一：直接对话**
```
你: "用 Claude Code 帮我重构这个函数"
```

OpenClaw 会自动走 ACP 路由到 Claude Code（如果你配置了 `acp.defaultAgent: claude`）。

---

**方法二：手动 spawn 会话**
```
/acp spawn claude --mode persistent --thread auto
```
然后在同一 thread 里继续对话，所有内容会发给 Claude Code。

---

**方法三：用 sessions_spawn 工具**
```json
{
  "task": "帮我写个测试",
  "runtime": "acp",
  "agentId": "claude",
  "thread": true,
  "mode": "session"
}
```

---

**常用命令**
| 命令 | 作用 |
|------|------|
| `/acp status` | 查看当前会话状态 |
| `/acp steer <指令>` | 发送 steer 指令给正在运行的会话 |
| `/acp cancel` | 取消当前 turn |
| `/acp close` | 关闭会话 |

---

**关键点**： ACP 会话是**非交互式**的，所以 `permissionMode: approve-all` 是必须的，否则写文件/exec 命令会失败。


https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers.md

---
and 

https://github.com/openclaw/openclaw/issues/60901

## 背景

OpenClawのACPセッションで「Claude Codeで実行して」と依頼した場合、現状は以下の経路を辿る:

```
OpenClaw → acpx → @zed-industries/claude-agent-acp → Anthropic API (直接)
```

Claude Code CLIは経由しておらず、Zed社製のACPアダプターがAnthropic APIを直接叩いている。このため**Claude Codeのサブスクリプション認証は利用できない**（APIキーが必要）。

## 提案: スタンドアロンの ACP ↔ stream-json アダプター

Claude Code CLIの `--input-format stream-json` / `--output-format stream-json` とACPプロトコルの間を変換する**薄いアダプタースクリプト（1ファイル, 200〜300行）** を外部 npm パッケージとして作る。OpenClaw 本体のコード変更は不要。

### アーキテクチャ

```
【現状】
OpenClaw → acpx → @zed/claude-agent-acp → Anthropic API（APIキー必須）

【提案】
OpenClaw → acpx → claude-code-acp-adapter → claude CLI (stream-json) → Anthropic API
                   （npm パッケージ, 新規）    （サブスク認証OK）
```

### なぜ成立するか

ACPもClaude Code stream-jsonも「stdin/stdout上のNDJSON（改行区切りJSON）」。構造が同じなので、JSONフィールド名の変換だけで繋がる:

| ACP (acpx側) | Claude Code stream-json |
|---|---|
| `session/prompt { prompt: [{type:"text", text:"..."}] }` | `{"type":"user","message":"..."}` |
| `session/update { sessionUpdate:"agent_message_chunk" }` | `{"type":"assistant","message":{content:[{type:"text"}]}}` |
| `session/update { sessionUpdate:"tool_call" }` | `{"type":"assistant","message":{content:[{type:"tool_use"}]}}` |
| `prompt response { stopReason:"end_turn" }` | `{"type":"result","subtype":"success"}` |
| `session/request_permission` | ⚠️ stream-json単体では非対応（後述） |

### ファイル構成

```
claude-code-acp-adapter/        ← スタンドアロン npm パッケージ（OpenClaw リポ外）
├── package.json
├── adapter.ts                  ← 本体（200〜300行）
└── tsconfig.json
```

### adapter.ts の構成（4パート）

```
Part 1: Claude Code CLI を子プロセスとして起動（30行）
  claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions

Part 2: ACP入力を読み取り、stream-jsonに変換（40行）
  session/prompt → {"type":"user","message":"..."}
  initialize → 応答返却
  cancel → プロセス kill

Part 3: Claude Code出力をACPイベントに変換（100行）
  assistant (text) → agent_message_chunk
  assistant (tool_use) → tool_call
  result → prompt response (stopReason, usage)

Part 4: ユーティリティ（30行）
  emitAcp(), classifyTool(), summarizeInput()
```

### 登録方法（OpenClaw側の変更は config のみ）

```bash
# npm パッケージとして公開した場合
acpx config set agents.claude-native.command "npx -y claude-code-acp-adapter"

# ローカルスクリプトの場合
acpx config set agents.claude-native.command "node /path/to/adapter.js"

# OpenClaw config
acp.defaultAgent: "claude-native"
```

### 権限処理

stream-json 単体ではACPの `request_permission` に相当する対話型権限リクエストができない。対処法は2つ:

**方法A: 事前許可で割り切る（追加工数ゼロ）**
- `--permission-mode bypassPermissions` または `--allowedTools` で事前に全許可
- 動的な権限対話はできないが、実用上は十分なケースが多い

**方法B: Claude Agent SDK の permissionHandler を使う（追加 2〜3日）**
- SDK経由で `permissionHandler` コールバックを実装
- ACPの `request_permission` と完全互換の動的権限制御が可能
- adapter.ts が SDK 依存になる

### 工数見積もり

| スコープ | 工数 |
|---|---|
| 方法A（事前許可、stream-json直接） | 1〜2日 |
| 方法B（動的権限、Agent SDK使用） | 3〜5日 |

### 参考情報

- Claude Code headless docs: https://code.claude.com/docs/en/headless
- Agent SDK streaming: https://platform.claude.com/docs/en/agent-sdk/streaming-output
- `--input-format stream-json` 未ドキュメント部分: https://github.com/anthropics/claude-code/issues/24594
- acpx builtin registry: `extensions/acpx/src/runtime-internals/mcp-agent-command.ts`
- ACP protocol types: `@agentclientprotocol/sdk`
- 既存コミュニティラッパー: [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper), [claude-wrapper](https://github.com/ChrisColeTech/claude-wrapper)

---
finally, how can we use the flow to implement a method which is using apx to replace the model provider escpeically for claude .

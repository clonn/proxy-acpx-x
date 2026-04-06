#!/bin/bash
# Smoke tests for proxy-acpx-x adapters
# Tests ACP protocol handling for both Claude and Codex adapters
# Does NOT require actual Claude/Codex CLI
#
# Usage:
#   bash test/smoke.sh              # Test both adapters
#   bash test/smoke.sh claude       # Test Claude adapter only
#   bash test/smoke.sh codex        # Test Codex adapter only

set -uo pipefail

CLAUDE_ADAPTER="node dist/adapter.js"
CODEX_ADAPTER="node dist/codex-adapter.js"
GEMINI_ADAPTER="node dist/gemini-adapter.js"
PASSED=0
FAILED=0
TARGET="${1:-all}"

# Helper: send ACP message and get first response line
# Uses a background process + timeout to avoid hangs
send_acp() {
  local adapter="$1"
  local input="$2"
  local tmpfile
  tmpfile=$(mktemp)

  # Start adapter in background, send input, capture output
  echo "$input" | $adapter > "$tmpfile" 2>/dev/null &
  local pid=$!

  # Wait up to 3 seconds for output
  local i=0
  while [ $i -lt 30 ]; do
    if [ -s "$tmpfile" ]; then
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done

  kill $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true

  head -1 "$tmpfile"
  rm -f "$tmpfile"
}

# Helper: send multiple ACP messages and get last response
send_acp_last() {
  local adapter="$1"
  local input="$2"
  local expected_lines="$3"
  local tmpfile
  tmpfile=$(mktemp)

  printf '%s\n' "$input" | $adapter > "$tmpfile" 2>/dev/null &
  local pid=$!

  local i=0
  while [ $i -lt 30 ]; do
    local count
    count=$(wc -l < "$tmpfile" | tr -d ' ')
    if [ "$count" -ge "$expected_lines" ]; then
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done

  kill $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true

  tail -1 "$tmpfile"
  rm -f "$tmpfile"
}

# Helper: assert JSON
assert_json() {
  local test_name="$1"
  local result="$2"
  local assertion="$3"

  if [ -z "$result" ]; then
    echo "  FAIL: $test_name (empty response)"
    ((FAILED++))
    return
  fi

  if echo "$result" | python3 -c "
import sys, json
r = json.load(sys.stdin)
$assertion
print('PASS')
" 2>/dev/null; then
    ((PASSED++))
  else
    echo "  FAIL: $test_name"
    echo "  Response: $result"
    ((FAILED++))
  fi
}

# ─── Tests ────────────────────────────────────────────────────────────────────

run_adapter_tests() {
  local name="$1"
  local adapter="$2"
  local server_name="$3"

  echo "=== $name ==="
  echo ""

  echo "Test 1: Session create"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":1,"method":"session/create","params":{"sessionId":"test"}}')
  assert_json "session/create" "$RESULT" "
assert r['id'] == 1
assert r['result']['sessionId'] == 'test'
"

  echo "Test 2: Empty prompt"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[]}}')
  assert_json "empty prompt" "$RESULT" "
assert r['id'] == 2
assert r['result']['stopReason'] == 'end_turn'
"

  echo "Test 3: Non-text prompt"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"image","text":"x"}]}}')
  assert_json "non-text prompt" "$RESULT" "
assert r['id'] == 3
assert r['result']['stopReason'] == 'end_turn'
"

  echo "Test 4: Unknown method"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":4,"method":"foo/bar","params":{}}')
  assert_json "unknown method" "$RESULT" "
assert r['id'] == 4
assert 'error' in r
assert r['error']['code'] == -32601
"

  echo "Test 5: Session cancel"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":5,"method":"session/cancel","params":{}}')
  assert_json "session/cancel" "$RESULT" "
assert r['id'] == 5
assert r['result']['cancelled'] == True
"

  echo "Test 6: Session close"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":6,"method":"session/close","params":{}}')
  assert_json "session/close" "$RESULT" "
assert r['id'] == 6
assert r['result']['closed'] == True
"

  echo "Test 7: Initialize"
  RESULT=$(send_acp "$adapter" '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}')
  assert_json "initialize" "$RESULT" "
assert r['id'] == 7
assert r['result']['serverInfo']['name'] == '$server_name'
assert r['result']['capabilities']['streaming'] == True
"

  echo "Test 8: Lifecycle (create → prompt → close)"
  INPUT=$'{"jsonrpc":"2.0","id":8,"method":"session/create","params":{"sessionId":"lc"}}\n{"jsonrpc":"2.0","id":9,"method":"session/prompt","params":{"prompt":[]}}\n{"jsonrpc":"2.0","id":10,"method":"session/close","params":{}}'
  RESULT=$(send_acp_last "$adapter" "$INPUT" 3)
  assert_json "lifecycle" "$RESULT" "
assert r['id'] == 10
assert r['result']['closed'] == True
"

  echo ""
}

# ─── Run ──────────────────────────────────────────────────────────────────────

echo ""
echo "=============================="
echo "  proxy-acpx-x Smoke Tests"
echo "=============================="
echo ""

case "$TARGET" in
  claude) run_adapter_tests "Claude (proxy-acpx-claude)" "$CLAUDE_ADAPTER" "proxy-acpx-x" ;;
  codex)  run_adapter_tests "Codex (proxy-acpx-codex)" "$CODEX_ADAPTER" "proxy-acpx-x-codex" ;;
  gemini) run_adapter_tests "Gemini (proxy-acpx-gemini)" "$GEMINI_ADAPTER" "proxy-acpx-x-gemini" ;;
  all)
    run_adapter_tests "Claude (proxy-acpx-claude)" "$CLAUDE_ADAPTER" "proxy-acpx-x"
    run_adapter_tests "Codex (proxy-acpx-codex)" "$CODEX_ADAPTER" "proxy-acpx-x-codex"
    run_adapter_tests "Gemini (proxy-acpx-gemini)" "$GEMINI_ADAPTER" "proxy-acpx-x-gemini"
    ;;
  *) echo "Usage: $0 [claude|codex|gemini|all]"; exit 1 ;;
esac

echo "=============================="
echo "  Results: $PASSED passed, $FAILED failed"
echo "=============================="

[ "$FAILED" -gt 0 ] && exit 1 || exit 0

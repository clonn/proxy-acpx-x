#!/bin/bash
# Smoke test for proxy-acpx-x adapter
# Tests the ACP protocol handshake without actually calling Claude API
#
# Usage: bash test/smoke.sh

set -euo pipefail

ADAPTER="node dist/adapter.js"
PASSED=0
FAILED=0

echo "=== proxy-acpx-x Smoke Tests ==="
echo ""

# Helper: send ACP message and capture first stdout line
# Uses perl-based timeout for macOS compatibility
send_acp() {
  local input="$1"
  echo "$input" | perl -e 'alarm 5; exec @ARGV' $ADAPTER 2>/dev/null | head -1
}

# Test 1: Initialize handshake
echo "Test 1: Initialize handshake"
RESULT=$(send_acp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')

if echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r['jsonrpc'] == '2.0'
assert r['id'] == 1
assert 'result' in r
assert r['result']['serverInfo']['name'] == 'proxy-acpx-x'
assert r['result']['capabilities']['streaming'] == True
print('PASS')
" 2>/dev/null; then
  ((PASSED++))
else
  echo "  FAIL: unexpected response: $RESULT"
  ((FAILED++))
fi

# Test 2: Session create
echo "Test 2: Session create"
RESULT=$(send_acp '{"jsonrpc":"2.0","id":2,"method":"session/create","params":{"sessionId":"test-session"}}')

if echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r['id'] == 2
assert r['result']['sessionId'] == 'test-session'
print('PASS')
" 2>/dev/null; then
  ((PASSED++))
else
  echo "  FAIL: unexpected response: $RESULT"
  ((FAILED++))
fi

# Test 3: Empty prompt returns immediately
echo "Test 3: Empty prompt returns end_turn"
RESULT=$(send_acp '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[]}}')

if echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r['id'] == 3
assert r['result']['stopReason'] == 'end_turn'
print('PASS')
" 2>/dev/null; then
  ((PASSED++))
else
  echo "  FAIL: unexpected response: $RESULT"
  ((FAILED++))
fi

# Test 4: Unknown method returns error
echo "Test 4: Unknown method returns error"
RESULT=$(send_acp '{"jsonrpc":"2.0","id":4,"method":"unknown/method","params":{}}')

if echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r['id'] == 4
assert 'error' in r
assert r['error']['code'] == -32601
print('PASS')
" 2>/dev/null; then
  ((PASSED++))
else
  echo "  FAIL: unexpected response: $RESULT"
  ((FAILED++))
fi

# Test 5: Session close
echo "Test 5: Session close"
RESULT=$(send_acp '{"jsonrpc":"2.0","id":5,"method":"session/close","params":{}}')

if echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r['id'] == 5
assert r['result']['closed'] == True
print('PASS')
" 2>/dev/null; then
  ((PASSED++))
else
  echo "  FAIL: unexpected response: $RESULT"
  ((FAILED++))
fi

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

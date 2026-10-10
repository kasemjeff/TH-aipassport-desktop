#!/bin/bash
# End-to-end check: bridge up, extension connected, models list, one chat.
BASE_URL="http://127.0.0.1:8787"
echo "=== aipass-bridge diagnostics ==="

echo; echo "1. bridge status"
STATUS=$(curl -s "${BASE_URL}/status" || curl -s "${BASE_URL}/health")
echo "$STATUS"
EXT_COUNT=$(echo "$STATUS" | grep -o '"extensions":[0-9]*' | cut -d':' -f2)
if [ "${EXT_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo "OK: extension connected (extensions=$EXT_COUNT)"
else
    echo "WARN: extension not connected. Open https://de.aipass.net/chat in the noVNC window and log in."
fi

echo; echo "2. models (/v1/models)"
curl -s "${BASE_URL}/v1/models"

echo; echo; echo "3. chat completion (gemini-3.1-flash-lite)"
curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-flash-lite","messages":[{"role":"user","content":"reply in one short sentence that the system is ready"}]}'
echo

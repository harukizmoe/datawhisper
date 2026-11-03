#!/usr/bin/env bash
# Record a /subscribe SSE stream (fixture for the desktop spike's view test) while two prompts run:
# one with a tool call, one plain markdown reply (queued as a follow-up).
# Usage: BASE=http://127.0.0.1:47811 TOKEN=spike-token-123 scripts/record-stream.sh <out.sse>
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:47811}
TOKEN=${TOKEN:?TOKEN required}
OUT=${1:?output file required}

curl -s -N -H "Authorization: Bearer $TOKEN" "$BASE/v1/conversations/root/subscribe" --max-time 10 -o "$OUT" &
SUB=$!
sleep 0.5
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"requestId":"rec-1","text":"Describe sales CALL:describe_table{\"table\":\"sales\"}"}' "$BASE/v1/conversations/root/submit"; echo
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"requestId":"rec-2","text":"Summarize the data"}' "$BASE/v1/conversations/root/submit"; echo
wait $SUB || true
echo "recorded $(grep -c '^event: ' "$OUT") events, $(wc -c <"$OUT") bytes -> $OUT"

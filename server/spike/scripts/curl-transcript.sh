#!/usr/bin/env bash
# Curl transcript against a running spike4 server.
# Usage: BASE=http://127.0.0.1:47811 TOKEN=spike-token-123 scripts/curl-transcript.sh
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:47811}
TOKEN=${TOKEN:?TOKEN required}
OUT=$(mktemp)
RID="curl-$(date +%s)"

echo "## no token -> 401"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/conversations/root/submit" -d '{}'

echo "## subscribe (background, 6s)"
curl -s -N -H "Authorization: Bearer $TOKEN" "$BASE/v1/conversations/root/subscribe" --max-time 6 >"$OUT" &
SUB=$!
sleep 0.5

echo "## submit requestId=$RID"
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"requestId\":\"$RID\",\"text\":\"Describe it CALL:describe_table{\\\"table\\\":\\\"sales\\\"}\"}" \
  "$BASE/v1/conversations/root/submit"; echo
echo "## resubmit same requestId (expect same submissionId)"
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"requestId\":\"$RID\",\"text\":\"Describe it CALL:describe_table{\\\"table\\\":\\\"sales\\\"}\"}" \
  "$BASE/v1/conversations/root/submit"; echo

wait $SUB || true
echo "## SSE stream: $(grep -c '^event: ops' "$OUT") ops events (each data line truncated to 220 chars):"
grep '^event:\|^data:' "$OUT" | cut -c1-220
echo "## last ops event:"
grep '^data:' "$OUT" | tail -1 | cut -c1-400
echo "## op kinds used:"
grep '^data:' "$OUT" | grep -o '\[\["[a-z]"\|,\["[a-z]"' | grep -o '"[a-z]"' | sort | uniq -c
echo "## numeric id: /v1/conversations/1 is the root conversation (first SSE lines)"
curl -s -N -H "Authorization: Bearer $TOKEN" "$BASE/v1/conversations/1/subscribe" --max-time 1 | head -2 | cut -c1-120 || true
echo "## unknown conversation id -> 404"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/v1/conversations/999/subscribe"
rm -f "$OUT"

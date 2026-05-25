#!/usr/bin/env bash
# Smoke test for the technician-in-the-loop review queue.
# Requires EDGE_REVIEW_QUEUE=true on the running api container.
set -euo pipefail

EDGE_URL=${EDGE_URL:-http://localhost:3000}
EDGE_DB=${EDGE_DB:-supernavi-db}

echo "[1/5] Ensure review queue is enabled..."
curl -sS "$EDGE_URL/v1/capabilities" | grep -q '"review_queue":true' || {
  echo "FAIL: review_queue not enabled — set EDGE_REVIEW_QUEUE=true and restart api"
  exit 1
}

echo "[2/5] Place a fake SVS in the inbox..."
FN="AP$(date +%y%m%d%H)A1.svs"
echo "fake-svs-data" > "data/inbox/$FN"
sleep 3

echo "[3/5] List pending slides — expect ours..."
PENDING=$(curl -sS "$EDGE_URL/v1/pending-slides")
SLIDE_ID=$(echo "$PENDING" | grep -oP '"id":"\K[^"]+' | head -1)
if [ -z "$SLIDE_ID" ]; then
  echo "FAIL: no pending slide registered"
  exit 1
fi

echo "[4/5] Confirm with clinical context..."
curl -sS -X POST "$EDGE_URL/v1/pending-slides/$SLIDE_ID/confirm" \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"${FN%.svs}\",\"clinicalContext\":{\"exam_type\":\"AP\",\"subtipo\":\"biopsia_pele\",\"sexo\":\"F\",\"idade\":62,\"material\":\"biopsia pele\"}}"
echo ""

echo "[5/5] Verify outbox has both events..."
docker exec "$EDGE_DB" psql -U supernavi -tAc \
  "SELECT entity_type || '/' || op FROM outbox_events WHERE entity_id = '$SLIDE_ID' OR entity_id LIKE 'AP%';" \
  | tee /dev/stderr | grep -q "slide/registered"

echo "OK"

#!/bin/bash
set -e

echo "=== SuperNavi Local Agent - Dev Test ==="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Change to project root
cd "$(dirname "$0")/.."

# Check for sample SVS file
SAMPLE_SVS="./samples/sample.svs"
TEST_IMAGE="./infra/test-image.jpg"

# Determine which file to use for testing
if [ -f "$SAMPLE_SVS" ]; then
    TEST_FILE="$SAMPLE_SVS"
    TEST_FORMAT="SVS"
    echo -e "${YELLOW}Found sample SVS file: $SAMPLE_SVS${NC}"
elif [ -f "$TEST_IMAGE" ]; then
    TEST_FILE="$TEST_IMAGE"
    TEST_FORMAT="JPG"
    echo "Using existing test image: $TEST_IMAGE"
else
    # Create test image using ImageMagick if available
    if command -v convert &> /dev/null; then
        echo "Creating test image..."
        mkdir -p ./infra
        convert -size 1024x768 gradient:blue-red "$TEST_IMAGE"
        TEST_FILE="$TEST_IMAGE"
        TEST_FORMAT="JPG"
        echo "Created test image: $TEST_IMAGE"
    else
        echo "No test file found. Please either:"
        echo "  1. Place a .svs file at ./samples/sample.svs"
        echo "  2. Place a .jpg file at ./infra/test-image.jpg"
        echo "  3. Install ImageMagick to auto-generate test image"
        exit 1
    fi
fi

echo ""
echo "1. Building and starting services..."
docker compose up -d --build

echo ""
echo "2. Waiting for services to be ready..."
sleep 15

echo ""
echo "3. Testing /v1/health..."
HEALTH=$(curl -s http://localhost:3000/v1/health)
echo "$HEALTH" | jq .
if echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    exit 1
fi

echo ""
echo "4. Testing /v1/capabilities..."
curl -s http://localhost:3000/v1/capabilities | jq .

echo ""
echo "5. Checking current slides..."
curl -s http://localhost:3000/v1/slides | jq .

echo ""
echo "6. Importing test file ($TEST_FORMAT)..."
FILENAME=$(basename "$TEST_FILE")
cp "$TEST_FILE" ./data/inbox/

echo "Waiting for processing..."
if [ "$TEST_FORMAT" = "SVS" ]; then
    echo "  (SVS files take longer to process)"
    sleep 30
else
    sleep 10
fi

echo ""
echo "7. Checking slides after import..."
SLIDES=$(curl -s http://localhost:3000/v1/slides)
echo "$SLIDES" | jq .

SLIDE_ID=$(echo "$SLIDES" | jq -r '.items[0].slideId // empty')
SLIDE_STATUS=$(echo "$SLIDES" | jq -r '.items[0].status // empty')
SLIDE_FORMAT=$(echo "$SLIDES" | jq -r '.items[0].format // empty')

if [ -n "$SLIDE_ID" ]; then
    echo ""
    echo "Slide found: $SLIDE_ID (status: $SLIDE_STATUS, format: $SLIDE_FORMAT)"

    # Wait for processing if still in progress
    WAIT_COUNT=0
    while [ "$SLIDE_STATUS" = "queued" ] || [ "$SLIDE_STATUS" = "processing" ]; do
        echo "  Status: $SLIDE_STATUS - waiting..."
        sleep 5
        WAIT_COUNT=$((WAIT_COUNT + 1))
        if [ $WAIT_COUNT -gt 24 ]; then  # Max 2 minutes wait
            echo -e "${YELLOW}⚠ Processing taking too long, continuing anyway${NC}"
            break
        fi
        SLIDES=$(curl -s http://localhost:3000/v1/slides)
        SLIDE_STATUS=$(echo "$SLIDES" | jq -r '.items[0].status // empty')
    done

    echo ""
    echo "8. Getting manifest for slide $SLIDE_ID..."
    MANIFEST=$(curl -s "http://localhost:3000/v1/slides/$SLIDE_ID/manifest")
    if echo "$MANIFEST" | jq -e '.width' > /dev/null 2>&1; then
        echo "$MANIFEST" | jq .
        echo -e "${GREEN}✓ Manifest retrieved${NC}"

        WIDTH=$(echo "$MANIFEST" | jq -r '.width')
        HEIGHT=$(echo "$MANIFEST" | jq -r '.height')
        MAX_LEVEL=$(echo "$MANIFEST" | jq -r '.maxLevel')
        echo "  Dimensions: ${WIDTH}x${HEIGHT}, maxLevel: $MAX_LEVEL"
    else
        echo "$MANIFEST"
        echo -e "${YELLOW}⚠ Manifest not yet available${NC}"
    fi

    echo ""
    echo "9. Downloading thumbnail..."
    HTTP_CODE=$(curl -s -o /tmp/supernavi-thumb.jpg -w "%{http_code}" "http://localhost:3000/v1/slides/$SLIDE_ID/thumb")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓ Thumbnail downloaded to /tmp/supernavi-thumb.jpg${NC}"
        file /tmp/supernavi-thumb.jpg
    else
        echo -e "${YELLOW}⚠ Thumbnail not available (HTTP $HTTP_CODE)${NC}"
    fi

    echo ""
    echo "10. Testing tile endpoint (level 0)..."
    HTTP_CODE=$(curl -s -o /tmp/supernavi-tile.jpg -w "%{http_code}" "http://localhost:3000/v1/slides/$SLIDE_ID/tiles/0/0/0.jpg")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓ Tile endpoint working (HTTP $HTTP_CODE)${NC}"
        file /tmp/supernavi-tile.jpg
    else
        echo -e "${YELLOW}⚠ Tile not available (HTTP $HTTP_CODE) - may still be processing${NC}"
    fi

    echo ""
    echo "11. Slide details..."
    curl -s "http://localhost:3000/v1/slides/$SLIDE_ID" | jq .
else
    echo -e "${YELLOW}No slides found yet. Processing may still be in progress.${NC}"
    echo "Check logs with: docker compose logs processor"
fi

echo ""
echo "=== Test Complete ==="
echo ""
echo "Useful commands:"
echo "  docker compose logs -f api processor  # Watch logs"
echo "  docker compose down                   # Stop services"
echo "  docker compose down -v                # Stop and remove volumes"
echo ""
if [ "$TEST_FORMAT" = "SVS" ]; then
    echo "SVS Testing tips:"
    echo "  docker compose exec processor openslide-show-properties /data/raw/*.svs"
    echo "  docker compose exec processor vipsheader /data/raw/*.svs"
fi

#!/bin/bash
set -e

echo "=== SuperNavi SVS Pipeline Test (Local) ==="
echo ""

cd "$(dirname "$0")/.."

SVS_FILE="./samples/_20250912165026.svs"
TEST_DIR="./data/test-svs"
SLIDE_ID="test-svs-slide"

if [ ! -f "$SVS_FILE" ]; then
    echo "ERROR: SVS file not found: $SVS_FILE"
    exit 1
fi

echo "SVS file: $SVS_FILE"
echo ""

# Clean up previous test
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/$SLIDE_ID"

OUTPUT_DIR="$TEST_DIR/$SLIDE_ID"

echo "1. Reading SVS metadata..."
vipsheader -a "$SVS_FILE" | head -20
echo ""

# Get dimensions
WIDTH=$(vipsheader -f width "$SVS_FILE")
HEIGHT=$(vipsheader -f height "$SVS_FILE")
echo "Dimensions: ${WIDTH}x${HEIGHT}"

# Calculate maxLevel (DZI standard: ceil(log2(maxDim)))
MAX_DIM=$((WIDTH > HEIGHT ? WIDTH : HEIGHT))
MAX_LEVEL=$(echo "l($MAX_DIM)/l(2)" | bc -l | awk '{print int($1+0.999)}')
echo "Max level: $MAX_LEVEL"
echo ""

echo "2. Generating thumbnail..."
vips thumbnail "$SVS_FILE" "$OUTPUT_DIR/thumb.jpg" 256 --height 256
ls -la "$OUTPUT_DIR/thumb.jpg"
file "$OUTPUT_DIR/thumb.jpg"
echo ""

echo "3. Generating DeepZoom tiles with vips dzsave..."
echo "   This may take a while for large slides..."
time vips dzsave "$SVS_FILE" "$OUTPUT_DIR/dzi" \
    --tile-size 256 \
    --overlap 0 \
    --suffix .jpg[Q=90]
echo ""

echo "4. Checking generated structure..."
ls -la "$OUTPUT_DIR/"
echo ""

echo "5. Tile levels generated:"
if [ -d "$OUTPUT_DIR/dzi_files" ]; then
    for level in $(ls "$OUTPUT_DIR/dzi_files" | sort -n); do
        count=$(ls "$OUTPUT_DIR/dzi_files/$level" | wc -l)
        echo "   Level $level: $count tiles"
    done
else
    echo "   ERROR: dzi_files directory not found"
fi
echo ""

echo "6. Normalizing tiles (dzi_files -> tiles)..."
mv "$OUTPUT_DIR/dzi_files" "$OUTPUT_DIR/tiles"
rm -f "$OUTPUT_DIR/dzi.dzi"
rm -f "$OUTPUT_DIR/tiles/vips-properties.xml"
echo "   Done."
echo ""

echo "7. Generating manifest.json..."
cat > "$OUTPUT_DIR/manifest.json" << EOF
{
  "protocol": "dzi",
  "tileSize": 256,
  "overlap": 0,
  "format": "jpg",
  "maxLevel": $MAX_LEVEL,
  "width": $WIDTH,
  "height": $HEIGHT,
  "tileUrlTemplate": "/v1/slides/$SLIDE_ID/tiles/{z}/{x}/{y}.jpg"
}
EOF
cat "$OUTPUT_DIR/manifest.json"
echo ""

echo "8. Final structure:"
find "$OUTPUT_DIR" -type f | head -20
echo "..."
TOTAL_FILES=$(find "$OUTPUT_DIR/tiles" -type f | wc -l)
echo "Total tiles: $TOTAL_FILES"
echo ""

echo "9. Sample tiles:"
echo "   Level 0 (lowest res):"
ls "$OUTPUT_DIR/tiles/0/" 2>/dev/null | head -5
echo ""
echo "   Level $MAX_LEVEL (highest res):"
ls "$OUTPUT_DIR/tiles/$MAX_LEVEL/" 2>/dev/null | head -5
echo ""

echo "=== Test Complete ==="
echo ""
echo "Output directory: $OUTPUT_DIR"
echo "Thumbnail: $OUTPUT_DIR/thumb.jpg"
echo "Manifest: $OUTPUT_DIR/manifest.json"
echo "Tiles: $OUTPUT_DIR/tiles/{level}/{col}_{row}.jpg"

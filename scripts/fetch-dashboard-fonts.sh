#!/usr/bin/env bash
# Downloads the latin woff2 faces of Atkinson Hyperlegible Next (400/500/700)
# into api/src/dashboard/fonts/. Run once; the files are committed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/api/src/dashboard/fonts"
mkdir -p "$DIR"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
for W in 400 500 700; do
  CSS=$(curl -sf -A "$UA" "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@${W}&display=swap")
  # The latin block is the last @font-face in the response; take its woff2 URL.
  URL=$(printf '%s' "$CSS" | awk '/\/\* latin \*\//{f=1} f && /url\(/{print; exit}' | sed -E 's/.*url\(([^)]+)\).*/\1/')
  [ -n "$URL" ] || { echo "no latin url for weight $W"; exit 1; }
  curl -sf -A "$UA" "$URL" -o "$DIR/atkinson-hyperlegible-next-${W}.woff2"
  echo "weight $W -> $(wc -c < "$DIR/atkinson-hyperlegible-next-${W}.woff2") bytes"
done

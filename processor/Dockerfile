FROM node:20-bookworm-slim

# Install OpenSlide, libvips and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # OpenSlide
    libopenslide0 \
    libopenslide-dev \
    openslide-tools \
    # libvips (8.14 on Bookworm)
    libvips42 \
    libvips-dev \
    libvips-tools \
    # JPEG: ensure turbo variant is used (SIMD-accelerated encode/decode)
    libjpeg62-turbo \
    libturbojpeg0 \
    # Build tools for sharp
    build-essential \
    python3 \
    # Other
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN vips --version && openslide-show-properties --version || echo "Version check skipped"
# Confirm libjpeg-turbo is linked
RUN ldd $(which vips) 2>/dev/null | grep -i jpeg || echo "JPEG linkage check skipped"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src

ENV NODE_ENV=production
# vips uses all available CPUs by default (0 = auto-detect nproc)
ENV VIPS_CONCURRENCY=0

CMD ["node", "src/worker.js"]

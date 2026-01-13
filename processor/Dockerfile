FROM node:20-bookworm-slim

# Install OpenSlide, libvips and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # OpenSlide
    libopenslide0 \
    libopenslide-dev \
    openslide-tools \
    # libvips
    libvips42 \
    libvips-dev \
    libvips-tools \
    # Build tools for sharp
    build-essential \
    python3 \
    # Other
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN vips --version && openslide-show-properties --version || echo "Version check skipped"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src

ENV NODE_ENV=production

CMD ["node", "src/worker.js"]

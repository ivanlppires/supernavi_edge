FROM node:20-alpine

# Install OpenSlide, libvips and dependencies
RUN apk add --no-cache \
    # Build tools
    build-base \
    python3 \
    # OpenSlide and dependencies
    openslide \
    openslide-dev \
    openslide-tools \
    # libvips with OpenSlide support
    vips \
    vips-dev \
    vips-tools \
    # Image format support
    libjpeg-turbo \
    libpng \
    tiff \
    # Other dependencies
    ca-certificates \
    bash

# Verify installations
RUN vips --version && openslide-show-properties --version || true

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src

# Environment
ENV NODE_ENV=production

CMD ["node", "src/worker.js"]

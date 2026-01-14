FROM node:20-bookworm-slim

# Install OpenSlide and libvips for on-demand tile generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenslide0 \
    openslide-tools \
    libvips42 \
    libvips-tools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src

EXPOSE 3000

CMD ["node", "src/server.js"]

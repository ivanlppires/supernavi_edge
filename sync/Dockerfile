# Sync Service - Local to Cloud Push
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY src/ ./src/

# Health check - sync doesn't expose HTTP, just check process
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "node src/worker.js" || exit 1

# Run
CMD ["node", "src/worker.js"]

# Stage 1: Build
FROM node:20 AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npx tsc

# Stage 2: Runtime
FROM node:20-slim
WORKDIR /app

# Install ffmpeg and build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/web/views ./dist/web/views

RUN mkdir -p logs data

EXPOSE 1935 3000

CMD ["node", "dist/index.js"]

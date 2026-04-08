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

# Install build tools for native modules (better-sqlite3), wget for ffmpeg, ssh for tunnel proxy
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    wget \
    ca-certificates \
    xz-utils \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install static ffmpeg built with OpenSSL (GnuTLS version has TLS issues with Facebook RTMPS)
RUN wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
    && tar xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && mv ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ffmpeg \
    && mv ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ffprobe \
    && rm -rf ffmpeg-*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/web/views ./dist/web/views
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p logs data

EXPOSE 1935 3000

ENTRYPOINT ["./docker-entrypoint.sh"]

FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# Create logs directory
RUN mkdir -p logs

EXPOSE 1935 3000

CMD ["node", "dist/index.js"]

# Production-grade image: deps baked in, no npm install at runtime.
FROM node:22-bookworm-slim

# Install dependencies including jemalloc for memory stabilization
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deterministic install: lockfile only, then npm ci
COPY package.json package-lock.json ./
RUN npm ci

# Application code (node_modules excluded via .dockerignore)
COPY . .

ENV LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libjemalloc.so.2"

EXPOSE 8080

# AutoSupportClaw: support-triage heartbeat + health server (single process)
CMD ["npm", "run", "support"]

# Native healthcheck: 200 = healthy, 500 or unreachable = restart
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

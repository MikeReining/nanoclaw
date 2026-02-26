# Production-grade image: deps baked in, no npm install at runtime.
FROM node:22-bookworm-slim

# Build chain for native modules (e.g. better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deterministic install: lockfile only, then npm ci
COPY package.json package-lock.json ./
RUN npm ci

# Application code (node_modules excluded via .dockerignore)
COPY . .

EXPOSE 3000

# AutoSupportClaw: support-triage heartbeat
CMD ["npm", "run", "support"]

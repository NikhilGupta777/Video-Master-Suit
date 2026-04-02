FROM ubuntu:24.04

# ── System packages ─────────────────────────────────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      gnupg \
      ffmpeg \
      python3 \
      python3-pip \
      git \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 24 via NodeSource ────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── pnpm ─────────────────────────────────────────────────────────────────────
RUN npm install -g pnpm@10

# ── yt-dlp ───────────────────────────────────────────────────────────────────
RUN pip3 install --break-system-packages yt-dlp

# ── App source ────────────────────────────────────────────────────────────────
WORKDIR /app

# Copy everything — .dockerignore excludes node_modules, dist, .git, etc.
COPY . .

# ── Install Node.js dependencies ──────────────────────────────────────────────
# --ignore-scripts skips postinstall uv sync (Python already handled above)
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Build frontend ────────────────────────────────────────────────────────────
RUN pnpm --filter @workspace/yt-downloader run build

# ── Build backend ─────────────────────────────────────────────────────────────
RUN pnpm --filter @workspace/api-server run build

# ── Runtime environment ───────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=/app/artifacts/yt-downloader/dist/public

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

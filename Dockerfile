# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build — compile TypeScript and bake the Prisma client.
# The official Playwright image already contains Node 22, Chromium, and all
# of Chromium's system dependencies, so no extra apt packages are needed.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /app

# Browsers already exist in the base image at the matching version.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY prisma ./prisma

# postinstall runs `prisma generate`; prisma/ is copied first so it succeeds.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime — same Playwright base (Chromium + deps included).
# Deployed as a Render FREE WEB SERVICE: it binds $PORT (Render requirement),
# uses NO persistent disk (free tier can't attach one), and keeps all durable
# state — including the storageState credential — in Postgres.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

ENV NODE_ENV=production \
    HEADLESS=true \
    BROWSER_PROFILE_PATH=/tmp/browser-profile \
    STORAGE_STATE_PATH=/tmp/storage-state.json \
    DIAGNOSTICS_DIR=/tmp/diagnostics \
    # 512MB free instance: keep Node's heap comfortably under the ceiling.
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

# python3 for the local Python validation runner (already in the base image).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Firefox for the Codeforces submit path. Cloudflare bounces every POST from
# this instance's IP unless the client passed its challenge, which only a real
# browser does; Chromium is handed "Just a moment..." on Codeforces, Firefox is
# served normally. The base image already ships the system dependencies, so this
# only makes sure the Firefox build matches the Playwright version in use.
RUN npx playwright install firefox

# Run as the pre-existing non-root user shipped with the Playwright image.
RUN mkdir -p /tmp/browser-profile /tmp/diagnostics && chown -R pwuser:pwuser /tmp/browser-profile /tmp/diagnostics /app
USER pwuser

# Apply migrations, then start the service. `prisma migrate deploy` is
# idempotent and safe across restarts and free-tier spin-downs.
CMD ["sh", "-c", "npx prisma migrate deploy && node --expose-gc dist/src/main.js"]

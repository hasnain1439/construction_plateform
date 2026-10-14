# syntax=docker/dockerfile:1.7
#
# Construction Platform API — production image.
#
#   docker build -t construction-api .
#   docker run --env-file .env -p 4000:4000 construction-api            # API (default command)
#   docker run --env-file .env construction-api migrate                 # prisma migrate deploy, then exit
#
# Debian slim (not alpine): Playwright's chromium (PDFs) and Prisma's schema engine need glibc.
ARG NODE_VERSION=24

# ─── build: all deps, prisma generate, tsc ────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npm run build

# Production dependencies only — but keep the Prisma CLI (+ its schema engine) for the `migrate`
# command: inside the image only, prisma is moved from devDependencies to dependencies before pruning.
RUN PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")" \
  && npm pkg delete devDependencies.prisma \
  && npm pkg set "dependencies.prisma=${PRISMA_VERSION}" \
  && npm prune --omit=dev \
  && npm cache clean --force

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ARG GIT_SHA=dev
# Set INSTALL_CHROMIUM=false for a much smaller image without PDF rendering (PDF routes answer 503).
ARG INSTALL_CHROMIUM=true
ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=/app/storage \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    SENTRY_RELEASE=construction-api@${GIT_SHA} \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
# Headless chromium + its system libraries for HTML → PDF (src/core/pdf/renderer.ts).
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright; \
    fi

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
# Urdu font for PDFs (Noto Nastaliq Urdu, SIL OFL 1.1), embedded into Urdu PDFs by src/core/pdf/fonts.ts.
COPY --chown=node:node assets ./assets
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/storage && chown node:node /app/storage

LABEL org.opencontainers.image.title="construction-api" \
      org.opencontainers.image.revision="${GIT_SHA}"

USER node
EXPOSE 4000
# Liveness only (no database). Readiness with DB / storage checks: GET /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]

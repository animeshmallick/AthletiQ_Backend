# syntax=docker/dockerfile:1.7

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime
# Commit the image was built from: docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) …
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="athletiq-api" \
      org.opencontainers.image.source="https://github.com/animeshmallick/AthletiQ_Backend" \
      org.opencontainers.image.revision=$GIT_SHA
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One-off tasks use the same image (see deploy.md):
#   migrations: docker run --rm --env-file .env athletiq-api:<tag> node dist/db/migrate.js
#   first admin: docker run --rm --env-file .env athletiq-api:<tag> node dist/db/seed.js
CMD ["node", "dist/server.js"]

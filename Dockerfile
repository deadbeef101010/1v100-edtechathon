# syntax=docker/dockerfile:1.7

FROM node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573 AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/game.db \
    PORT=8000 \
    HOST=0.0.0.0

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
# Only the runtime subtrees: compiled tests and dev tools stay out of the image.
COPY --from=builder --chown=node:node /app/dist/src ./dist/src
COPY --from=builder --chown=node:node /app/dist/migrations ./dist/migrations
COPY --from=builder --chown=node:node /app/dist/static ./dist/static

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/server.js"]

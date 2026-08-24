FROM node:22.22.1-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG FRONTEND_ONLY=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}

COPY tsconfig.server.json tsconfig.site.json vite.config.ts ./
COPY server ./server
COPY scripts ./scripts
COPY site ./site
COPY test ./test
COPY artifacts ./artifacts
COPY contracts ./contracts
COPY src/footprints ./src/footprints
COPY src/surveys ./src/surveys
COPY src/layers ./src/layers
COPY requirements ./requirements
COPY docs ./docs
RUN if [ "$FRONTEND_ONLY" = "true" ]; then \
      npm run build:server && npm run build:site; \
    else \
      npm run build; \
    fi \
    && npm prune --omit=dev --offline

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    ASSET_RELEASE_ROOT=/app/release \
    PUBLIC_SITE_ROOT=/app/site

WORKDIR /app
RUN groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid atlas --no-create-home atlas \
    && mkdir -p /data /tmp \
    && chown -R atlas:atlas /data /tmp
COPY --from=build --chown=atlas:atlas /app/dist/server ./dist/server
COPY --from=build --chown=atlas:atlas /app/dist/site ./site
COPY --from=build --chown=atlas:atlas /app/package.json ./package.json
COPY --from=build --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=build --chown=atlas:atlas /app/artifacts ./release/artifacts
COPY --from=build --chown=atlas:atlas /app/src/footprints ./release/src/footprints
COPY --from=build --chown=atlas:atlas /app/src/surveys ./release/src/surveys
COPY --from=build --chown=atlas:atlas /app/src/layers ./release/src/layers
COPY --from=build --chown=atlas:atlas /app/requirements ./release/requirements
COPY --from=build --chown=atlas:atlas /app/docs ./release/docs
COPY --from=build --chown=atlas:atlas /app/contracts ./release/contracts

USER 10001:10001
EXPOSE 4180
CMD ["node", "dist/server/server.js"]

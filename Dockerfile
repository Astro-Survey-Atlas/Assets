FROM node:22.22.1-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}

COPY tsconfig.server.json tsconfig.site.json vite.config.ts ./
COPY server ./server
COPY scripts ./scripts
COPY site ./site
COPY test ./test
COPY artifacts ./artifacts
COPY src/footprints ./src/footprints
COPY src/surveys ./src/surveys
COPY docs/public-footprint-moc-method.md ./docs/public-footprint-moc-method.md
RUN npm run build

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
COPY --from=build --chown=atlas:atlas /app/artifacts ./release/artifacts
COPY --from=build --chown=atlas:atlas /app/src/footprints ./release/src/footprints
COPY --from=build --chown=atlas:atlas /app/src/surveys ./release/src/surveys
COPY --from=build --chown=atlas:atlas /app/docs ./release/docs

USER 10001:10001
EXPOSE 4180
CMD ["node", "dist/server/server.js"]

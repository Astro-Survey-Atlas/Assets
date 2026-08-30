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
COPY src/moc-sources ./src/moc-sources
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
    PUBLIC_SITE_ROOT=/app/site \
    MOC_BUILDER_PYTHON=/usr/bin/python3

WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid atlas --no-create-home atlas \
    && mkdir -p /data /tmp \
    && chown -R atlas:atlas /data /tmp
COPY --from=build /app/requirements/requirements.lock /tmp/moc-requirements.lock
COPY --from=build /app/artifacts/public-survey-footprints/moc-core/astro_survey_moc_core-1.0.0-py3-none-any.whl /tmp/astro_survey_moc_core-1.0.0-py3-none-any.whl
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/moc-requirements.lock \
    && python3 -m pip install --break-system-packages --no-cache-dir --no-deps /tmp/astro_survey_moc_core-1.0.0-py3-none-any.whl \
    && rm -f /tmp/moc-requirements.lock /tmp/astro_survey_moc_core-1.0.0-py3-none-any.whl
COPY --from=build --chown=atlas:atlas /app/dist/server ./dist/server
COPY --from=build --chown=atlas:atlas /app/dist/site ./site
COPY --from=build --chown=atlas:atlas /app/scripts ./scripts
COPY --from=build --chown=atlas:atlas /app/package.json ./package.json
COPY --from=build --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=build --chown=atlas:atlas /app/artifacts ./release/artifacts
COPY --from=build --chown=atlas:atlas /app/src/footprints ./release/src/footprints
COPY --from=build --chown=atlas:atlas /app/src/surveys ./release/src/surveys
COPY --from=build --chown=atlas:atlas /app/src/layers ./release/src/layers
COPY --from=build --chown=atlas:atlas /app/src/moc-sources ./release/src/moc-sources
COPY --from=build --chown=atlas:atlas /app/requirements ./release/requirements
COPY --from=build --chown=atlas:atlas /app/docs ./release/docs
COPY --from=build --chown=atlas:atlas /app/contracts ./release/contracts

USER 10001:10001
EXPOSE 4180
CMD ["node", "dist/server/server.js"]

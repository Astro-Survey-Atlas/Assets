ARG MOC_CORE_WHEEL=astro_survey_moc_core-1.2.0-py3-none-any.whl
ARG MOC_CORE_SOURCE_SNAPSHOT=moc-core-source-1.2.0-d4357fe.tar.gz

FROM node:22.22.1-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG FRONTEND_ONLY=false
ARG MOC_CORE_WHEEL
ARG MOC_CORE_SOURCE_SNAPSHOT
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}

COPY tsconfig.server.json tsconfig.site.json vite.config.ts ./
COPY server ./server
COPY scripts ./scripts
COPY site ./site
COPY test ./test
COPY requirements ./requirements
COPY artifacts/public-survey-footprints/moc-core/${MOC_CORE_WHEEL} /tmp/${MOC_CORE_WHEEL}
COPY artifacts/public-survey-footprints/moc-core/${MOC_CORE_SOURCE_SNAPSHOT} /tmp/${MOC_CORE_SOURCE_SNAPSHOT}
RUN if [ "$FRONTEND_ONLY" = "true" ]; then \
      echo "FRONTEND_ONLY=true is incompatible with the archive-only runtime image (dist/server is required)" >&2; \
      exit 1; \
    fi \
    && npm run build:server && npm run build:site \
    && npm prune --omit=dev --offline

FROM node:22.22.1-bookworm-slim AS runtime

ARG MOC_CORE_WHEEL
ARG MOC_CORE_SOURCE_SNAPSHOT

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    ASSET_RELEASE_ROOT=/data/current \
    PUBLIC_SITE_ROOT=/app/site \
    MOC_BUILDER_PYTHON=/usr/bin/python3

WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 python3-pip tar \
    && tar --version \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 atlas \
    && useradd --uid 10001 --gid atlas --no-create-home atlas \
    && mkdir -p /data /tmp \
    && chown -R atlas:atlas /data /tmp
COPY --from=build /app/requirements/requirements.lock /tmp/moc-requirements.lock
COPY --from=build /app/requirements/moc-core-source.json /tmp/moc-core-source.json
COPY --from=build /app/scripts/verify_core_wheel.py /tmp/verify_core_wheel.py
COPY --from=build /tmp/${MOC_CORE_WHEEL} /tmp/${MOC_CORE_WHEEL}
COPY --from=build /tmp/${MOC_CORE_SOURCE_SNAPSHOT} /tmp/${MOC_CORE_SOURCE_SNAPSHOT}
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/moc-requirements.lock \
    && python3 /tmp/verify_core_wheel.py --source /tmp/moc-core-source.json --wheel /tmp/${MOC_CORE_WHEEL} --snapshot /tmp/${MOC_CORE_SOURCE_SNAPSHOT} \
    && python3 -m pip install --break-system-packages --no-cache-dir --no-deps /tmp/${MOC_CORE_WHEEL} \
    && rm -f /tmp/moc-requirements.lock /tmp/moc-core-source.json /tmp/verify_core_wheel.py /tmp/${MOC_CORE_WHEEL} /tmp/${MOC_CORE_SOURCE_SNAPSHOT}
COPY --from=build --chown=atlas:atlas /app/dist/server ./dist/server
COPY --from=build --chown=atlas:atlas /app/dist/scripts ./dist/scripts
COPY --from=build --chown=atlas:atlas /app/dist/site ./site
COPY --from=build --chown=atlas:atlas /app/scripts ./scripts
COPY --from=build --chown=atlas:atlas /app/package.json ./package.json
COPY --from=build --chown=atlas:atlas /app/node_modules ./node_modules

RUN command -v flock

USER 10001:10001
EXPOSE 4180
CMD ["node", "dist/server/server.js"]

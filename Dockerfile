# syntax=docker/dockerfile:1
ARG UPSTREAM_IMAGE=onlyoffice/documentserver:9.4.0@sha256:e3da62a847b9a5d51a11f73cfea1d9c13c3be3809614490d4edddcf01dcf919b
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${UPSTREAM_IMAGE} AS upstream
RUN dpkg-query -W -f='${Version}' onlyoffice-documentserver > /tmp/onlyoffice-package-version

FROM ${NODE_IMAGE} AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY server/ server/
COPY patches/manifest.json patches/manifest.json
COPY tests/capabilities.test.cjs tests/capabilities.test.cjs
COPY tests/branding.test.cjs tests/branding.test.cjs
COPY tests/converter.test.cjs tests/converter.test.cjs
COPY tests/config.test.cjs tests/config.test.cjs
COPY docker/branding/ docker/branding/
COPY docker/config/ docker/config/
COPY docker/prepare.py docker/prepare.py
COPY --from=upstream /tmp/onlyoffice-package-version /tmp/onlyoffice-package-version
ARG SOURCE_REVISION
ARG OFFICIER_VERSION=0.2.0
# Empty: the repository at SOURCE_REVISION; a release embeds its source archive (docker/source).
ARG OFFICIER_SOURCE_URL=
RUN node --test tests/capabilities.test.cjs tests/branding.test.cjs tests/converter.test.cjs \
    && python3 docker/prepare.py /src/server /tmp/onlyoffice-package-version "${SOURCE_REVISION}" "${OFFICIER_VERSION}" "${OFFICIER_SOURCE_URL}"
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefix server/Common \
    && npm ci --omit=dev --prefix server/DocService \
    && npm ci --omit=dev --prefix server/FileConverter \
    && npm ci --omit=dev --prefix server/Metrics \
    && node --test tests/config.test.cjs

FROM upstream AS officier
ARG SOURCE_REVISION
ARG OFFICIER_VERSION=0.2.0
LABEL org.opencontainers.image.title="Officier" \
      org.opencontainers.image.description="ONLYOFFICE 9.4.0 Community with Officier source-built server and customization patches" \
      org.opencontainers.image.source="https://github.com/pmcore-create/officier" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${OFFICIER_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.base.name="onlyoffice/documentserver:9.4.0" \
      org.opencontainers.image.base.digest="sha256:e3da62a847b9a5d51a11f73cfea1d9c13c3be3809614490d4edddcf01dcf919b"
COPY --from=server-build /usr/local/bin/node /usr/local/bin/officier-node
COPY --from=server-build /src/server/Common/ /var/www/onlyoffice/documentserver/server/Common/
COPY --from=server-build /src/server/DocService/ /var/www/onlyoffice/documentserver/server/DocService/
COPY --from=server-build /src/server/FileConverter/ /var/www/onlyoffice/documentserver/server/FileConverter/
COPY --from=server-build /src/server/Metrics/ /var/www/onlyoffice/documentserver/server/Metrics/
COPY --from=server-build /src/server/officier-build.json /usr/share/officier/build.json
COPY LICENSE /usr/share/officier/LICENSE
COPY patches/ /usr/share/officier/patches/
COPY --chmod=755 docker/fonts.sh /usr/local/bin/officier-fonts
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/officier-entrypoint
COPY docker/install.sh /tmp/officier-install.sh
COPY docker/welcome.html /tmp/officier-welcome.html
COPY docker/branding/ /tmp/officier-branding/
COPY docker/plugins/ /tmp/officier-plugins/
COPY docker/config/ /tmp/officier-config/
COPY docker/source/ /tmp/officier-source/
RUN bash /tmp/officier-install.sh && rm -r /tmp/officier-install.sh /tmp/officier-welcome.html /tmp/officier-branding /tmp/officier-plugins /tmp/officier-config /tmp/officier-source \
    && /usr/local/bin/officier-node --version
ENV OFFICIER_VERSION=${OFFICIER_VERSION}
# Fonts are generated at build time and, after custom fonts change, by the entrypoint before the
# server starts: the upstream start-time regeneration restarts DocService and drops open sessions.
# Marketplace plugins are not downloaded at start either.
ENV GENERATE_FONTS=false \
    PLUGINS_ENABLED=false
ENTRYPOINT ["/usr/local/bin/officier-entrypoint"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
    CMD curl --fail --silent http://127.0.0.1/healthcheck | grep -qx true || exit 1

# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${NODE_IMAGE} AS test
WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY test/ test/
RUN node --test "test/*.test.cjs"

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Officier QMS gateway" \
      org.opencontainers.image.description="QMS integration API of the Officier document server" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=test /app/package.json ./
COPY --from=test /app/src/ src/
ENV NODE_ENV=production GATEWAY_PORT=8081
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.GATEWAY_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]

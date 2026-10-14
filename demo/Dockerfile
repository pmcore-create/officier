# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json server.js sample.js index.html ./
RUN mkdir data && chown node:node data
ENV DEMO_PORT=8090 DEMO_DATA=/app/data
USER node
EXPOSE 8090
CMD ["node", "server.js"]

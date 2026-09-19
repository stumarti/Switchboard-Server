# Switchboard Server - home server companion for Switchboard, the X4 Pro
# smart-home remote firmware (github.com/stumarti/Switchboard). One instance
# per household; stores every room's profile and serves the admin UI every
# remote's Settings -> Select room talks to. Small Node/Express app, no
# native deps, so alpine keeps the image small.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached across code changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Set by release.yml via --build-arg VERSION=<tag, without the leading v>;
# a local `docker build` with no --build-arg gets "dev". Surfaced at
# GET /api/health for support/debugging.
ARG VERSION=dev
ENV APP_VERSION=$VERSION

ENV NODE_ENV=production
ENV PORT=45678
ENV DATA_DIR=/data
ENV MDNS_HOSTNAME=switchboard.local

VOLUME ["/data"]
EXPOSE 45678

# Basic container healthcheck against the app's own health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "server.js"]

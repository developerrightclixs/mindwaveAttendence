# Mindwave Attendance.
#
# This app is a single long-lived process with a SQLite file beside it. That
# rules out serverless platforms (Vercel, Lambda): their filesystems are
# read-only and their instances are discarded between requests, so the database
# would be recreated empty on every cold start.
#
# It runs anywhere that gives you a container and a persistent volume -
# Railway, Render, Fly.io, or any VPS. Mount a volume and point DB_PATH at it.

FROM node:22-bookworm-slim AS build

# better-sqlite3 is a native addon. Prebuilt binaries cover most platforms, but
# keep the toolchain available so a miss compiles instead of failing the build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/attendance.db \
    SECURE_COOKIES=1

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The volume mounts here. Owned by the node user so the app can write without
# running as root.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

# The platform's own health check hits this; it also proves the database opened.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

# syntax=docker/dockerfile:1
# Commit 16 container gate. The image installs its own linux/arm64 native
# bindings; the host's darwin-arm64 node_modules are never copied in.
FROM node:22-bookworm-slim

WORKDIR /app

# Only the runtime dependencies the federation node actually loads. Installing
# them here, in the image, is what gives better-sqlite3 a linux/arm64 binding.
RUN npm install --no-audit --no-fund --omit=dev \
      better-sqlite3@12.11.1 express@^4.21.2 \
  && npm cache clean --force

# Compiled JavaScript is platform independent, so the host build is reused.
COPY dist ./dist
COPY tests/docker/node-entry.mjs ./node-entry.mjs

ENV NODE_ENV=production
CMD ["node", "/app/node-entry.mjs"]

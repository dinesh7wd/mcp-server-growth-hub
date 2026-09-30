FROM node:22-alpine AS build
# Toolchain so better-sqlite3 can compile if no prebuilt musl binary is available
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" > /dev/null || exit 1
# Starts as root only to fix ownership of pre-existing volumes, then drops to the unprivileged "node" user.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$(id -u)\" = \"0\" ]; then chown -R node:node /data && exec su-exec node \"$@\"; fi; exec \"$@\"", "--"]
CMD ["node", "dist/index.js"]

# Mini Inference Router — one container serving both surfaces.
# The gateway (Fastify) listens on PORT (3000 here) and, when CONSOLE_DIST is
# set, also serves the built console — one origin for UI + API, matches the
# nginx rule that fronts this box.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Workspace lockfile first so install layers cache independently of source.
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/
COPY console/package.json console/
COPY eval/package.json eval/
RUN npm ci

COPY gateway/ gateway/
COPY console/ console/
# KB source (19 MB Bitext slice, gitignored) → data/kb.json is built here so
# the runtime image never carries the raw CSV.
COPY gateway/data/ gateway/data/

RUN npm run build && npm run build:kb

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/gateway
ENV NODE_ENV=production PORT=3000

# Same base image as the build stage: better-sqlite3's native binding stays
# loadable without toolchain packages in the runtime layer.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/gateway/dist /app/gateway/dist
COPY --from=build /app/gateway/package.json /app/gateway/package.json
COPY --from=build /app/gateway/data/kb.json /app/gateway/data/kb.json
COPY --from=build /app/console/dist /app/console/dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
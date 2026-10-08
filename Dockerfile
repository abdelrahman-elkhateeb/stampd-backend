# Production image: compiled JS and production dependencies only.
# On start: sync indexes + apply data migrations, then run the API.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
# exec: node becomes PID 1 and receives SIGTERM for a graceful shutdown.
CMD ["sh", "-c", "node dist/platform/db/migrate-cli.js && exec node dist/server.js"]

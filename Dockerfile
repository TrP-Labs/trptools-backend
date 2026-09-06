# syntax=docker/dockerfile:1

# Dependencies are installed in their own stage so a source-only change does
# not invalidate the install layer.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# drizzle-kit and the migration files are needed at start so the container can
# bring its own schema up to date.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY --from=build /app/dist ./dist

# Never run as root.
USER bun

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD bun --eval "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "bunx drizzle-kit migrate && bun run dist/index.js"]

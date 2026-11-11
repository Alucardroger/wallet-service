# syntax=docker/dockerfile:1

# ---- dependencies: production packages only, exactly as locked in bun.lock
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime: Bun runs the TypeScript sources directly, no build step
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# Exec form: SIGTERM reaches the application, which shuts down gracefully.
CMD ["bun", "run", "src/main.ts"]

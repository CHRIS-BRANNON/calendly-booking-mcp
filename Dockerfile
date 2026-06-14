FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
RUN bun audit --level high
COPY tsconfig.json eslint.config.js ./
COPY src/ ./src/
RUN bun run lint

FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun audit --level high
RUN bunx playwright install --with-deps chromium && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/src ./src/

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["bun", "src/index.ts"]

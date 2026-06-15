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

ARG CREATED=unknown
ARG REVISION=unknown
ARG VERSION=dev

LABEL org.opencontainers.image.created=$CREATED \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.title="calendly-booking-mcp" \
      org.opencontainers.image.description="MCP server for booking Calendly appointments via AI clients using Playwright and Google OAuth" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/CHRIS-BRANNON/calendly-booking-mcp" \
      org.opencontainers.image.url="https://github.com/CHRIS-BRANNON/calendly-booking-mcp"

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN bun audit --level high
RUN bunx playwright install --with-deps chromium && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    mv /root/.cache/ms-playwright /ms-playwright && \
    chown -R bun:bun /ms-playwright /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --chown=bun:bun --from=build /app/src ./src/

USER bun

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["bun", "src/index.ts"]

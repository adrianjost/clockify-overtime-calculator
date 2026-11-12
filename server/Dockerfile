# Build context is the repository root:
#   docker build -f server/Dockerfile -t ghcr.io/adrianjost/clockify-overtime-calculator-server .
# The web page is the same on every platform, so it is built natively.
FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS web
WORKDIR /src
COPY src ./src
COPY macos/ClockifyOvertime/Assets.xcassets/AppIcon.appiconset/icon_256x256@2x.png ./icon.png
RUN bun build src/web/index.ts --target=browser --outdir=/public \
  && cp src/web/index.html src/web/web.css src/mainview/index.css icon.png /public/

FROM oven/bun:1-alpine
WORKDIR /app
COPY server/server.ts .
COPY --from=web /public ./public
ENV PORT=8080 DB_PATH=/data/time-tracking.db
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["bun", "server.ts"]

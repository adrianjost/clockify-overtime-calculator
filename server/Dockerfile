# Build context is the repository root:
#   docker build -f server/Dockerfile -t ghcr.io/adrianjost/clockify-overtime-calculator-server .
# The web page is the same on every platform, so it is built natively.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS web
WORKDIR /src
COPY src ./src
COPY macos/ClockifyOvertime/Assets.xcassets/AppIcon.appiconset/icon_256x256@2x.png ./icon.png
RUN bun build src/web/index.ts --target=browser --outdir=/public \
  && cp src/web/index.html src/web/web.css src/mainview/index.css icon.png /public/

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
RUN apk add --no-cache su-exec
WORKDIR /app
COPY server/server.ts server/entrypoint.sh ./
COPY --from=web /public ./public
ENV PORT=8080 DB_PATH=/data/time-tracking.db NODE_ENV=production BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "server.ts"]

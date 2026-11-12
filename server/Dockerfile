FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts .
ENV PORT=8080 DB_PATH=/data/time-tracking.db
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["bun", "server.ts"]

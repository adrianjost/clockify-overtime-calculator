#!/bin/sh
set -e
# The server runs as the unprivileged bun user. Older versions ran as root, so their data
# belongs to root and is handed over first.
if [ "$(id -u)" = 0 ]; then
  data="$(dirname "$DB_PATH")"
  mkdir -p "$data"
  find "$data" ! -user bun -exec chown bun:bun {} +
  exec su-exec bun "$@"
fi
exec "$@"

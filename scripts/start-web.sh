#!/bin/sh
set -u

# Migrations can use a direct database URL while the application uses its pooled URL.
# Prisma must retain its advisory lock; never start the app after a failed migration.
migration_url=${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}
attempt=1
max_attempts=3
output=$(mktemp) || exit 1
trap 'rm -f "$output"' EXIT HUP INT TERM

while :; do
  echo "[start-web] Running migrations (attempt $attempt/$max_attempts)."
  if DATABASE_URL="$migration_url" npx prisma migrate deploy >"$output" 2>&1; then
    cat "$output"
    break
  fi
  cat "$output" >&2
  if [ "$attempt" -ge "$max_attempts" ] || ! grep -q 'P1002' "$output" || ! grep -qi 'advisory lock' "$output"; then
    echo '[start-web] Migrations failed; application will not start.' >&2
    exit 1
  fi
  echo '[start-web] Advisory lock timed out; retrying in 5 seconds.' >&2
  attempt=$((attempt + 1))
  sleep 5
done

exec node --expose-gc dist/src/main.js

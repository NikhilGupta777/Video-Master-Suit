#!/bin/sh
set -e

echo "==> Waiting for database to be ready..."
# Give the DB a moment if it just became healthy
sleep 1

echo "==> Running database schema push..."
if pnpm --filter @workspace/db run push-force 2>&1; then
  echo "==> Database schema is up to date."
else
  echo "ERROR: Database schema push failed. Check DATABASE_URL and DB connectivity."
  exit 1
fi

echo "==> Starting YTGrabber server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs

#!/bin/sh
set -e

npx prisma migrate deploy

if [ "$RUN_SEED" = "true" ]; then
  npx prisma db seed
fi

exec "$@"

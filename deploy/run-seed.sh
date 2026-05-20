#!/usr/bin/env bash
# Run prisma seed against the production DB using a one-shot Node container.
# Idempotent — safe to re-run.
set -e
cd /opt/Crm-Tradeway550
# shellcheck disable=SC1091
source .env.prod

DBURL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}?schema=public"

echo "=== seed run ==="
docker run --rm \
  --network crm-prod_crm-net \
  -v /opt/Crm-Tradeway550:/repo \
  -w /repo/apps/api \
  -e DATABASE_URL="$DBURL" \
  -e SEED_DEFAULT_PASSWORD="$SEED_DEFAULT_PASSWORD" \
  node:20-bookworm-slim \
  bash -lc '
    set -e
    apt-get update -qq
    apt-get install -y -qq openssl ca-certificates >/dev/null 2>&1
    corepack enable
    corepack prepare pnpm@9.0.0 --activate >/dev/null 2>&1
    cd /repo
    pnpm install --frozen-lockfile=false --prefer-offline 2>&1 | tail -5
    cd apps/api
    npx -y prisma@5.22.0 generate --schema=prisma/schema.prisma >/dev/null 2>&1
    npx -y tsx prisma/seed.ts
  '

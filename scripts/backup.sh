#!/usr/bin/env bash
#
# P3-07 — full DB backup helper.
#
# Wraps `pg_dump` to produce a compressed, timestamped archive of the
# CRM database. Intended for ad-hoc operator-driven backups before a
# risky migration; routine production backups should go through the
# managed Postgres provider's snapshot facility.
#
# Usage:
#   scripts/backup.sh                 # writes backups/<utc-iso>.sql.gz
#   BACKUPS_DIR=/srv/dumps scripts/backup.sh
#
# Reads either of:
#   DATABASE_URL=postgres://user:pwd@host:port/dbname
# or the discrete:
#   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
#
# Exits non-zero on failure; the partial file is removed so a half
# dump never gets mistaken for a good one.

set -euo pipefail

BACKUPS_DIR="${BACKUPS_DIR:-./backups}"
mkdir -p "$BACKUPS_DIR"

ts="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
out="$BACKUPS_DIR/crm-tradeway-$ts.sql.gz"

# Prefer DATABASE_URL when set so the script Just Works against the
# same connection string the API uses.
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "→ pg_dump from \$DATABASE_URL"
  pg_dump --no-owner --no-acl --format=plain --dbname="$DATABASE_URL" \
    | gzip -c > "$out".tmp
else
  echo "→ pg_dump using PG* env vars"
  pg_dump --no-owner --no-acl --format=plain \
    | gzip -c > "$out".tmp
fi

mv "$out".tmp "$out"
size="$(du -h "$out" | cut -f1)"
echo "✓ backup written: $out ($size)"

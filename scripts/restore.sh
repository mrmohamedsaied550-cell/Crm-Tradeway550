#!/usr/bin/env bash
#
# P3-07 — restore from a pg_dump archive.
#
# DESTRUCTIVE. Drops every existing object in the target database
# and replays the dump on top. Always run this against a freshly
# created database (or one you're explicitly OK to wipe).
#
# Usage:
#   scripts/restore.sh path/to/dump.sql.gz
#
# The script refuses to run unless `RESTORE_CONFIRM=I_UNDERSTAND` is
# in the environment. A second prompt asks for the literal database
# name to be typed back. These two gates are deliberate friction —
# the cost of a mistaken restore is much higher than the cost of an
# extra keystroke.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <dump.sql.gz>" >&2
  exit 2
fi

dump="$1"
if [[ ! -r "$dump" ]]; then
  echo "✗ dump file not readable: $dump" >&2
  exit 2
fi

if [[ "${RESTORE_CONFIRM:-}" != "I_UNDERSTAND" ]]; then
  echo "✗ refusing to restore without RESTORE_CONFIRM=I_UNDERSTAND in env" >&2
  exit 2
fi

# Resolve the target dbname for the second confirmation prompt.
target_db=""
if [[ -n "${DATABASE_URL:-}" ]]; then
  # Strip any query string and pull the last path segment.
  target_db="$(echo "$DATABASE_URL" | sed -E 's|^.*/([^/?]+)(\?.*)?$|\1|')"
elif [[ -n "${PGDATABASE:-}" ]]; then
  target_db="$PGDATABASE"
else
  echo "✗ neither DATABASE_URL nor PGDATABASE is set" >&2
  exit 2
fi

echo "WILL DROP every object in the database: $target_db"
read -r -p "Type the database name back to proceed: " typed
if [[ "$typed" != "$target_db" ]]; then
  echo "✗ database name mismatch — aborting" >&2
  exit 2
fi

echo "→ dropping public schema (cascades to every table / type / fn)"
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
else
  psql -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
fi

echo "→ restoring from $dump"
gunzip -c "$dump" | (
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql --single-transaction --set ON_ERROR_STOP=on "$DATABASE_URL"
  else
    psql --single-transaction --set ON_ERROR_STOP=on
  fi
)

echo "✓ restore complete from $dump"

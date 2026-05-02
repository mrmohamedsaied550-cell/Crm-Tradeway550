# scripts

Operator helpers — not run by the application.

## P3-07 — backup / restore

Two complementary paths:

| Path                              | When to use                                                                                                                                                                                            | Output                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `scripts/backup.sh`               | Ad-hoc full DB snapshot before a risky migration / merge. Routine production backups should rely on the managed Postgres provider's built-in snapshot facility (Railway, RDS, Neon all do daily PITR). | `backups/crm-tradeway-<utc-iso>.sql.gz`           |
| `GET /api/v1/admin/backup/export` | Per-tenant JSON dump for offboarding or DSAR. Sensitive fields (access tokens, password hashes) are stripped at the service boundary.                                                                  | JSON download from the admin UI (`/admin/backup`) |

### `scripts/backup.sh`

Wraps `pg_dump`. Reads `DATABASE_URL` when set, falls back to the
`PG*` env vars otherwise. Writes a gzipped plain-format dump.

```sh
DATABASE_URL=postgres://user:pwd@host:5432/crm scripts/backup.sh
# → backups/crm-tradeway-2026-05-02T11-30-00Z.sql.gz
```

### `scripts/restore.sh`

DESTRUCTIVE. Drops the `public` schema and replays the dump inside a
single transaction. Two confirmation gates protect against typos:

1. `RESTORE_CONFIRM=I_UNDERSTAND` must be in the environment, AND
2. you must type the target database name back at the prompt.

```sh
RESTORE_CONFIRM=I_UNDERSTAND scripts/restore.sh \
  backups/crm-tradeway-2026-05-02T11-30-00Z.sql.gz
```

After a restore, run `pnpm db:seed` if the dump predates new
capability / role rows, since the seed is idempotent.

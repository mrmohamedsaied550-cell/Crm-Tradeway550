# Trade Way CRM — Production Runbook

Single-source-of-truth for operating the deployment on the Contabo VPS
`161.97.116.153`. Everything runs in Docker on the host.

## At a glance

| Item | Value |
|---|---|
| Public URL (HTTP, IP-only) | http://161.97.116.153:8080 |
| Login (super admin) | `super@tradeway.com` / see `/root/.crm_credentials` on the server |
| Tenant code (required by the login form) | `trade_way_default` |
| Repo on disk | `/opt/Crm-Tradeway550` |
| Docker network | `crm-prod_crm-net` |
| Compose project | `crm-prod` |
| Compose file | `/opt/Crm-Tradeway550/deploy/docker-compose.prod.yml` |
| Env file (secrets) | `/opt/Crm-Tradeway550/.env.prod` (chmod 600) |
| Postgres data volume | `crm-prod_pgdata` |
| Redis data volume | `crm-prod_redisdata` |

The CRM listens on TCP **8080** only. cPanel/WHM/Apache/Postgres/etc.
already on the host (ports 80/443/2082/.../5432) are **not touched**.

## Architecture (5 containers)

```
                     ┌──────────────────────────────────┐
internet 8080 ─────► │ crm-prod-nginx (nginx:1.27)      │
                     │   /api/* + /health → api:3000    │
                     │   everything else → web:3001     │
                     └──────────┬───────────────────────┘
                                │ docker network crm-prod_crm-net
                  ┌─────────────┴─────────────┐
                  ▼                           ▼
        ┌──────────────────┐         ┌────────────────────┐
        │ crm-prod-api     │         │ crm-prod-web       │
        │ NestJS :3000     │         │ Next.js 14 :3001   │
        │ image crm-prod/  │         │ image crm-prod/    │
        │ api:latest       │         │ web:latest         │
        └────┬───────┬─────┘         └────────────────────┘
             │       │
             ▼       ▼
    ┌────────────┐ ┌────────────┐
    │ crm-prod-  │ │ crm-prod-  │
    │ db         │ │ redis      │
    │ postgres16 │ │ redis7     │
    │ vol pgdata │ │ vol redis  │
    └────────────┘ └────────────┘
```

Internal-only ports: db `5432`, redis `6379`, api `3000`, web `3001`.
None of those are exposed on the host — only nginx publishes `8080`.

## Daily operations

All commands assume you are SSH'd in as root:

```bash
ssh root@161.97.116.153
cd /opt/Crm-Tradeway550
```

### Status & logs
```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml ps
docker logs -f crm-prod-api
docker logs -f crm-prod-web
docker logs -f crm-prod-nginx
docker logs -f crm-prod-db
docker logs -f crm-prod-redis
```

### Restart a single service
```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml restart api
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml restart web
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml restart nginx
```

### Restart everything
```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml down
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml up -d
```

### Health checks
```bash
curl http://127.0.0.1:8080/health
# → {"status":"ok","db":"ok","redis":"n/a","version":"0.0.0"}
```

## Update / redeploy from latest source

```bash
cd /opt/Crm-Tradeway550

# 1. Pull latest from main (after you push your changes to GitHub)
git fetch origin
git checkout main
git reset --hard origin/main

# 2. Rebuild images (this regenerates Prisma client and runs next build)
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml build api web

# 3. Apply any new database migrations BEFORE restarting api
DBPW=$(grep ^POSTGRES_PASSWORD= .env.prod | cut -d= -f2-)
docker run --rm \
  -v /opt/Crm-Tradeway550/apps/api:/app -w /app \
  --network crm-prod_crm-net \
  -e DATABASE_URL="postgresql://crm_user:$DBPW@db:5432/crm_tradeway?schema=public" \
  node:20-bookworm-slim sh -c \
    "apt-get update -qq >/dev/null && apt-get install -y -qq openssl >/dev/null && \
     npx -y prisma@5.22.0 migrate deploy --schema=prisma/schema.prisma"

# 4. Recreate api + web with the new images
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml up -d --force-recreate api web

# 5. Verify
curl -s http://127.0.0.1:8080/health
docker logs --tail 20 crm-prod-api
docker logs --tail 20 crm-prod-web
```

If the rebuild fails, the old containers keep running because Docker only
swaps them in after a successful build.

## Backups

### Manual Postgres dump
```bash
docker exec crm-prod-db pg_dump -U crm_user -d crm_tradeway --no-owner --no-privileges \
  | gzip > /root/crm-backup-$(date +%F-%H%M).sql.gz
ls -lh /root/crm-backup-*.sql.gz
```

### Restore (DESTROYS current data)
```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml stop api web
gunzip -c /root/crm-backup-YYYY-MM-DD-HHMM.sql.gz \
  | docker exec -i crm-prod-db psql -U crm_user -d crm_tradeway
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml start api web
```

### Suggested cron (daily 02:00, keep 14 days)
Add via `crontab -e`:
```
0 2 * * * docker exec crm-prod-db pg_dump -U crm_user -d crm_tradeway --no-owner --no-privileges | gzip > /root/backups/crm-$(date +\%F).sql.gz && find /root/backups -name "crm-*.sql.gz" -mtime +14 -delete
```
Then `mkdir -p /root/backups`.

## Connecting your domain later

When you have a (sub)domain pointing an `A` record to `161.97.116.153`:

1. Decide whether to keep CRM on port 8080 (zero-touch) or move it to the
   standard 80/443 (requires giving up port 80/443 on cPanel — usually no).

2. **Recommended: keep CRM on 8080, do TLS on a *different* port (e.g. 8443).**
   Add to `deploy/nginx/crm.conf` a second server block listening on 443
   inside the container, mount certs from certbot, and publish 8443:443.
   Or simply add a Cloudflare proxy in front (Cloudflare can serve TLS on
   :443 and forward to your origin on :8080 over plain HTTP). This is the
   easiest path and is what we recommend.

3. **Alternative: front the CRM with the existing Apache/cPanel.**
   Inside cPanel/WHM, create a subdomain (e.g. `crm.yourdomain.com`) and
   add a "Reverse Proxy" / `mod_proxy` rule to forward to
   `http://127.0.0.1:8080/`. Then issue an AutoSSL/Let's Encrypt cert for
   the subdomain via WHM. The CRM keeps using port 8080 internally.

4. After the domain works, update CORS so the API only accepts the new
   origin (defence-in-depth):

   ```bash
   sed -i 's|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=https://crm.yourdomain.com|' /opt/Crm-Tradeway550/.env.prod
   docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml restart api
   ```

   The web app figures out the correct API base URL automatically from
   `window.location.origin`, so you do **not** need to rebuild the web
   image when the domain changes.

## Secrets reference

`/opt/Crm-Tradeway550/.env.prod` (chmod 600) contains:

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | DB user `crm_user` password (internal only) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Auth tokens (rotate ⇒ all sessions invalidated) |
| `SEED_DEFAULT_PASSWORD` | Password baked into seeded users (already applied; change later) |
| `CORS_ALLOWED_ORIGINS` | Whitelist for browser → API |
| `WHATSAPP_ENCRYPTION_KEY` | At-rest key for stored Meta tokens |

A copy of `SEED_DEFAULT_PASSWORD` is also kept in `/root/.crm_credentials`
for convenience — delete that file once you've memorised / vaulted it.

## Source-code fixes applied during deployment

Two changes were required to make the codebase build & run cleanly in
production. They are **already in `/opt/Crm-Tradeway550`** but are not yet
on GitHub. Push them yourself when ready:

1. **`apps/api/src/whatsapp/whatsapp.module.ts`** — replaced the direct
   `providers: [MetaCloudProvider]` registration with a `useFactory:
   () => new MetaCloudProvider()`. NestJS DI cannot introspect the
   default-valued `FetchFn` constructor parameter, which crashed bootstrap
   in production.

2. **`apps/web/lib/api-base.ts`** — re-exported as `getApiBaseUrl()` that
   resolves at request time and falls back to `window.location.origin` in
   the browser. Lets the SPA work behind any public origin (IP, domain,
   reverse proxy) without a rebuild.

3. **`apps/web/lib/api.ts`** — added missing client wrappers used by admin
   pages (audit, notifications, bonuses, bonus accruals, competitions,
   reports, follow-ups) plus `leadsApi.importCsv`, `leadsApi.dueToday`,
   `leadsApi.overdue`, `conversationsApi.handover`,
   `conversationsApi.linkLead`. The endpoints already exist server-side;
   they were simply not wired into the web client. `next build` rejected
   the missing imports, dev mode tolerated them.

4. **`deploy/`** directory (new) — Dockerfiles, compose, Nginx config,
   env example, runbook, helper scripts.

5. **`.dockerignore`** (new) — keeps build context small.

A single squash commit covering these is sufficient. None of them changes
application behaviour; they only unblock the production build.

## Troubleshooting

**Web returns 502 / "Bad Gateway":** web container is restarting. Check
`docker logs crm-prod-web`. Most common cause is an unmet `NEXT_PUBLIC_*`
env at build time — but our build uses runtime resolution, so this is
unlikely after a fresh build. Restart with
`docker compose ... restart web`.

**API logs `"The table public.tenants does not exist"`:** migrations have
not been applied. Re-run the migration step in the Update section above.

**API logs `"@prisma/client did not initialize"`:** Prisma client wasn't
materialised in the deployed tree. Rebuild with `--no-cache`:
```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml build --no-cache api
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml up -d --force-recreate api
```

**SLA scheduler floods logs with errors after a fresh DB:** harmless until
migrations + seed have run. Goes away by itself.

**Disk usage growing:** `docker system prune -af --volumes` removes
unused images/layers, but **never** prune `pgdata`/`redisdata` volumes.

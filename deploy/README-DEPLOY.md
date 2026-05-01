# Trade Way CRM — Production Deployment Runbook

This document covers the canonical way to run the CRM permanently on a single
Linux VPS using Docker Compose. The same files work on any host with
Docker ≥ 24 and the Compose plugin ≥ 2.20.

The current production target is **`161.97.116.153`** (a Contabo VPS)
listening on **port 8080** to avoid colliding with the cPanel/Apache stack
already on ports 80/443.

---

## 1. Architecture

```
                 ┌──────────────────────────── Docker network: crm-net ────────────────────────────┐
host:8080  ──►   nginx (alpine)  ──►   web  (Next.js 14, port 3001)                                │
                                  └─►  api  (NestJS 10,  port 3000)  ──►  db   (Postgres 16)        │
                                                                      └─►  redis (Redis 7, AOF on)  │
                 └──────────────────────────────────────────────────────────────────────────────────┘
```

- Only **nginx** is exposed on the host (port `${PUBLIC_HTTP_PORT:-8080}`).
- Postgres and Redis are reachable **only inside the network** — no public
  ports, so no internet exposure.
- All persistent data lives in two named volumes: `crm_pgdata`, `crm_redisdata`.
- Web → API traffic is **same-origin** (`/api/v1/*`), so CORS preflights are
  the no-op kind and `NEXT_PUBLIC_API_BASE_URL` can stay empty in the image.

## 2. First-time deploy

```bash
# On the VPS, as root (or any user in the docker group):
cd /opt
git clone https://github.com/mrmohamedsaied550-cell/Crm-Tradeway550.git
cd Crm-Tradeway550

# 1) Generate strong random secrets and write .env.prod (in repo root).
bash deploy/generate-env.sh "http://161.97.116.153:8080"

# 2) Build images and start the stack.
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml up -d --build

# 3) Apply Prisma migrations + seed the database (one-time on a fresh volume).
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
  exec api sh -lc 'npx prisma migrate deploy && npx prisma db seed'

# 4) Smoke-test from the same host.
curl -fsS http://localhost:8080/health
curl -fsS -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"super@tradeway.com\",\"password\":\"$(grep ^SEED_DEFAULT_PASSWORD .env.prod | cut -d= -f2)\",\"tenantCode\":\"trade_way_default\"}"
```

The site is then reachable at **http://<vps-ip>:8080/**.

## 3. Default users (created by the seed script)

All seeded users share the same password = `SEED_DEFAULT_PASSWORD` from
`.env.prod`. The login form requires the **tenant code** `trade_way_default`.

| Email                              | Role                       |
| ---------------------------------- | -------------------------- |
| `super@tradeway.com`               | super_admin                |
| `ops@tradeway.com`                 | ops_manager                |
| `eg.manager@tradeway.com`          | account_manager (Egypt)    |
| `eg.uber.tl.sales@tradeway.com`    | tl_sales                   |
| `eg.uber.sales1@tradeway.com`      | sales_agent                |
| `eg.uber.activation1@tradeway.com` | activation_agent           |
| `sa.uber.sales1@tradeway.com`      | sales_agent (Saudi Arabia) |

Change `super@tradeway.com`'s password from the UI on first login.

## 4. Day-2 operations

```bash
cd /opt/Crm-Tradeway550

# Look at logs (tail follows):
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml logs -f api
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml logs -f web
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml logs -f nginx

# Restart a single service:
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml restart api

# Stop / start the whole stack (data persists):
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml down
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml up -d

# Wipe the database completely (DESTRUCTIVE — re-runs seed on next up):
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml down -v
```

## 5. Updating to the latest commit on `main`

```bash
cd /opt/Crm-Tradeway550
git pull --rebase
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
  up -d --build api web
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
  exec api sh -lc 'npx prisma migrate deploy'
```

`db` and `redis` are not rebuilt unless their image tags change.

## 6. Backups

```bash
# Postgres logical backup → /opt/backups/crm-YYYY-MM-DD.sql.gz
mkdir -p /opt/backups
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
  exec -T db pg_dump -U "$(grep ^POSTGRES_USER .env.prod | cut -d= -f2)" \
                     "$(grep ^POSTGRES_DB   .env.prod | cut -d= -f2)" \
  | gzip > "/opt/backups/crm-$(date +%F).sql.gz"
```

A cron entry (e.g. daily at 03:00):

```cron
0 3 * * * cd /opt/Crm-Tradeway550 && bash -lc 'mkdir -p /opt/backups && docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml exec -T db pg_dump -U $(grep ^POSTGRES_USER .env.prod | cut -d= -f2) $(grep ^POSTGRES_DB .env.prod | cut -d= -f2) | gzip > /opt/backups/crm-$(date +\%F).sql.gz'
```

Restore:

```bash
gunzip -c /opt/backups/crm-2026-05-01.sql.gz \
  | docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
      exec -T db psql -U "$(grep ^POSTGRES_USER .env.prod | cut -d= -f2)" \
                       "$(grep ^POSTGRES_DB   .env.prod | cut -d= -f2)"
```

## 7. Adding a domain + HTTPS later

Once you have a real domain (e.g. `crm.example.com`) pointing at the VPS:

1. Update `.env.prod`:
   ```
   PUBLIC_BASE_URL=https://crm.example.com
   CORS_ALLOWED_ORIGINS=https://crm.example.com
   ```
2. Issue a Let's Encrypt cert (the cPanel-hosted Apache currently owns
   :80/:443, so use `certbot --standalone` on a temporarily freed port or
   use cPanel's AutoSSL pointed at the same name and proxy-pass to
   localhost:8080). Recommended: switch the host port to `:443` with
   `PUBLIC_HTTP_PORT=8443`, then use the cPanel-side Apache as a TLS
   terminator that proxies to `127.0.0.1:8443`.
3. Restart the API + web containers so they pick up the new env vars:
   ```bash
   docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml \
     up -d api web
   ```

## 8. Emergency: kill the public exposure

```bash
docker compose --env-file .env.prod -f deploy/docker-compose.prod.yml stop nginx
```

(API + DB keep running internally, just unreachable from the internet.)

## 9. File map

| Path                             | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `deploy/Dockerfile.api`          | Multi-stage image for the NestJS API              |
| `deploy/Dockerfile.web`          | Multi-stage image for the Next.js web app         |
| `deploy/docker-compose.prod.yml` | The full prod stack                               |
| `deploy/nginx/nginx.conf`        | Top-level nginx config (websocket map etc.)       |
| `deploy/nginx/crm.conf`          | The CRM virtual host                              |
| `deploy/.env.prod.example`       | Documented env template                           |
| `deploy/generate-env.sh`         | Generates a fresh `.env.prod` with strong secrets |
| `.env.prod`                      | (Generated; not committed) Holds real secrets     |
| `.dockerignore`                  | Keeps build context small + secret-free           |

#!/usr/bin/env python3
"""Patch Dockerfile.web and docker-compose.prod.yml so NEXT_PUBLIC_API_BASE_URL
is threaded as a Docker build arg and baked into the Next.js bundle.

Idempotent: running twice is a no-op.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent  # /opt/Crm-Tradeway550/deploy

# 1) Dockerfile.web ---------------------------------------------------------
df = ROOT / "Dockerfile.web"
src = df.read_text()
needle = "ENV NEXT_TELEMETRY_DISABLED=1\nRUN pnpm --filter @crm/web build"
replacement = (
    'ARG NEXT_PUBLIC_API_BASE_URL=""\n'
    'ARG NEXT_PUBLIC_APP_URL=""\n'
    'ARG NEXT_PUBLIC_DEFAULT_LOCALE="ar"\n'
    "ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \\\n"
    "    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \\\n"
    "    NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE \\\n"
    "    NEXT_TELEMETRY_DISABLED=1\n"
    "RUN pnpm --filter @crm/web build"
)
if "ARG NEXT_PUBLIC_API_BASE_URL" in src:
    print("Dockerfile.web: already patched")
else:
    if needle not in src:
        print("Dockerfile.web: needle NOT FOUND, aborting", file=sys.stderr)
        sys.exit(1)
    df.write_text(src.replace(needle, replacement))
    print("Dockerfile.web: patched")

# 2) docker-compose.prod.yml ------------------------------------------------
cf = ROOT / "docker-compose.prod.yml"
csrc = cf.read_text()
old = "  web:\n    build:\n      context: ..\n      dockerfile: deploy/Dockerfile.web"
new = (
    "  web:\n"
    "    build:\n"
    "      context: ..\n"
    "      dockerfile: deploy/Dockerfile.web\n"
    "      args:\n"
    "        NEXT_PUBLIC_API_BASE_URL: ${PUBLIC_BASE_URL}\n"
    "        NEXT_PUBLIC_APP_URL: ${PUBLIC_BASE_URL}\n"
    "        NEXT_PUBLIC_DEFAULT_LOCALE: ${PUBLIC_DEFAULT_LOCALE:-ar}"
)
if "args:\n        NEXT_PUBLIC_API_BASE_URL" in csrc:
    print("docker-compose.prod.yml: already patched")
else:
    if old not in csrc:
        print("docker-compose.prod.yml: needle NOT FOUND, aborting", file=sys.stderr)
        sys.exit(1)
    csrc = csrc.replace(old, new)
    # Also flip the empty runtime env value to the public URL, so dev tools see consistent value.
    csrc = csrc.replace(
        'NEXT_PUBLIC_API_BASE_URL: ""',
        'NEXT_PUBLIC_API_BASE_URL: ${PUBLIC_BASE_URL}',
    )
    cf.write_text(csrc)
    print("docker-compose.prod.yml: patched")

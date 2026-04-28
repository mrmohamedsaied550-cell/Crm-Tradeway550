#!/usr/bin/env bash
#
# gitleaks.sh — portable wrapper used by .husky/pre-commit and CI.
#
# Resolution order (first found wins):
#   1. gitleaks binary on PATH
#   2. docker image zricethezav/gitleaks:latest
#   3. fail with an actionable message
#
# Usage examples:
#   bash scripts/gitleaks.sh detect --no-banner --redact -v
#   bash scripts/gitleaks.sh protect --staged --no-banner --redact -v

set -e

GITLEAKS_IMAGE="zricethezav/gitleaks:latest"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "$@"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  exec docker run --rm \
    -v "${PWD}:/repo" \
    -w /repo \
    "${GITLEAKS_IMAGE}" "$@"
fi

cat <<'EOF' >&2
[gitleaks] Neither the 'gitleaks' binary nor a running Docker daemon was found.
           Install one of:
             - gitleaks binary:  https://github.com/gitleaks/gitleaks#installation
             - Docker Desktop:   https://docs.docker.com/get-docker/
           CI uses the official action and is unaffected.
EOF
exit 127

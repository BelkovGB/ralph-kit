#!/bin/sh
set -eu

# The isolated runner starts its own ephemeral PostgreSQL instance. The existing
# db:ready script is retained as a healthcheck contract, but must never receive
# access to the host Docker daemon or its credentials.
if [ "$*" = 'compose up -d --wait --wait-timeout 120 postgres' ]; then
  exit 0
fi

echo "Docker access is disabled in Ralph validation containers." >&2
exit 126

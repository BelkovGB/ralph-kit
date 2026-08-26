#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "At least one npm script is required." >&2
  exit 64
fi

cp -R /source/. /workspace/
cd /workspace
git init --quiet
git config user.name "Ralph Validation"
git config user.email "ralph-validation@invalid"
git add --all
git commit --quiet --message "validation snapshot"

cp -R /opt/ralph-dependencies/node_modules /workspace/
cp /workspace/.env.example /workspace/.env

export PGDATA=/tmp/postgres
export PGHOST=127.0.0.1
export PGLOG=/tmp/postgres.log
initdb --auth-local=trust --auth-host=trust --pgdata="$PGDATA" >/dev/null
if ! pg_ctl \
  --pgdata="$PGDATA" \
  --log="$PGLOG" \
  --options="-c listen_addresses=$PGHOST -c unix_socket_directories=/tmp" \
  --wait start >/dev/null; then
  cat "$PGLOG" >&2
  exit 1
fi
trap 'pg_ctl --pgdata="$PGDATA" --wait stop >/dev/null 2>&1 || true' EXIT
psql --dbname=postgres --command 'CREATE ROLE video_meetings LOGIN;' >/dev/null
psql --dbname=postgres --command 'CREATE DATABASE video_meetings OWNER video_meetings;' >/dev/null

# One container now runs the whole set. The marker lets the orchestrator name the
# script that failed without parsing npm output; `set -e` stops at the first
# failure, so the last marker printed is the failing script.
for script in "$@"; do
  echo "RALPH_VALIDATION_SCRIPT=$script"
  if [ "$script" = "test:e2e:web" ]; then
    CI=1 npm run "$script"
  else
    npm run "$script"
  fi
done

#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "At least one command is required." >&2
  exit 64
fi

cp -R /source/. /workspace/
cd /workspace
git init --quiet
git config user.name "Ralph Validation"
git config user.email "ralph-validation@invalid"
git add --all
git commit --quiet --message "validation snapshot"

# One container runs the whole set. Each argument is a shell command executed as
# given from the repository root. The marker lets the orchestrator name the
# command that failed without parsing its output; `set -e` stops at the first
# failure, so the last marker printed names the failing command.
for validation_command in "$@"; do
  echo "RALPH_VALIDATION_SCRIPT=$validation_command"
  sh -c "$validation_command"
done

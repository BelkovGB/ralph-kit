#!/bin/sh
set -eu

# The shim shadows `docker` on PATH inside the validation container. A command
# that reaches for the daemon fails loudly instead of silently using the host
# socket or the host credential helpers.
echo "Docker access is disabled in Ralph validation containers." >&2
exit 126

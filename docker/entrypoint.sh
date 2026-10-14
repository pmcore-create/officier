#!/bin/sh
# Regenerate font lists before DocService starts (only when custom fonts changed), then hand over to
# the upstream start script, which stays PID 1 and saves open documents on SIGTERM.
set -e
/usr/local/bin/officier-fonts ensure
exec /app/ds/run-document-server.sh "$@"

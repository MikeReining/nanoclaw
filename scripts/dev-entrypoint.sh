#!/bin/sh
# Dev-only: ensure node_modules in the named volume has all deps (e.g. marked)
# before starting the app. Fixes ERR_MODULE_NOT_FOUND when volume was created
# before a dependency was added.
if ! test -d /app/node_modules/marked; then
  echo "[dev-entrypoint] node_modules incomplete (e.g. missing marked), running npm ci..."
  npm ci
fi
exec "$@"

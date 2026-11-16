#!/bin/sh
set -eu

case "${1:-}" in
  ""|-*)
    # The first --config wins, so keep the fallback after user arguments.
    set -- node dist/index.js "$@" --config=/config/config.yaml
    ;;
esac

exec "$@"

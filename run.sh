#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [ ! -x node_modules/electron/dist/electron ]; then
  printf '%s\n' "Beehive is not installed yet. Run ./install.sh first."
  exit 1
fi
exec env NODE_OPTIONS="--max-old-space-size=8192" npm start -- "$@"

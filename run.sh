#!/usr/bin/env bash
# Run the harness:  ./run.sh "Build a ..."   (see ./run.sh --help)
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
exec npx tsx src/cli.ts "$@"

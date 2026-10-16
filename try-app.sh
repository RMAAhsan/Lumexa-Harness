#!/usr/bin/env bash
# Set up, test and run an app the harness generated.
#
#   ./try-app.sh                      latest run
#   ./try-app.sh kite-v4              latest run whose name contains "kite-v4"
#   ./try-app.sh runs/<id>            a specific run folder (or its app/ folder)
#
#   --test-only   install, database, tests and build; don't start the app
#   --stop        stop this app's database container and exit
#
# Steps: npm install -> server/.env -> PostgreSQL in Docker (port 5433) +
# migrations + seed -> API tests -> build -> start on :3001 + health check.
# Ctrl+C stops the app; the database keeps running (use --stop).
set -euo pipefail
cd "$(dirname "$0")"

target="" mode="run"
for arg in "$@"; do
  case "$arg" in
    --test-only) mode="test" ;;
    --stop) mode="stop" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) target="$arg" ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { red "error: $*"; exit 1; }

# --- find the app -----------------------------------------------------------
if [ -z "$target" ]; then
  run_dir=$(ls -1d runs/*/ 2>/dev/null | while read -r d; do [ -d "$d/app" ] && echo "$d"; done | sort | tail -1)
elif [ -d "$target/server" ]; then
  run_dir=$(dirname "$target")
elif [ -d "$target/app" ]; then
  run_dir=$target
else
  run_dir=$(ls -1d runs/*"$target"*/ 2>/dev/null | while read -r d; do [ -d "$d/app" ] && echo "$d"; done | sort | tail -1)
fi
[ -n "${run_dir:-}" ] && [ -d "$run_dir/app/server" ] || die "no generated app found${target:+ for \"$target\"} (looked in runs/*/app)"
run_dir=$(cd "$run_dir" && pwd)
app="$run_dir/app"
# One Docker project per run, so two runs never share a database volume.
export COMPOSE_PROJECT_NAME
COMPOSE_PROJECT_NAME=$(basename "$run_dir" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_\n-' '-')
echo "app: $app"

if [ "$mode" = "stop" ]; then
  (cd "$app" && docker compose down)
  green "database stopped"
  exit 0
fi

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if port_busy 5433 && ! (cd "$app" && docker compose ps --status running -q db 2>/dev/null | grep -q .); then
  die "port 5433 is taken by something else (another run's database? stop it with ./try-app.sh <that-run> --stop)"
fi
if [ "$mode" = "run" ] && port_busy 3001; then
  die "port 3001 is in use (another app running? e.g. pkill -f 'node server/src/index.js')"
fi

cd "$app"

# --- install + env ------------------------------------------------------------
step "install"
if [ -d node_modules ]; then echo "node_modules present, skipping"; else npm install --no-audit --no-fund; fi
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=\"$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')\"/" server/.env
  echo "created server/.env (random JWT_SECRET)"
fi

# --- database ---------------------------------------------------------------
step "database: PostgreSQL in Docker, migrations, seed"
npm run setup

# --- tests + build ----------------------------------------------------------
results=()
step "API tests"
if npm test; then results+=("tests  ✓"); else results+=("tests  ✗"); fi

step "build"
if npm run build; then results+=("build  ✓"); else results+=("build  ✗"); fi

if [ "$mode" = "test" ]; then
  step "summary"
  printf '%s\n' "${results[@]}"
  [[ "${results[*]}" != *✗* ]] && green "all passed" || { red "something failed (see above)"; exit 1; }
  exit 0
fi

# --- start --------------------------------------------------------------------
step "start"
NODE_ENV=production node server/src/index.js &
server_pid=$!
trap 'kill $server_pid 2>/dev/null; echo; echo "app stopped (database still running: ./try-app.sh $(basename "$run_dir") --stop)"' EXIT INT TERM

health="✗"
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:3001/api/health >/dev/null 2>&1; then health="✓"; break; fi
  kill -0 $server_pid 2>/dev/null || break
  sleep 1
done
results+=("health $health")
home=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ || true)
[ "$home" = "200" ] && results+=("home   ✓") || results+=("home   ✗ (HTTP $home)")

step "summary"
printf '%s\n' "${results[@]}"
if [ -f "$run_dir/plan.json" ]; then
  node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (p.demoAccounts?.length) {
      console.log("\ndemo logins:");
      for (const a of p.demoAccounts) console.log(`  ${a.role.padEnd(10)} ${a.email}  /  ${a.password}`);
    }' "$run_dir/plan.json"
fi
[ "$health" = "✓" ] || { red "the app did not come up; see the output above"; exit 1; }
green "
open http://localhost:3001   (Ctrl+C to stop)"
wait $server_pid

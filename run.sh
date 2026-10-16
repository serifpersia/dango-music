#!/bin/sh
set -e
cd "$(dirname "$0")"

MODE="${1:-}"

if [ -z "$MODE" ]; then
  printf '\n  Dango Music\n\n  1) Development   hot reload\n  2) Production    pre-built\n\n'
  printf 'Enter your choice (1 or 2): '
  read -r MODE
  printf '\n'
fi

case "$MODE" in
  1 | dev | DEV) MODE="dev" ;;
  2 | prod | PROD) MODE="prod" ;;
  *)
    echo "Invalid choice. Try: ./run.sh, ./run.sh dev, or ./run.sh prod."
    exit 1
    ;;
esac

if [ "$MODE" = "prod" ]; then
  echo "--> Installing dependencies..."
  pnpm install --silent
fi

echo "--> $MODE mode. Ctrl+R toggles the overlay, Ctrl+Shift+Q quits."
exec node start.js "$MODE" "$2" "$3"
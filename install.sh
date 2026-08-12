#!/usr/bin/env bash
# Build + installation du service utilisateur systemd.
# Usage : ./install.sh [port]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-3200}"
NODE_BIN="$(command -v node)"
UNIT="$HOME/.config/systemd/user/openclaw-monitor.service"

cd "$APP_DIR"

echo "→ dépendances (typescript est nécessaire au build)"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

echo "→ build"
NODE_OPTIONS="--max-old-space-size=1200" npx next build

echo "→ bundle standalone"
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public || true

echo "→ unité systemd : $UNIT"
mkdir -p "$(dirname "$UNIT")"
sed -e "s#__APP_DIR__#$APP_DIR#g" \
    -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#Environment=PORT=3200#Environment=PORT=$PORT#" \
    openclaw-monitor.service.example > "$UNIT"

systemctl --user daemon-reload
systemctl --user enable --now openclaw-monitor.service
sleep 3
systemctl --user --no-pager status openclaw-monitor.service | head -12

echo
echo "✓ http://127.0.0.1:$PORT"

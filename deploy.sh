#!/usr/bin/env bash
set -euo pipefail

# TimeTrials Server — VPS Auto-Install & Update Script
# Usage:
#   ./deploy.sh                  # Install or update using existing .env (default PORT=8080)
#   PORT=9000 ./deploy.sh        # Override/replace PORT in .env and redeploy

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="timetrials-server"
ENV_FILE="$APP_DIR/.env"
DEFAULT_PORT="8080"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

echo "==> [1/6] Checking Node.js (22+ required)..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 22 ]; then
  echo "Installing Node.js 22.x..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
echo "Using Node $(node -v) / npm $(npm -v)"

echo "==> [2/6] Syncing latest code & removing old files..."
cd "$APP_DIR"
if [ -d ".git" ]; then
  git fetch origin main
  git reset --hard origin/main
  # Remove untracked/old files while keeping .env and SQLite seed packs in data/
  git clean -fd -e .env -e data
fi
mkdir -p "$APP_DIR/data/seeds"

echo "==> [3/6] Configuring .env..."
if [ -n "${PORT:-}" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
EOF
  echo "Replaced $ENV_FILE with PORT=${PORT}"
elif [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE" 2>/dev/null || echo "PORT=${DEFAULT_PORT}" > "$ENV_FILE"
  echo "Created default $ENV_FILE (PORT=${DEFAULT_PORT})"
else
  echo "Keeping existing $ENV_FILE"
fi

ACTIVE_PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
ACTIVE_PORT="${ACTIVE_PORT:-$DEFAULT_PORT}"

echo "==> [4/6] Installing production dependencies & building seed DBs..."
rm -rf "$APP_DIR/node_modules"
npm ci --omit=dev
node "$APP_DIR/seeds/build-all.js" "$APP_DIR/seed-lists" "$APP_DIR/data/seeds"

echo "==> [5/6] Installing/updating systemd service ($SERVICE_NAME)..."
NODE_BIN="$(command -v node)"
RUN_USER="${SUDO_USER:-$(whoami)}"

$SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=TimeTrials WebSocket Server
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/index.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> [6/6] Restarting $SERVICE_NAME..."
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null
$SUDO systemctl restart "$SERVICE_NAME"

sleep 1
if curl -fsS "http://127.0.0.1:${ACTIVE_PORT}/health" >/dev/null 2>&1; then
  echo "SUCCESS: $SERVICE_NAME is running on port ${ACTIVE_PORT}!"
  curl -fsS "http://127.0.0.1:${ACTIVE_PORT}/health"
  echo ""
else
  echo "WARNING: Service restarted, but health check on port ${ACTIVE_PORT} did not respond yet."
  echo "Check logs with: sudo journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
fi

#!/usr/bin/env bash
# Deploy a headless Tower server to a Linux host over SSH (for example tower-1 on Tailscale).
#
#   scripts/deploy-remote.sh <ssh-host>
#
# Builds here, copies dist/, ui/dist/, cli/ and the package files to ~/tower on the host, compiles
# node-pty there for plain Node (no Electron), and runs the server as the systemd user service
# `tower`. The server listens on 127.0.0.1:4310 and, for the Mac and the phone, on the remote
# listener (port 4311), which only Tailscale peers can reach and which needs the pairing token.
set -euo pipefail
host=${1:?usage: scripts/deploy-remote.sh <ssh-host>}
cd "$(dirname "$0")/.."

npm run build
ssh "$host" mkdir -p tower
# -R keeps the relative paths (dist/, ui/dist/, cli/); --delete only inside those folders.
rsync -azR --delete dist ui/dist cli package.json package-lock.json "$host":tower/
ssh "$host" bash -s <<'EOF'
set -euo pipefail
cd ~/tower
# Reinstall only when the lock file changes; postinstall (electron-rebuild) is for the Mac app.
if ! cmp -s package-lock.json node_modules/.deployed-lock 2>/dev/null; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  npm rebuild node-pty
  cp package-lock.json node_modules/.deployed-lock
fi

# First deploy: turn on the remote listener so the Mac and the phone can pair.
mkdir -p ~/.multisession
s=~/.multisession/settings.json
[ -f "$s" ] || echo '{"remoteEnabled": true, "remotePort": 4311}' > "$s"

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tower.service <<'UNIT'
[Unit]
Description=Tower server (headless)
After=network-online.target xvfb.service

[Service]
WorkingDirectory=%h/tower
Environment=MS_PORT=4310
Environment=MS_APP_DIR=%h/.multisession
Environment=SHELL=/bin/bash
Environment=DISPLAY=:99
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node %h/tower/dist/server.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable tower >/dev/null 2>&1
systemctl --user restart tower
sleep 2
systemctl --user --no-pager --lines=8 status tower | tail -8
EOF

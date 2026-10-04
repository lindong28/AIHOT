#!/usr/bin/env bash
set -euo pipefail
# Ubuntu production host. Keep AIHOT's existing native Node/PostgreSQL services.
if ! command -v docker >/dev/null || ! sudo -n docker compose version >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y docker.io docker-compose-v2
fi
sudo -n systemctl enable --now docker
sudo -n docker compose version

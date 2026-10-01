#!/usr/bin/env bash
set -euo pipefail
# Run in an uploaded release on the production host. Does not switch the public site.
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
test -r /home/ubuntu/aihot/shared/app.env
test -r /home/ubuntu/aihot/shared/web.env
export PATH=/usr/local/bin:/usr/bin:/bin
npm ci --no-audit --no-fund
npm run build -w @aihot/web
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/migrate.ts
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/seed.ts
echo "AI Radar release prepared at $root; services and public routing have not been changed."

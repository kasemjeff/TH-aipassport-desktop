#!/bin/bash
# Rebuild and restart the headless container. Run from this directory.
set -e
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== aipass-bridge: rebuild & start ==="

if [ "$1" == "--clean" ]; then
    echo "[clean] stopping containers and resetting the browser profile..."
    docker compose down -v 2>/dev/null || true
    rm -rf chrome-data/* 2>/dev/null || true
else
    echo "stopping existing containers..."
    docker compose down 2>/dev/null || true
fi

mkdir -p chrome-data
rm -f chrome-data/Singleton* chrome-data/Default/Singleton* 2>/dev/null || true
chmod +x start-browser.sh start-vnc.sh reset.sh test.sh 2>/dev/null || true

echo "building image and launching..."
docker compose up -d --build --force-recreate

echo "waiting for services (5s)..."
sleep 5
echo "bridge status:"
curl -s http://127.0.0.1:8787/status || echo "(still starting)"

cat <<'NOTE'

=== running ===
1. Open the noVNC desktop over an SSH tunnel:
     ssh -L 6080:127.0.0.1:6080 <you>@<server>
   then browse http://127.0.0.1:6080  (set noVNC_PASSWORD in .env to require a password)
2. In the Chrome window, log in at https://de.aipass.net/chat and leave it open
3. Run ./test.sh to verify the end-to-end connection
NOTE

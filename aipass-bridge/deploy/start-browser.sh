#!/bin/bash
set -e

echo "[start-browser] waiting for Xvfb display :99..."
for i in {1..30}; do
    [ -e /tmp/.X11-unix/X99 ] && { echo "[start-browser] display ready"; break; }
    sleep 0.5
done

echo "[start-browser] waiting for the bridge on 127.0.0.1:8787..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8787/status > /dev/null 2>&1; then
        echo "[start-browser] bridge ready"; break
    fi
    sleep 0.5
done

# Clear stale singleton locks left by a previous container run.
echo "[start-browser] clearing stale locks..."
rm -f /app/chrome-data/Singleton* \
      /app/chrome-data/Default/Singleton* \
      /app/chrome-data/Default/.org.chromium.Chromium.* \
      /tmp/.org.chromium.Chromium.* \
      /tmp/Singleton* 2>/dev/null || true

if [ -x "/usr/bin/chromium" ]; then BROWSER_BIN="/usr/bin/chromium"
elif [ -x "/usr/bin/chromium-browser" ]; then BROWSER_BIN="/usr/bin/chromium-browser"
elif [ -x "/usr/bin/google-chrome-stable" ]; then BROWSER_BIN="/usr/bin/google-chrome-stable"
else BROWSER_BIN="chromium"; fi

mkdir -p /app/chrome-data/Default
PREF_FILE="/app/chrome-data/Default/Preferences"
if [ -f "$PREF_FILE" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$PREF_FILE" 2>/dev/null || true
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/g' "$PREF_FILE" 2>/dev/null || true
fi

echo "[start-browser] launching $BROWSER_BIN with the extension..."
exec "$BROWSER_BIN" \
    --no-sandbox --test-type \
    --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer \
    --no-first-run --no-default-browser-check --disable-fre \
    --password-store=basic --use-mock-keychain \
    --disable-component-update \
    --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    --disable-session-crashed-bubble --hide-crash-restore-bubble \
    --load-extension=/app/extension \
    --disable-extensions-except=/app/extension \
    --user-data-dir=/app/chrome-data \
    --window-size=1280,800 --start-maximized \
    "https://de.aipass.net/chat"

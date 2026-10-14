#!/bin/bash
set -e

# Wait for the Xvfb display.
for i in {1..30}; do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.5
done

# Password from environment or /app/.env.
VNC_PASS="${noVNC_PASSWORD:-${NOVNC_PASSWORD:-}}"
if [ -z "$VNC_PASS" ] && [ -f "/app/.env" ]; then
    VNC_PASS=$(grep -E '^(noVNC_PASSWORD|NOVNC_PASSWORD)=' /app/.env | head -n 1 | cut -d '=' -f2-)
fi
# Trim whitespace and surrounding quotes.
VNC_PASS=$(echo "$VNC_PASS" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//')

if [ -n "$VNC_PASS" ]; then
    echo "[start-vnc] password protection ENABLED"
    PASS_FILE="/tmp/.x11vnc_pass"
    printf "%s\n" "$VNC_PASS" > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    exec x11vnc -display :99 -forever -shared -rfbport 5900 -passwdfile "$PASS_FILE"
else
    # Acceptable only because compose binds noVNC to 127.0.0.1. If you expose
    # 6080 to the network, set noVNC_PASSWORD in .env first.
    echo "[start-vnc] WARNING: no noVNC_PASSWORD set — running with -nopw (safe only on 127.0.0.1)"
    exec x11vnc -display :99 -forever -nopw -shared -rfbport 5900
fi

#!/usr/bin/env sh
# Put `aipass` on your PATH. No build, no compiled dependencies.
#
# Prefers a plain symlink into a user bin dir that's already on PATH
# (~/.local/bin or ~/bin). Falls back to `npm link` if neither exists.
set -e

cd "$(dirname "$0")/.."   # repo root

if ! command -v node >/dev/null 2>&1; then
  echo "need Node (>= 18) on PATH — https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "need Node >= 18 (have $(node -v))" >&2
  exit 1
fi

SRC="$(cd aipass-bridge/bin && pwd)/aipass.mjs"
chmod +x "$SRC"

BINDIR=""
for d in "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) BINDIR="$d"; break ;; esac
done

if [ -n "$BINDIR" ]; then
  mkdir -p "$BINDIR"
  ln -sf "$SRC" "$BINDIR/aipass"
  METHOD="symlink: $BINDIR/aipass"
  UNINSTALL="rm -f $BINDIR/aipass"
elif npm link; then
  METHOD="npm link"
  UNINSTALL="npm rm -g aipass"
else
  cat >&2 <<EOF

  Could not install automatically:
   - no user bin dir on PATH (~/.local/bin or ~/bin), and
   - \`npm link\` needs write access to $(npm config get prefix 2>/dev/null)/lib/node_modules

  Pick one:
   mkdir -p ~/.local/bin && ln -sf "$SRC" ~/.local/bin/aipass
     # then add ~/.local/bin to PATH in your shell rc if it isn't already
   npm config set prefix ~/.npm-global && npm link
     # then add ~/.npm-global/bin to PATH
   sudo npm link
EOF
  exit 1
fi

cat <<EOF

  aipass is installed  ($METHOD).

  One-time browser step (Chrome loads the extension by hand):
    1. open  chrome://extensions
    2. turn on  Developer mode
    3. Load unpacked  ->  select  $(pwd)/aipass-bridge/extension
    4. open  https://de.aipass.net/chat  and leave the tab open

  Then:
    aipass           open the chat (starts the bridge for you)
    aipass status    check node / bridge / extension
    aipass --help    everything else

  Uninstall:  $UNINSTALL
EOF

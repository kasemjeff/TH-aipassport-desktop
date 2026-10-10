# Headless deployment (optional)

Run the bridge on a Linux server so it stays up without your laptop. The
**core is unchanged** — this folder only adds container plumbing that runs the
same `../bridge` and `../extension` inside a headless Chromium you can view over
noVNC. Nothing here modifies the bridge, the agent, or the extension.

```
docker container
├── Xvfb + fluxbox      a virtual display
├── x11vnc + noVNC      view/drive that display in a browser  (:6080)
├── chromium            loads ../extension, opens de.aipass.net/chat
└── node ../bridge      the OpenAI-compatible bridge           (:8787)
```

## Security first — read before exposing anything

Three services here have **no authentication**: the bridge (`:8787`), and the
noVNC desktop (`:6080`) unless you set a password. The noVNC desktop is a full
remote view of a browser **logged into your de.aipass.net account** — treat the
port like a password.

By default `docker-compose.yml` binds every port to **`127.0.0.1`**, so nothing
is reachable from the network. Keep it that way and reach the desktop over an
**SSH tunnel**:

```bash
ssh -L 6080:127.0.0.1:6080 you@your-server
# then open http://127.0.0.1:6080 in your local browser
```

Only if you have a specific reason to expose `6080` to a network: set a strong
`noVNC_PASSWORD` in `.env` **first**, change the port to `6080:6080` in
`docker-compose.yml`, and firewall it.

## Run it

```bash
cd aipass-bridge/deploy
cp .env.example .env          # optionally set noVNC_PASSWORD
./reset.sh                    # build + start (docker compose up -d --build)
```

Then:

1. Tunnel to noVNC (command above) and open `http://127.0.0.1:6080`.
2. In the Chrome window, log in at `https://de.aipass.net/chat` and leave the
   tab open. The extension is already loaded.
3. Verify end to end:

```bash
./test.sh                     # bridge status → extension connected → models → one chat
```

The bridge is now on the server's `127.0.0.1:8787`. Point any OpenAI-compatible
client at `http://127.0.0.1:8787/v1` (tunnel `8787` the same way to reach it
from your laptop), or run the agent on the server itself.

## Files

| file | what it is |
|---|---|
| `Dockerfile` | node 22 + chromium + Xvfb + x11vnc + noVNC + supervisor |
| `docker-compose.yml` | ports (localhost by default) and the `../bridge` / `../extension` mounts |
| `supervisord.conf` | starts and auto-restarts each process |
| `start-browser.sh` | launches Chromium with the extension, clears stale profile locks |
| `start-vnc.sh` | x11vnc with an optional password from `.env` |
| `reset.sh` | rebuild & restart (`--clean` also wipes the browser profile) |
| `test.sh` | end-to-end diagnostic |

## Notes

- The browser profile lives in `deploy/chrome-data/` (gitignored). Your login
  persists across restarts; `./reset.sh --clean` wipes it.
- `docker compose logs -f aipass-bridge` shows all processes; per-process logs
  are under `/var/log/` inside the container.
- This runs your account through an automated, always-on client — fine for your
  own TH-AI Passport account, but keep the server private.

## Security notes on the merge

This deployment and the multimodal (image) support both came from a community
PR. Two things were tightened before landing:

- The extension permission was scoped from `<all_urls>` down to the aipass
  origins plus `https://storage.googleapis.com/*` (the signed upload host). The
  bridge resolves remote image URLs to data URIs server-side behind an SSRF
  guard, so the extension never fetches an arbitrary URL with your cookies.
- Two reverse-engineering debug routes (`/inspect`, `/asset`) and a full-payload
  error dump were removed.

The image-upload feature itself is kept — send an `image_url` in a chat message
and it is uploaded to aipass and attached.

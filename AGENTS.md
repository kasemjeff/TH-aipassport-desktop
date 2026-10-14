# TH-aipassport harness

Desktop harness built on top of the aipass-bridge derivative: a local OpenAI-compatible
bridge to AiPASS, an MV3 Chrome extension, and CLI tools (chat, agent, doctor, setup).

- No Next.js app or build step; runtime is plain Node + the extension.
- Run tests with `npm test` (or `npm run check` for lint + tests).
- Primary code lives in `aipass-bridge/*.mjs` and `aipass-bridge/bridge/server.mjs`.
- Security invariants: bind to `127.0.0.1` by default; keep CORS and admin routes off; do not bypass authentication or scrape sessions.
- Before committing: verify `git config user.email`, run `npm test`, and list every file touched.
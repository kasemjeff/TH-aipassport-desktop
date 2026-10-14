# aipass-bridge

Node-only project: a localhost OpenAI-compatible bridge to AiPASS, a Chrome MV3 extension, and CLI tools. There is no Next.js app or build step.

- Run tests with `npm test` (or `npm run check` for lint + tests).
- Primary code lives in `aipass-bridge/*.mjs` and `aipass-bridge/bridge/server.mjs`.
- The bridge has no runtime dependencies; keep it that way unless there is a strong reason.
- Security invariants: bind to `127.0.0.1` by default; keep CORS and admin routes off; do not bypass authentication or scrape sessions.
- Before committing: `git config user.email` verified on GitHub, `npm test` green, and list every file touched.
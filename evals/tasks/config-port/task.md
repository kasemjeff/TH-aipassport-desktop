config.json should name the port the service listens on, but someone typed the value as text and it is invalid.

Fix config.json so the port is an integer between 1 and 65535. `node check.mjs` proves it; don't edit check.mjs.

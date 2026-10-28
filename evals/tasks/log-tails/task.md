Three files under `logs/` hold one day of transfer logs each; every line carries a `bytes=N` field.

Build `lastlines.json` in the project root: one JSON object mapping each log file name (for example `2026-10-23.log`) to the `bytes` value that appears on that file's last line — the number alone.

`node check.mjs` proves the work; don't edit `check.mjs`. The check runs for you after the changes are applied — do not run anything.

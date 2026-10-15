sortNames() in names.mjs puts the list in the wrong order — the comparator is backwards.

Fix names.mjs so `node check.mjs` prints PASS and exits 0. Don't touch check.mjs.

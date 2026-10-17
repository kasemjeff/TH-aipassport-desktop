fileIn in app.mjs glues strings together, so a dir ending in / yields // in the path.

Make it use path.join from the node:path module, then run node check.mjs until it passes (never edit check.mjs).

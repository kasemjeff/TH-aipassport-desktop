import { defineConfig, globalIgnores } from "eslint/config";

// This repo's runtime is plain Node + an MV3 extension. There is no longer a
// Next.js scaffold, so the lint setup stays minimal and dependency-free.
export default defineConfig([
  globalIgnores(["node_modules/**", "coverage/**"]),
]);

import { defineConfig } from "vitest/config";

// npm run test:sandbox: the suite that boots a local near-sandbox (src/core/sandbox.ts). Unlike npm test it
// has no fetch guard, a 180 s timeout, and runs its files one at a time. Its one setup file is the keychain
// guard npm test uses too: HOME and the keychain point at a throwaway dir, never the real ~/.near-credentials.
export default defineConfig({
  test: {
    include: ["test-sandbox/**/*.sandbox.test.ts"],
    setupFiles: ["test/home-guard.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

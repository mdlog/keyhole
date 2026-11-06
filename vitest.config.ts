import { defineConfig } from "vitest/config";

// npm test is offline: test/setup.ts replaces globalThis.fetch before every test, so a test that
// reaches for the network fails instead of passing on a live answer.
//
// R7: the replay reporter prints the REPLAY block (banner, the three suites, 6/6) once at the end of the run,
// just before vitest's own summary, which the `default` reporter still prints.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    testTimeout: 20_000,
    reporters: ["./test/reporters/replay-reporter.ts", "default"],
  },
});

/**
 * The keychain guard, a setup file for both suites: `npm test` loads it through test/setup.ts, and
 * `npm run test:sandbox` lists it in vitest.sandbox.config.ts. No test reaches the real keychain or the
 * real ~/.keyhole.
 *
 * HOME, KEYHOLE_HOME and KEYHOLE_CREDENTIALS_DIR point into a throwaway dir made here, so even a call
 * given an empty env (which falls back to ~/.near-credentials and ~/.keyhole) lands in it, and so do
 * child processes, which inherit HOME. If the redirect does not take (say os.homedir() stops following
 * HOME), the file fails before any test runs. The dir is removed after the file's tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterAll } from "vitest";
import { keyholeHome } from "../src/core/config.js";
import { credentialsDir } from "../src/core/credentials.js";

/** True when `path` is `dir` or below it. */
function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// The real home, read once before the override and used only for the check below. Never exported.
// userInfo() reads the passwd entry, so a HOME that is already redirected cannot hide the real one.
const realHomes = [homedir()];
try {
  realHomes.push(userInfo().homedir);
} catch {
  // no passwd entry: HOME is all there is
}

const testHome = mkdtempSync(join(tmpdir(), "keyhole-test-home-"));
process.env.HOME = testHome;
process.env.KEYHOLE_HOME = join(testHome, ".keyhole");
process.env.KEYHOLE_CREDENTIALS_DIR = join(testHome, ".near-credentials");

for (const path of [credentialsDir({}), keyholeHome({}), credentialsDir(), keyholeHome()]) {
  if (!inside(path, testHome) || realHomes.some((home) => inside(path, home))) {
    rmSync(testHome, { recursive: true, force: true });
    throw new Error(
      "test/home-guard.ts refuses to run tests: the default keychain or Keyhole home is not inside this run's " +
        "throwaway HOME, or is inside the real home (is os.tmpdir() inside the home directory?), so a test " +
        "could reach the real ~/.near-credentials or ~/.keyhole",
    );
  }
}

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

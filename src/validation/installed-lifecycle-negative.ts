/**
 * Negative installed lifecycle wrapper:
 *
 * Spawns the installed lifecycle as a child process with
 * MESH2THREEJS_LIFECYCLE_REGRESSION=1, which deliberately mislabels a required
 * semantic so a real reconstruction gate fails. The child MUST exit non-zero.
 *
 * The wrapper exits:
 *   0 when the child correctly failed (negative regression PASS)
 *   1 when the child unexpectedly certified/passed (negative regression FAIL)
 *
 * This makes the negative regression CI-protectable: `npm run ci` runs
 * `test:installed-lifecycle:negative` which must exit 0, proving the lifecycle
 * cannot silently convert a real reconstruction failure into release success.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const child = spawn(process.execPath, [resolve(import.meta.dirname, "installed-lifecycle.js")], {
  env: { ...process.env, MESH2THREEJS_LIFECYCLE_REGRESSION: "1" },
  stdio: "inherit",
});

child.on("close", (code) => {
  if (code !== 0) {
    console.log(`[negative-lifecycle] PASS: child exited ${code} (expected non-zero; reconstruction failure correctly detected)`);
    process.exit(0);
  }
  console.error(`[negative-lifecycle] FAIL: child exited 0 (expected non-zero; lifecycle certified despite a real reconstruction failure)`);
  process.exit(1);
});

child.on("error", (error) => {
  console.error(`[negative-lifecycle] FAIL: child process error: ${error.message}`);
  process.exit(1);
});
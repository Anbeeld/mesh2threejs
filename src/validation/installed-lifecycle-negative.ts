/**
 * Negative installed lifecycle wrapper:
 *
 * Spawns the installed lifecycle as a child process with
 * MESH2THREEJS_LIFECYCLE_REGRESSION=1, which deliberately mislabels a required
 * semantic so a real reconstruction gate fails. The child MUST exit non-zero AND
 * produce the exact expected failure signature (registration rejection of the
 * deliberately mislabeled assembly). Any other failure mode — a crashed broker,
 * a packaging error, an unrelated exception — also exits non-zero but WITHOUT the
 * signature, so it is reported as FAIL instead of a false PASS.
 *
 * The wrapper exits:
 *   0 when the child failed with the expected reconstruction-failure signature
 *   1 when the child certified/passed, or failed in any unexpected way
 *
 * This makes the negative regression CI-protectable: `npm run ci` runs
 * `test:installed-lifecycle:negative` which must exit 0, proving the lifecycle
 * cannot silently convert a real reconstruction failure into release success.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const EXPECTED_SIGNATURE = /registration failed:.*"status":"registration-failed".*unresolvedAssemblies.*superstructure/u;

const child = spawn(process.execPath, [resolve(import.meta.dirname, "installed-lifecycle.js")], {
  env: { ...process.env, MESH2THREEJS_LIFECYCLE_REGRESSION: "1" },
  stdio: ["inherit", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  output += chunk.toString("utf8");
});
child.stderr.on("data", (chunk: Buffer) => {
  process.stderr.write(chunk);
  output += chunk.toString("utf8");
});

child.on("close", (code) => {
  if (code !== 0 && EXPECTED_SIGNATURE.test(output)) {
    console.log(`[negative-lifecycle] PASS: child exited ${code} with the expected reconstruction-failure signature (mislabeled semantic rejected at registration)`);
    process.exit(0);
  }
  if (code === 0) {
    console.error(`[negative-lifecycle] FAIL: child exited 0 (expected non-zero; lifecycle certified despite a real reconstruction failure)`);
  } else {
    console.error(`[negative-lifecycle] FAIL: child exited ${code} but the output lacks the expected registration-failure signature (crash, packaging error, or unrelated failure — not proof the gate rejected the bad mapping)`);
  }
  process.exit(1);
});

child.on("error", (error) => {
  console.error(`[negative-lifecycle] FAIL: child process error: ${error.message}`);
  process.exit(1);
});

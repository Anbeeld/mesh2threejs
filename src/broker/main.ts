import { resolve } from "node:path";
import { startBroker } from "./server.js";

/**
 * Packaged trusted-broker launcher (closure plan §10.G1). Binds loopback only, verifies the
 * installed toolchain before serving, selects the canonical authority store outside the
 * workspace, and emits the human admin capability to THIS console only — it is never
 * written beside builder-accessible connection data.
 *
 * Usage: mesh2threejs-broker --store <dir> [--package-root <dir>] [--port N]
 */

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const storeRoot = argValue(args, "--store");
if (!storeRoot) {
  console.error("mesh2threejs-broker requires --store <directory> for the canonical authority store");
  process.exit(2);
}
const packageRoot = argValue(args, "--package-root");
const portOption = argValue(args, "--port");

const handle = await startBroker({
  storeRoot: resolve(storeRoot),
  ...(packageRoot ? { packageRoot: resolve(packageRoot) } : {}),
  ...(portOption ? { port: Number(portOption) } : {}),
});

console.log(`mesh2threejs trusted broker listening on ${handle.url}`);
console.log(`TOOLCHAIN trusted=${handle.trustedToolchain ? "true" : "false"} toolchainId=${handle.toolchainId}`);
console.log(`toolchain: ${handle.toolchainId}${handle.trustedToolchain ? "" : " (UNANCHORED development checkout; certification unavailable)"}`);
console.log(`builder connection descriptor written under the store directory (no admin capability inside).`);
console.log(`ADMIN CAPABILITY (human channel only — do not share with builder tools): ${handle.adminToken}`);
